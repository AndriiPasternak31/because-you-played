/**
 * The reviewer: a second model that decides the cases the answer key cannot.
 *
 * The question text is not written here. It is read from eval/refs/evaluation-plan.md, the
 * owner's file, and only the bracketed blanks are filled in. Every answer is stored beside
 * the evaluation, so a run without a key replays it; a stored answer to a question that has
 * since changed is refused, not reused.
 *
 * A "yes" to a label question counts only when its quote stands word for word in the text
 * that was shown. Otherwise the answer is recorded as unclear.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MECHANIC_MEANING, THEME_MEANING, isTheme, type Term } from "../src/dataset/vocabulary.ts";
import { EnrichmentUsageSchema, describeHttpError, isRetryable, sleep, tokensAtMost, type EnrichmentUsage, type Live } from "../src/pipeline/costs.ts";
import { sha256 } from "../src/pipeline/io.ts";
import type { IndexRecord } from "../src/pipeline/index-store.ts";
import { isWordForWord } from "./measures.ts";

export const REVIEWER_MODEL = "gpt-6-luna";
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 2000;
/** A question whose answers were all rejected this many times is recorded as unclear. */
const MAX_ANSWERS = 2;
const MAX_API_ERRORS = 3;

/** The most this task may spend on the reviewer, in USD, counting every stored answer. A run may lower it, never raise it. */
export const REVIEWER_MAX_USD = 1.0;

/** USD per million tokens, standard tier, read from the provider's pricing page on the date below. */
export const REVIEWER_PRICES = { read_on: "2026-11-19", per_million_usd: { input: 0.1, cached_input: 0.01, output: 0.5 } } as const;

export function reviewerUsd(usage: EnrichmentUsage): number {
  const price = REVIEWER_PRICES.per_million_usd;
  const cached = usage.input_tokens_details.cached_tokens;
  return ((usage.input_tokens - cached) * price.input + cached * price.cached_input + usage.output_tokens * price.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// The questions, in the plan's words
// ---------------------------------------------------------------------------

export interface QuestionTemplates {
  label: string;
  recommendation: string;
}

const BLANKS = {
  shown: "{title, description and tags exactly as delivered}",
  name: "{name}",
  meaning: "{meaning}",
  played: "{title, description and tags of the game played}",
  other: "{title, description and tags of the other game}",
} as const;

/** Reads the two question texts out of the owner's plan. Fails when the plan no longer holds them in the expected form. */
export function readTemplates(planPath: string): QuestionTemplates {
  const plan = readFileSync(planPath, "utf8");
  const block = (heading: string): string => {
    const match = new RegExp(`### ${heading}\\n+\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``).exec(plan);
    if (match?.[1] === undefined) throw new Error(`${planPath} has no "${heading}" text block, so the reviewer has no question to be asked`);
    return match[1];
  };
  const templates = { label: block("Label question"), recommendation: block("Recommendation question") };
  const need = (text: string, blanks: readonly string[], what: string): void => {
    for (const blank of blanks) {
      if (text.split(blank).length !== 2) throw new Error(`${planPath}: the ${what} must hold the blank ${blank} exactly once`);
    }
  };
  need(templates.label, [BLANKS.shown, BLANKS.name, BLANKS.meaning], "label question");
  need(templates.recommendation, [BLANKS.played, BLANKS.other], "recommendation question");
  if (!plan.includes(`\`${REVIEWER_MODEL}\``)) throw new Error(`${planPath} does not name ${REVIEWER_MODEL} as the reviewer, and that is the model this code asks`);
  return templates;
}

/** The text of a record exactly as it was delivered: title, description and tag lists. */
export const shownText = (record: IndexRecord): string => record.versions.raw.text;

export interface LabelQuestion {
  kind: "label";
  id: string;
  game_id: string;
  label: Term;
  shown: string;
  text: string;
}

export interface RecommendationQuestion {
  kind: "recommendation";
  id: string;
  played: string;
  other: string;
  text: string;
}

export type Question = LabelQuestion | RecommendationQuestion;

export function labelQuestion(templates: QuestionTemplates, record: IndexRecord, label: Term): LabelQuestion {
  const shown = shownText(record);
  const meaning = isTheme(label) ? THEME_MEANING[label] : MECHANIC_MEANING[label];
  return {
    kind: "label",
    id: `label.${record.game_id}.${label}`,
    game_id: record.game_id,
    label,
    shown,
    // Function replacements, so that a "$" in catalogue text is never read as a pattern.
    text: templates.label
      .replace(BLANKS.shown, () => shown)
      .replace(BLANKS.name, () => label.replaceAll("_", " "))
      .replace(BLANKS.meaning, () => meaning),
  };
}

export function recommendationQuestion(templates: QuestionTemplates, played: IndexRecord, other: IndexRecord): RecommendationQuestion {
  return {
    kind: "recommendation",
    id: `recommendation.${played.game_id}.${other.game_id}`,
    played: played.game_id,
    other: other.game_id,
    text: templates.recommendation.replace(BLANKS.played, () => shownText(played)).replace(BLANKS.other, () => shownText(other)),
  };
}

// ---------------------------------------------------------------------------
// The request and the answer
// ---------------------------------------------------------------------------

const ANSWERS = ["yes", "no", "unclear"] as const;
export type AnswerWord = (typeof ANSWERS)[number];

const LabelAnswerSchema = z.strictObject({ answer: z.enum(ANSWERS), quote: z.string() });
const RecommendationAnswerSchema = z.strictObject({ answer: z.enum(ANSWERS), in_common: z.string() });

/** The question goes as the whole input, with nothing before it. The answer format is the only addition. */
export function buildRequest(question: Question): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(question.kind === "label" ? LabelAnswerSchema : RecommendationAnswerSchema) as Record<string, unknown>;
  return {
    model: REVIEWER_MODEL,
    input: question.text,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    text: { format: { type: "json_schema", name: `${question.kind}_answer`, strict: true, schema } },
  };
}

const EnvelopeSchema = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })),
});

