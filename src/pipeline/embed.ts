/**
 * Embeddings: one request per version, every version from the same model.
 *
 * The response is stored as received, with the vectors in the provider's base64
 * form (little-endian 32-bit floats), so a rebuild without a key yields the same bytes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EmbeddingUsageSchema,
  PRICES,
  describeHttpError,
  embeddingUsd,
  isRetryable,
  sleep,
  tokensAtMost,
  type Live,
} from "./costs.ts";
import { parseJsonFrom, readText, sha256 } from "./io.ts";
import type { Version } from "./versions.ts";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const DIMENSIONS = 1536;
export const BYTES_PER_VECTOR = DIMENSIONS * 4;
const ENDPOINT = "https://api.openai.com/v1/embeddings";
const MAX_API_ERRORS_PER_RUN = 3;

const AccountingSchema = z.strictObject({
  request_sha256: z.string(),
  seconds: z.number().nonnegative(),
  usage: EmbeddingUsageSchema,
});

const EmbeddingFileSchema = z.strictObject({
  version: z.string(),
  model: z.string(),
  dimensions: z.number().int(),
  ...AccountingSchema.shape,
  /** The response body as received. */
  body: z.unknown(),
  /** What earlier requests for this version cost, after their texts changed. Bodies are not kept. */
  superseded: z.array(AccountingSchema),
});
export type EmbeddingFile = z.infer<typeof EmbeddingFileSchema>;

const BodySchema = z.object({
  model: z.string(),
  data: z.array(z.object({ index: z.number().int(), embedding: z.string() })),
  usage: EmbeddingUsageSchema,
});

export function embeddingPath(responsesDir: string, version: Version): string {
  return join(responsesDir, "embeddings", `${version}.json`);
}

export function readEmbeddingFile(path: string): EmbeddingFile {
  const parsed = EmbeddingFileSchema.safeParse(parseJsonFrom(readText(path), path));
  if (!parsed.success) throw new Error(`${path} is not a valid embedding response file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Fails, naming the problem, unless every value of a block of vectors is finite and no vector is all zeros. */
export function assertUsableVectors(bytes: Buffer, count: number, what: string): void {
  if (bytes.length !== count * BYTES_PER_VECTOR) {
    throw new Error(`${what} holds ${bytes.length} bytes, expected ${count} vectors of ${DIMENSIONS} dimensions (${count * BYTES_PER_VECTOR} bytes)`);
  }
  for (let row = 0; row < count; row += 1) {
    let squares = 0;
    for (let column = 0; column < DIMENSIONS; column += 1) {
      const value = bytes.readFloatLE(row * BYTES_PER_VECTOR + column * 4);
      if (!Number.isFinite(value)) throw new Error(`${what} has a non-finite value in vector ${row}, dimension ${column}`);
      squares += value * value;
    }
    if (squares === 0) throw new Error(`${what} has an all-zero vector at ${row}, which has no direction to compare`);
  }
}

/** The vectors of a response body, in input order, as one block of little-endian 32-bit floats. */
function vectorsFrom(body: unknown, count: number, source: string): { bytes: Buffer; usage: z.infer<typeof EmbeddingUsageSchema> } {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) throw new Error(`${source}: embedding response: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.model !== EMBEDDING_MODEL) {
    throw new Error(`${source}: the response is from model "${parsed.data.model}", expected "${EMBEDDING_MODEL}"`);
  }
  if (parsed.data.data.length !== count) throw new Error(`${source}: ${parsed.data.data.length} vectors for ${count} texts`);
  const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
  const blocks = ordered.map((entry, position) => {
    if (entry.index !== position) throw new Error(`${source}: vector indexes are not 0 to ${count - 1}`);
    const block = Buffer.from(entry.embedding, "base64");
    if (block.length !== BYTES_PER_VECTOR) {
      throw new Error(`${source}: vector ${position} has ${block.length / 4} dimensions, expected ${DIMENSIONS}`);
    }
    return block;
  });
  const bytes = Buffer.concat(blocks);
  assertUsableVectors(bytes, count, source);
  return { bytes, usage: parsed.data.usage };
}

export interface EmbedOptions {
  responsesDir: string;
  /** Null means replay only: a version without a stored response for exactly these texts is an error. */
  live: Live | null;
  log: (line: string) => void;
}

export async function obtainEmbeddings(
  version: Version,
  texts: readonly string[],
  options: EmbedOptions,
): Promise<{ bytes: Buffer; file: EmbeddingFile }> {
  const request = { model: EMBEDDING_MODEL, input: texts, dimensions: DIMENSIONS, encoding_format: "base64" };
  const requestHash = sha256(JSON.stringify(request));
  const path = embeddingPath(options.responsesDir, version);

  const stored = existsSync(path) ? readEmbeddingFile(path) : null;
  if (stored !== null && stored.request_sha256 === requestHash) {
    return { bytes: vectorsFrom(stored.body, texts.length, path).bytes, file: stored };
  }
  if (options.live === null) {
    throw new Error(
      stored === null
        ? `no stored embeddings for version "${version}" at ${path}. Re-run with --live and OPENAI_API_KEY set.`
        : `${path} holds embeddings of different texts (a record, a label or the text layout changed). Re-run with --live to embed the current texts.`,
    );
  }

  const worstCaseUsd = (tokensAtMost(texts.join("")) * PRICES.embedding_per_million_usd.input) / 1_000_000;
  for (let apiErrors = 0; apiErrors < MAX_API_ERRORS_PER_RUN; apiErrors += 1) {
    options.live.budget.reserve(worstCaseUsd, `the embedding call for version "${version}"`);
    const started = performance.now();
    let response: { status: number; body: unknown } | null = null;
    let failure = "";
    try {
      response = await options.live.transport(ENDPOINT, options.live.apiKey, request);
    } catch (error) {
      failure = `transport failure: ${error instanceof Error ? error.name : "unknown"}`;
    }
    const seconds = Math.round(performance.now() - started) / 1000;
    if (response !== null && response.status >= 200 && response.status < 300) {
      const { bytes, usage } = vectorsFrom(response.body, texts.length, `the embedding response for version "${version}"`);
      options.live.budget.settle(worstCaseUsd, embeddingUsd(usage));
      const file: EmbeddingFile = {
        version,
        model: EMBEDDING_MODEL,
        dimensions: DIMENSIONS,
        request_sha256: requestHash,
        seconds,
        usage,
        body: response.body,
        superseded:
          stored === null
            ? []
            : [...stored.superseded, { request_sha256: stored.request_sha256, seconds: stored.seconds, usage: stored.usage }],
      };
      mkdirSync(join(options.responsesDir, "embeddings"), { recursive: true });
      writeFileSync(path, `${JSON.stringify(file, null, 1)}\n`);
      options.log(`embeddings "${version}": ${texts.length} texts, ${usage.total_tokens} tokens in ${seconds.toFixed(1)}s`);
      return { bytes, file };
    }
    options.live.budget.settle(worstCaseUsd, 0);
    if (response !== null) {
      failure = describeHttpError(response.status, response.body);
      if (!isRetryable(response.status)) throw new Error(`the embedding call for version "${version}" failed: ${failure}`);
    }
    options.log(`embeddings "${version}": ${failure}, retrying`);
    await sleep(options.live.retryDelayMs * (apiErrors + 1));
  }
  throw new Error(`the embedding call for version "${version}" kept failing`);
}
