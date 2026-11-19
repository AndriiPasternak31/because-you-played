/**
 * Embeddings: every version from the same model.
 *
 * Each response is stored as received, with the vectors in the provider's base64
 * form (little-endian 32-bit floats), beside a list of what was embedded: the game
 * and the hash of its text, in request order. A text is looked up by that pair, so
 * a rebuild without a key yields the same bytes, and when some texts change only
 * those are embedded again while every other vector stays as it was.
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

const CallSchema = z.strictObject({
  /** The hash of the request as it was sent. */
  request_sha256: z.string(),
  seconds: z.number().nonnegative(),
  usage: EmbeddingUsageSchema,
  /** What was embedded, in request order: vector `i` of the body belongs to `inputs[i]`. */
  inputs: z.array(z.strictObject({ game_id: z.string(), text_sha256: z.string() })),
  /** The response body as received. */
  body: z.unknown(),
});

const EmbeddingFileSchema = z.strictObject({
  version: z.string(),
  model: z.string(),
  dimensions: z.number().int(),
  /** Every stored call, oldest first. A later call holds the texts that had no stored embedding when it was made. */
  calls: z.array(CallSchema),
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

/** The vectors of a response body, in input order, each a block of little-endian 32-bit floats. */
function vectorsFrom(body: unknown, count: number, source: string): { vectors: Buffer[]; usage: z.infer<typeof EmbeddingUsageSchema> } {
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) throw new Error(`${source}: embedding response: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.model !== EMBEDDING_MODEL) {
    throw new Error(`${source}: the response is from model "${parsed.data.model}", expected "${EMBEDDING_MODEL}"`);
  }
  if (parsed.data.data.length !== count) throw new Error(`${source}: ${parsed.data.data.length} vectors for ${count} texts`);
  const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
  const vectors = ordered.map((entry, position) => {
    if (entry.index !== position) throw new Error(`${source}: vector indexes are not 0 to ${count - 1}`);
    const block = Buffer.from(entry.embedding, "base64");
    if (block.length !== BYTES_PER_VECTOR) {
      throw new Error(`${source}: vector ${position} has ${block.length / 4} dimensions, expected ${DIMENSIONS}`);
    }
    return block;
  });
  assertUsableVectors(Buffer.concat(vectors), count, source);
  return { vectors, usage: parsed.data.usage };
}

/** One text to embed, and the game it belongs to. */
export interface EmbeddingItem {
  game_id: string;
  text: string;
}

const keyOf = (gameId: string, textSha256: string): string => `${gameId}\u0000${textSha256}`;

export interface EmbedOptions {
  responsesDir: string;
  /** Null means replay only: a text without a stored embedding is an error. */
  live: Live | null;
  log: (line: string) => void;
}

/**
 * One vector per item, in item order, as one block. Stored vectors are reused;
 * a live run sends only the texts that have none, in one request, and stores the answer.
 */
export async function obtainEmbeddings(
  version: Version,
  items: readonly EmbeddingItem[],
  options: EmbedOptions,
): Promise<{ bytes: Buffer; file: EmbeddingFile }> {
  const path = embeddingPath(options.responsesDir, version);
  const file: EmbeddingFile = existsSync(path)
    ? readEmbeddingFile(path)
    : { version, model: EMBEDDING_MODEL, dimensions: DIMENSIONS, calls: [] };
  if (file.version !== version || file.model !== EMBEDDING_MODEL || file.dimensions !== DIMENSIONS) {
    throw new Error(
      `${path} holds "${file.version}" embeddings from ${file.model} at ${file.dimensions} dimensions, ` +
        `expected "${version}" from ${EMBEDDING_MODEL} at ${DIMENSIONS}`,
    );
  }

  const stored = new Map<string, Buffer>();
  file.calls.forEach((call, position) => {
    const { vectors } = vectorsFrom(call.body, call.inputs.length, `${path} call ${position + 1}`);
    call.inputs.forEach((input, row) => {
      const key = keyOf(input.game_id, input.text_sha256);
      // A stored text is never sent again, so two vectors for one text mean the file was edited: there is no telling which is right.
      if (stored.has(key)) throw new Error(`${path} holds two embeddings for the same text of ${input.game_id}; call ${position + 1} repeats an earlier one`);
      stored.set(key, vectors[row] as Buffer);
    });
  });

  const keyed = items.map((item) => ({ ...item, text_sha256: sha256(item.text) }));
  const missing = keyed.filter((item) => !stored.has(keyOf(item.game_id, item.text_sha256)));
  if (missing.length > 0) {
    if (options.live === null) {
      throw new Error(
        file.calls.length === 0
          ? `no stored embeddings for version "${version}" at ${path}. Re-run with --live and OPENAI_API_KEY set.`
          : `${path} holds no embedding for the current text of ${missing.length} game(s): ${missing.map((item) => item.game_id).join(", ")}. ` +
              "A record, a label or the text layout changed. Re-run with --live to embed those texts.",
      );
    }
    const { call, vectors } = await embed(version, missing.map((item) => item.text), options.live, options.log);
    file.calls.push({ ...call, inputs: missing.map(({ game_id, text_sha256 }) => ({ game_id, text_sha256 })) });
    mkdirSync(join(options.responsesDir, "embeddings"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 1)}\n`);
    missing.forEach((item, row) => stored.set(keyOf(item.game_id, item.text_sha256), vectors[row] as Buffer));
  }

  const bytes = Buffer.concat(keyed.map((item) => stored.get(keyOf(item.game_id, item.text_sha256)) as Buffer));
  assertUsableVectors(bytes, items.length, path);
  return { bytes, file };
}