export interface ReviewerAnswer {
  /** What counts: a "yes" without a word-for-word quote is "unclear" here. */
  answer: AnswerWord;
  /** What the model said. */
  said: AnswerWord | null;
  /** The quote of a label answer, or what the two games have in common for a recommendation answer. */
  words: string;
  /** Why `answer` differs from `said`, when it does. */
  note: "yes_without_word_for_word_quote" | "no_accepted_answer" | null;
}

type Interpreted = { outcome: "ok"; answer: ReviewerAnswer } | { outcome: "invalid_output" | "refusal" | "incomplete"; reason: string };

/** Turns a stored or fresh response body into an answer, or a named rejection. Nothing is repaired. */
export function interpret(body: unknown, question: Question): Interpreted {
  const envelope = EnvelopeSchema.safeParse(body);
  if (!envelope.success) return { outcome: "invalid_output", reason: `response envelope: ${z.prettifyError(envelope.error)}` };
  if (envelope.data.status !== "completed") {
    return { outcome: "incomplete", reason: `status "${envelope.data.status}": ${envelope.data.incomplete_details?.reason ?? "no reason given"}` };
  }
  const parts = envelope.data.output.flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
  if (parts.some((part) => part.type === "refusal")) return { outcome: "refusal", reason: "the model refused the question" };
  const texts = parts.flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []));
  const [text, ...others] = texts;
  if (text === undefined || others.length > 0) return { outcome: "invalid_output", reason: `expected one output_text part, found ${texts.length}` };
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return { outcome: "invalid_output", reason: "output text is not valid JSON" };
  }
  if (question.kind === "label") {
    const parsed = LabelAnswerSchema.safeParse(candidate);
    if (!parsed.success) return { outcome: "invalid_output", reason: `answer shape: ${z.prettifyError(parsed.error)}` };
    const { answer: said, quote } = parsed.data;
    const backed = said !== "yes" || isWordForWord(question.shown, quote);
    return { outcome: "ok", answer: { answer: backed ? said : "unclear", said, words: quote, note: backed ? null : "yes_without_word_for_word_quote" } };
  }
  const parsed = RecommendationAnswerSchema.safeParse(candidate);
  if (!parsed.success) return { outcome: "invalid_output", reason: `answer shape: ${z.prettifyError(parsed.error)}` };
  return { outcome: "ok", answer: { answer: parsed.data.answer, said: parsed.data.answer, words: parsed.data.in_common, note: null } };
}

// ---------------------------------------------------------------------------
// Stored answers
// ---------------------------------------------------------------------------

const AttemptSchema = z.strictObject({
  outcome: z.enum(["ok", "invalid_output", "refusal", "incomplete", "api_error"]),
  seconds: z.number().nonnegative(),
  http_status: z.number().int().nullable(),
  reason: z.string().nullable(),
  usage: EnrichmentUsageSchema.nullable(),
  /** The response body as received. Null for an API error, whose body is never kept. */
  body: z.unknown(),
});
type Attempt = z.infer<typeof AttemptSchema>;

const AnswerFileSchema = z.strictObject({
  question_id: z.string(),
  kind: z.enum(["label", "recommendation"]),
  model: z.string(),
  request_sha256: z.string(),
  attempts: z.array(AttemptSchema),
});
export type AnswerFile = z.infer<typeof AnswerFileSchema>;

