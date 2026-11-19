/**
 * Model enrichment: one call per record adds theme and mechanic labels.
 *
 * The answer can hold labels and nothing else: its shape has no place for a fact
 * or an availability status, and an answer carrying any other key is rejected whole.
 * A label survives only if it is a term of its field's vocabulary and its quote is
 * found word for word in the field it names. Anything else is stripped and counted.
 * Nothing is repaired.
 *
 * Every attempt is stored beside the data, so the index can be rebuilt without a key.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MECHANICS, MECHANIC_MEANING, THEMES, THEME_MEANING } from "../dataset/vocabulary.ts";
import type { CanonicalRecord } from "./canonical.ts";
import {
  EnrichmentUsageSchema,
  describeHttpError,
  enrichmentUsd,
  isRetryable,
  sleep,
  tokensAtMost,
  PRICES,
  type Live,
} from "./costs.ts";
import { parseJsonFrom, readText, sha256 } from "./io.ts";
import { LabelSchema, SOURCE_FIELDS, type Label, type SourceField } from "./synonyms.ts";

export const ENRICHMENT_MODEL = "gpt-6.2-sol";
export const PROMPT_VERSION = "enrich-v1";
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 2000;
/** A record whose answers were all rejected this many times gets no labels from the model. */
export const MAX_ANSWERS = 2;
const MAX_API_ERRORS_PER_RUN = 3;

const PROMPT_PATH = join(import.meta.dirname, "..", "..", "prompts", `${PROMPT_VERSION}.md`);

/** The prompt file, followed by the vocabulary with the meaning of each label. */
export function instructions(): string {
  const list = <T extends string>(terms: readonly T[], meaning: Record<T, string>): string =>
    terms.map((term) => `- ${term}: ${meaning[term]}`).join("\n");
  return `${readText(PROMPT_PATH).trim()}\n\nTheme labels:\n${list(THEMES, THEME_MEANING)}\n\nMechanic labels:\n${list(MECHANICS, MECHANIC_MEANING)}\n`;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

const wireLabel = <T extends readonly [string, ...string[]]>(labels: T) =>
  z.strictObject({ label: z.enum(labels), quote: z.string(), source_field: z.enum(SOURCE_FIELDS) });

/** The shape the model is asked for. It is closed: two lists of labels and no other key. */
const WireAnswerSchema = z.strictObject({
  themes: z.array(wireLabel(THEMES)),
  mechanics: z.array(wireLabel(MECHANICS)),
});

/**
 * The shape an answer must have to be read at all. The label is any string here, so that
 * a label outside the list is stripped and counted on its own instead of sinking the answer.
 */
const ReadableAnswerSchema = z.strictObject({
  themes: z.array(z.strictObject({ label: z.string(), quote: z.string(), source_field: z.enum(SOURCE_FIELDS) })),
  mechanics: z.array(z.strictObject({ label: z.string(), quote: z.string(), source_field: z.enum(SOURCE_FIELDS) })),
});

export const STRIP_REASONS = ["label_outside_list", "invented_quote", "duplicate_label"] as const;

const StrippedSchema = z.strictObject({
  field: z.enum(["themes", "mechanics"]),
  label: z.string(),
  quote: z.string(),
  source_field: z.enum(SOURCE_FIELDS),
  reason: z.enum(STRIP_REASONS),
});
export type Stripped = z.infer<typeof StrippedSchema>;

/** What the model contributed to one record, after checking. */
export const ModelOutputSchema = z.strictObject({
  outcome: z.enum(["accepted", "no_accepted_response"]),
  themes: z.array(LabelSchema),
  mechanics: z.array(LabelSchema),
  stripped: z.array(StrippedSchema),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/** True when the quote is in the named field of the record, word for word. */
export function quoteIsVerbatim(record: CanonicalRecord, sourceField: SourceField, quote: string): boolean {
  if (quote.trim().length < 2) return false;
  switch (sourceField) {
    case "title":
      return record.title.includes(quote);
    case "description":
      return record.description !== null && record.description.includes(quote);
    case "features":
    case "themes":
      // A tag is quoted whole, so "Wild" cannot stand for the tag "Wild West".
      return record.source_tags[sourceField].includes(quote);
  }
}

function checkLabels(record: CanonicalRecord, answer: z.infer<typeof ReadableAnswerSchema>): Omit<ModelOutput, "outcome"> {
  const output: Omit<ModelOutput, "outcome"> = { themes: [], mechanics: [], stripped: [] };
  for (const field of ["themes", "mechanics"] as const) {
    const vocabulary: readonly string[] = field === "themes" ? THEMES : MECHANICS;
    for (const entry of answer[field]) {
      const strip = (reason: Stripped["reason"]): void => {
        output.stripped.push({ field, ...entry, reason });
      };
      if (!vocabulary.includes(entry.label)) strip("label_outside_list");
      else if (!quoteIsVerbatim(record, entry.source_field, entry.quote)) strip("invented_quote");
      else if (output[field].some((kept) => kept.label === entry.label)) strip("duplicate_label");
      else {
        output[field].push({
          label: entry.label as Label["label"],
          quote: entry.quote,
          source_field: entry.source_field,
          method: "model",
          model: ENRICHMENT_MODEL,
          prompt_version: PROMPT_VERSION,
        });
      }
    }
  }
  return output;
}

const ResponseEnvelopeSchema = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});

export const ATTEMPT_OUTCOMES = ["ok", "invalid_output", "refusal", "incomplete", "api_error"] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export type Interpreted =
  | ({ outcome: "ok" } & Omit<ModelOutput, "outcome">)
  | { outcome: "invalid_output" | "refusal" | "incomplete"; reason: string };

/** Turns a 200 response body into checked labels or a named rejection. */
export function interpretResponse(body: unknown, record: CanonicalRecord): Interpreted {
  const envelope = ResponseEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { outcome: "invalid_output", reason: `response envelope: ${z.prettifyError(envelope.error)}` };
  if (envelope.data.status !== "completed") {
    const detail = envelope.data.incomplete_details?.reason ?? "no reason given";
    return { outcome: "incomplete", reason: `status "${envelope.data.status}": ${detail}` };
  }
  const parts = envelope.data.output.flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
  if (parts.some((part) => part.type === "refusal")) return { outcome: "refusal", reason: "the model refused the request" };
  const texts = parts.flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []));
  const [text, ...others] = texts;
  if (text === undefined || others.length > 0) {
    return { outcome: "invalid_output", reason: `expected one output_text part, found ${texts.length}` };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return { outcome: "invalid_output", reason: "output text is not valid JSON" };
  }
  const answer = ReadableAnswerSchema.safeParse(candidate);
  if (!answer.success) return { outcome: "invalid_output", reason: `answer shape: ${z.prettifyError(answer.error)}` };
  return { outcome: "ok", ...checkLabels(record, answer.data) };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export function buildRequest(record: CanonicalRecord): Record<string, unknown> & { instructions: string; input: string } {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(WireAnswerSchema) as Record<string, unknown>;
  return {
    model: ENRICHMENT_MODEL,
    instructions: instructions(),
    // Merchandising tags and facts are not shown: neither can support a label.
    input: JSON.stringify({
      title: record.title,
      description: record.description,
      features: record.source_tags.features,
      themes: record.source_tags.themes,
    }),
    reasoning: { effort: "low" },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    text: { format: { type: "json_schema", name: "enrichment", strict: true, schema } },
  };
}