/** Sends one embedding request, retrying a failure a few times. */
async function embed(
  version: Version,
  texts: readonly string[],
  live: Live,
  log: (line: string) => void,
): Promise<{ call: Omit<EmbeddingFile["calls"][number], "inputs">; vectors: Buffer[] }> {
  const request = { model: EMBEDDING_MODEL, input: texts, dimensions: DIMENSIONS, encoding_format: "base64" };
  const worstCaseUsd = (tokensAtMost(texts.join("")) * PRICES.embedding_per_million_usd.input) / 1_000_000;
  for (let apiErrors = 0; apiErrors < MAX_API_ERRORS_PER_RUN; apiErrors += 1) {
    live.budget.reserve(worstCaseUsd, `the embedding call for version "${version}"`);
    const started = performance.now();
    let response: { status: number; body: unknown } | null = null;
    let failure = "";
    try {
      response = await live.transport(ENDPOINT, live.apiKey, request);
    } catch (error) {
      failure = `transport failure: ${error instanceof Error ? error.name : "unknown"}`;
    }
    const seconds = Math.round(performance.now() - started) / 1000;
    if (response !== null && response.status >= 200 && response.status < 300) {
      const { vectors, usage } = vectorsFrom(response.body, texts.length, `the embedding response for version "${version}"`);
      live.budget.settle(worstCaseUsd, embeddingUsd(usage));
      log(`embeddings "${version}": ${texts.length} texts, ${usage.total_tokens} tokens in ${seconds.toFixed(1)}s`);
      return { call: { request_sha256: sha256(JSON.stringify(request)), seconds, usage, body: response.body }, vectors };
    }
    live.budget.settle(worstCaseUsd, 0);
    if (response !== null) {
      failure = describeHttpError(response.status, response.body);
      if (!isRetryable(response.status)) throw new Error(`the embedding call for version "${version}" failed: ${failure}`);
    }
    log(`embeddings "${version}": ${failure}, retrying`);
    await sleep(live.retryDelayMs * (apiErrors + 1));
  }
  throw new Error(`the embedding call for version "${version}" kept failing`);
}