export const answerPath = (dir: string, questionId: string): string => join(dir, `${questionId}.json`);
export const requestHash = (question: Question): string => sha256(JSON.stringify(buildRequest(question)));

function readAnswerFile(path: string): AnswerFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not a readable stored answer: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = AnswerFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${path} is not a valid stored answer: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The question's final answer if its stored attempts decide one. The stored body is re-read on every run. */
function settle(file: AnswerFile, question: Question, path: string): ReviewerAnswer | null {
  const accepted = file.attempts.findLast((attempt) => attempt.outcome === "ok");
  if (accepted !== undefined) {
    const replayed = interpret(accepted.body, question);
    if (replayed.outcome !== "ok") throw new Error(`${path}: the stored answer no longer reads as an answer: ${replayed.reason}`);
    return replayed.answer;
  }
  if (file.attempts.filter((attempt) => attempt.outcome !== "api_error").length >= MAX_ANSWERS) {
    return { answer: "unclear", said: null, words: "", note: "no_accepted_answer" };
  }
  return null;
}

export interface Spend {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  seconds: number;
  files: number;
}

/** What every stored answer cost, whether or not this run still asks its question. */
export function storedSpend(dir: string): Spend {
  const spend: Spend = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, seconds: 0, files: 0 };
  if (!existsSync(dir)) return spend;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    spend.files += 1;
    for (const attempt of readAnswerFile(join(dir, name)).attempts) {
      spend.calls += 1;
      spend.seconds += attempt.seconds;
      if (attempt.usage === null) continue;
      spend.input_tokens += attempt.usage.input_tokens;
      spend.output_tokens += attempt.usage.output_tokens;
      spend.usd += reviewerUsd(attempt.usage);
    }
  }
  spend.usd = Math.round(spend.usd * 1e6) / 1e6;
  spend.seconds = Math.round(spend.seconds * 1000) / 1000;
  return spend;
}

export interface ObtainOptions {
  dir: string;
  /** Null replays stored answers only: a question without one is an error. */
  live: Live | null;
  log: (line: string) => void;
}

/** One question's answer: replayed when stored, asked when allowed. */
export async function obtainAnswer(question: Question, options: ObtainOptions): Promise<ReviewerAnswer> {
  const path = answerPath(options.dir, question.id);
  const request = buildRequest(question);
  const hash = sha256(JSON.stringify(request));
  let file: AnswerFile = { question_id: question.id, kind: question.kind, model: REVIEWER_MODEL, request_sha256: hash, attempts: [] };
  if (existsSync(path)) {
    file = readAnswerFile(path);
    if (file.request_sha256 !== hash || file.question_id !== question.id) {
      throw new Error(
        `${path} answers a different question (the record, the label meaning or the plan's question text changed). ` +
          "Delete it and re-run with --live; what it cost stays counted only while the file exists.",
      );
    }
  }
  const settled = settle(file, question, path);
  if (settled !== null) return settled;
  if (options.live === null) {
    throw new Error(`missing input: no stored reviewer answer for ${question.id} at ${path}. Re-run with --live and OPENAI_API_KEY set.`);
  }

  mkdirSync(options.dir, { recursive: true });
  const price = REVIEWER_PRICES.per_million_usd;
  const worstCaseUsd = (tokensAtMost(JSON.stringify(request)) * price.input + MAX_OUTPUT_TOKENS * price.output) / 1_000_000;
  for (let apiErrors = 0; apiErrors < MAX_API_ERRORS; ) {
    options.live.budget.reserve(worstCaseUsd, `the reviewer call for ${question.id}`);
    const { attempt, retryable } = await callOnce(request, question, options.live);
    options.live.budget.settle(worstCaseUsd, attempt.usage === null ? 0 : reviewerUsd(attempt.usage));
    file.attempts.push(attempt);
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    options.log(`${question.id}: ${attempt.outcome} in ${attempt.seconds.toFixed(1)}s${attempt.reason === null ? "" : ` (${attempt.reason})`}`);
    const after = settle(file, question, path);
    if (after !== null) return after;
    if (attempt.outcome === "api_error") {
      if (!retryable) break;
      apiErrors += 1;
      await sleep(options.live.retryDelayMs * apiErrors);
    }
  }
  throw new Error(`the reviewer call for ${question.id} kept failing; see ${path}`);
}

async function callOnce(request: Record<string, unknown>, question: Question, live: Live): Promise<{ attempt: Attempt; retryable: boolean }> {
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
  const interpreted = interpret(response.body, question);
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