// ---------------------------------------------------------------------------
// Stored attempts
// ---------------------------------------------------------------------------

const AttemptSchema = z.strictObject({
  outcome: z.enum(ATTEMPT_OUTCOMES),
  seconds: z.number().nonnegative(),
  http_status: z.number().int().nullable(),
  reason: z.string().nullable(),
  usage: EnrichmentUsageSchema.nullable(),
  /** The response body as received. Null for an API error, whose body is never kept. */
  body: z.unknown(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

const EnrichmentFileSchema = z.strictObject({
  game_id: z.string(),
  model: z.string(),
  prompt_version: z.string(),
  request_sha256: z.string(),
  attempts: z.array(AttemptSchema),
});
export type EnrichmentFile = z.infer<typeof EnrichmentFileSchema>;

/** Stored answers are kept per prompt version, so a new prompt never overwrites the answers to an old one. */
export function enrichmentDir(responsesDir: string, promptVersion: string = PROMPT_VERSION): string {
  return join(responsesDir, "enrichment", promptVersion);
}

export function readEnrichmentFile(path: string): EnrichmentFile {
  const parsed = EnrichmentFileSchema.safeParse(parseJsonFrom(readText(path), path));
  if (!parsed.success) throw new Error(`${path} is not a valid enrichment response file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface EnrichOptions {
  responsesDir: string;
  /** Null means replay only: a record without a stored final answer is an error. */
  live: Live | null;
  log: (line: string) => void;
}

/**
 * The model's checked labels for one record: replayed when stored, requested when allowed.
 * Returns the stored file too, which is what the ledger counts.
 */
export async function obtainEnrichment(
  record: CanonicalRecord,
  options: EnrichOptions,
): Promise<{ output: ModelOutput; file: EnrichmentFile }> {
  const request = buildRequest(record);
  const requestHash = sha256(JSON.stringify(request));
  const dir = enrichmentDir(options.responsesDir);
  const path = join(dir, `${record.game_id}.json`);

  let file: EnrichmentFile = {
    game_id: record.game_id,
    model: ENRICHMENT_MODEL,
    prompt_version: PROMPT_VERSION,
    request_sha256: requestHash,
    attempts: [],
  };
  if (existsSync(path)) {
    file = readEnrichmentFile(path);
    if (file.request_sha256 !== requestHash || file.game_id !== record.game_id) {
      throw new Error(
        `${path} was produced by a different request (the record, the prompt or the vocabulary changed). ` +
          "A changed prompt needs a new prompt version; a changed record needs this file deleted and a --live run.",
      );
    }
  }
  const settled = settle(file, record, path);
  if (settled !== null) return { output: settled, file };

  if (options.live === null) {
    throw new Error(`no final answer for ${record.game_id} in ${path}. Re-run with --live and OPENAI_API_KEY set.`);
  }
  mkdirSync(dir, { recursive: true });
  const worstCaseUsd =
    (tokensAtMost(request.instructions + request.input + JSON.stringify(request["text"])) * PRICES.enrichment_per_million_usd.input +
      MAX_OUTPUT_TOKENS * PRICES.enrichment_per_million_usd.output) /
    1_000_000;
  for (let apiErrors = 0; apiErrors < MAX_API_ERRORS_PER_RUN; ) {
    options.live.budget.reserve(worstCaseUsd, `the enrichment call for ${record.game_id}`);
    const { attempt, retryable } = await callOnce(request, record, options.live);
    options.live.budget.settle(worstCaseUsd, attempt.usage === null ? 0 : enrichmentUsd(attempt.usage));
    file.attempts.push(attempt);
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    options.log(
      `${record.game_id}: ${attempt.outcome} in ${attempt.seconds.toFixed(1)}s` + (attempt.reason === null ? "" : ` (${attempt.reason})`),
    );
    const after = settle(file, record, path);
    if (after !== null) return { output: after, file };
    if (attempt.outcome === "api_error") {
      if (!retryable) break;
      apiErrors += 1;
      await sleep(options.live.retryDelayMs * apiErrors);
    }
  }
  throw new Error(`the enrichment call for ${record.game_id} kept failing; see ${path}`);
}

/**
 * The record's final result if its stored attempts decide one: the last accepted answer,
 * re-checked on every replay, or no labels once the model's answers were rejected MAX_ANSWERS times.
 */
function settle(file: EnrichmentFile, record: CanonicalRecord, path: string): ModelOutput | null {
  const accepted = file.attempts.findLast((attempt) => attempt.outcome === "ok");
  if (accepted !== undefined) {
    const replayed = interpretResponse(accepted.body, record);
    if (replayed.outcome !== "ok") {
      throw new Error(`${path}: the stored answer no longer passes validation: ${replayed.reason}`);
    }
    const { outcome: _ok, ...labels } = replayed;
    return { outcome: "accepted", ...labels };
  }
  const answers = file.attempts.filter((attempt) => attempt.outcome !== "api_error");
  if (answers.length >= MAX_ANSWERS) return { outcome: "no_accepted_response", themes: [], mechanics: [], stripped: [] };
  return null;
}

async function callOnce(
  request: Record<string, unknown>,
  record: CanonicalRecord,
  live: Live,
): Promise<{ attempt: Attempt; retryable: boolean }> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started) / 1000;
  const apiError = (status: number | null, reason: string, retryable: boolean) => ({
    attempt: { outcome: "api_error" as const, seconds: elapsed(), http_status: status, reason, usage: null, body: null },
    retryable,
  });

  let response: { status: number; body: unknown };
  try {
    response = await live.transport(ENDPOINT, live.apiKey, request);
  } catch (error) {
    // Only the error's class name: a transport message is not worth the risk of echoing a header.
    return apiError(null, `transport failure: ${error instanceof Error ? error.name : "unknown"}`, true);
  }
  if (response.status < 200 || response.status >= 300) {
    return apiError(response.status, describeHttpError(response.status, response.body), isRetryable(response.status));
  }
  const usage = z.object({ usage: EnrichmentUsageSchema }).safeParse(response.body);
  const interpreted = interpretResponse(response.body, record);
  return {
    attempt: {
      outcome: interpreted.outcome,
      seconds: elapsed(),
      http_status: response.status,
      reason: interpreted.outcome === "ok" ? null : interpreted.reason,
      usage: usage.success ? usage.data.usage : null,
      body: response.body,
    },
    retryable: true,
  };
}
