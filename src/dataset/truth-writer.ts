/**
 * Truth text: the one place a model is involved in building the catalogue.
 *
 * For each slot the model writes a title, a description and the quotes that
 * support each planned theme and mechanic. Everything it returns crosses a
 * validated boundary: a response that is refused, cut short, malformed or
 * inconsistent with the plan is rejected with its reason, never repaired.
 *
 * Every attempt is stored next to the data, so the catalogue can be rebuilt
 * without a key and the run ledger can be recomputed from committed files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TruthTextSchema, type TruthText } from "./model.ts";
import { studioById, winSystemOf, type SlotPlan, type VariantKind } from "./plan.ts";
import { at, sha256Hex } from "./rng.ts";
import { MECHANICS, MECHANIC_MEANING, THEMES, THEME_MEANING, type Mechanic } from "./vocabulary.ts";

export const MODEL = "gpt-6.2-sol";
export const PROMPT_VERSION = "truth-v3";
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_ATTEMPTS_PER_RUN = 3;
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * USD per million tokens, standard tier, short context. Read from the
 * provider's pricing page on 2026-11-18; re-check before trusting a ledger
 * produced later.
 */
export const PRICE_PER_MILLION = {
  input: 2.0,
  cached_input: 0.1,
  cache_write_30m: 2.5,
  cache_write_12h: 5.0,
  output: 10.0,
} as const;

const INSTRUCTIONS = `You write supplier game-sheet copy for invented online slot games. The output seeds a synthetic test catalogue and is never shown to players. Each request is a JSON brief for one game.

Rules:
1. Everything is fictional. Never use or allude to a real game title or game series, studio, casino or betting brand, person, film, show, band or any other trademark, and never use a branded mechanic name.
2. Title. If brief.title.mode is "exact", return brief.title.value unchanged. If it is "invent", write a title of two to four words that a real studio could ship but that no existing commercial game is likely to carry. Build it around a specific character, place or object from the game's world, and make at least one word an invented name or an unusual word. Do not simply put an invented word in front of a generic category label, and avoid well-worn openers such as "Book of", "Gates of", "Legend of", "Rise of", "Age of", "Big", "Lucky", "Mega", "Super" and "Golden". Use letters, spaces and apostrophes only: no digits and no symbols. With style "thematic" the title names the first briefed theme plainly enough that a reader could tell the theme from the title alone. With style "opaque" the title is an abstract name that hints at no theme and no mechanic.
3. Description. One paragraph of 70 to 110 words of English copy written in the house style given in brief.voice. Plain text with plain ASCII punctuation: no markup, no line breaks, no lists. It makes every briefed theme and every briefed mechanic unmistakable to a careful reader, the way real game sheets do: by the name suppliers and players use for the feature or by a concrete account of what happens on the reels. The "meaning" texts in the brief explain the terms to you; never copy their wording, and phrase each feature differently from how a glossary would. It does not mention or imply any theme or mechanic from the vocabulary below that is not in the brief; in particular do not mention wild symbols, bonus rounds or jackpots unless a briefed mechanic is about them. It never states RTP, a percentage, a stake or bet amount, a currency or any promise about winning.
4. Facts. If brief.facts_to_mention is null, do not mention volatility or the maximum win at all. Otherwise work both into the copy in your own words; write the maximum win in the form "5,000x the bet" and never use the word "multiplier" for it.
5. Evidence. Exactly one entry for each briefed theme and each briefed mechanic, and no others. "span" is a short quote of 3 to 12 words copied character for character from your description which, read alone, shows that the term applies.
6. German. If brief.german_copy is true, "description_de" is a faithful, natural German rendering of the description with the same content, and each evidence entry's "span_de" is a quote of 3 to 12 words copied character for character from description_de for the same term. If it is false, "description_de" and every "span_de" are null.
7. "title_theme_terms" lists the briefed themes that the title alone states explicitly. It is empty for an opaque title.

Vocabulary of themes: ${THEMES.map((term) => `${term} (${THEME_MEANING[term]})`).join("; ")}.
Vocabulary of mechanics: ${MECHANICS.map((term) => `${term} (${MECHANIC_MEANING[term]})`).join("; ")}.`;

const VARIANT_TITLE_SUFFIX: Record<VariantKind, string> = {
  sequel: "2",
  deluxe: "Deluxe",
  seasonal: "Winter Edition",
};

const VARIANT_RELATION: Record<VariantKind, string> = {
  sequel: "a sequel to the related game: same world, changed gameplay",
  deluxe: "a deluxe edition of the related game: same world, added gameplay",
  seasonal: "a seasonal edition of the related game: same gameplay in a winter setting",
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

type ModelRequest = Record<string, unknown> & { input: string };

/** What the validator needs to know about a slot besides its plan. */
export interface Expectation {
  requiredTitle: string | null;
  usedTitles: readonly string[];
  germanCopy: boolean;
}

export function expectationFor(slotPlan: SlotPlan, texts: ReadonlyMap<number, TruthText>): Expectation {
  const { relation } = slotPlan;
  let requiredTitle: string | null = null;
  if (relation.kind === "variant_of") {
    requiredTitle = `${textOf(texts, relation.parent).title} ${VARIANT_TITLE_SUFFIX[relation.variant]}`;
  } else if (relation.kind === "same_name_as") {
    requiredTitle = textOf(texts, relation.twin).title;
  }
  return {
    requiredTitle,
    usedTitles: [...texts.entries()]
      .filter(([slot]) => slot < slotPlan.slot)
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text.title),
    germanCopy: studioById(slotPlan.studio).descriptionLocale === "de",
  };
}

function textOf(texts: ReadonlyMap<number, TruthText>, slot: number): TruthText {
  const text = texts.get(slot);
  if (text === undefined) throw new Error(`slot ${slot} has no accepted text yet`);
  return text;
}

function buildRequest(
  slotPlan: SlotPlan,
  expectation: Expectation,
  texts: ReadonlyMap<number, TruthText>,
): ModelRequest {
  const { relation, facts } = slotPlan;
  let related: Record<string, string> | null = null;
  if (relation.kind === "variant_of") {
    const parent = textOf(texts, relation.parent);
    related = {
      relation: VARIANT_RELATION[relation.variant],
      title: parent.title,
      description: parent.description,
    };
  } else if (relation.kind === "same_name_as") {
    related = {
      relation: "an unrelated game from a different studio that happens to carry the same title; share nothing else with it",
      title: textOf(texts, relation.twin).title,
    };
  }
  const studio = studioById(slotPlan.studio);
  const brief = {
    studio: studio.name,
    voice: studio.voice,
    title:
      expectation.requiredTitle === null
        ? { mode: "invent", style: slotPlan.titleStyle }
        : { mode: "exact", value: expectation.requiredTitle, style: slotPlan.titleStyle },
    themes: slotPlan.themes.map((term) => ({ term, meaning: THEME_MEANING[term] })),
    mechanics: slotPlan.mechanics.map((term) => ({ term, meaning: MECHANIC_MEANING[term] })),
    layout: {
      grid: facts.grid,
      win_system: winSystemOf(slotPlan.mechanics),
      lines_or_ways: facts.lines_or_ways,
    },
    facts_to_mention: slotPlan.copyMentionsFacts
      ? { volatility: facts.volatility, max_win: `${facts.max_win_multiplier.toLocaleString("en-US")}x the bet` }
      : null,
    related,
    german_copy: expectation.germanCopy,
  };
  const { $schema: _dialect, ...schema } = z.toJSONSchema(TruthTextSchema) as Record<string, unknown>;
  return {
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: JSON.stringify(brief),
    reasoning: { effort: "low" },
    max_output_tokens: 6000,
    store: false,
    text: { format: { type: "json_schema", name: "truth_text", strict: true, schema } },
  };
}

// ---------------------------------------------------------------------------
// Validation of what came back
// ---------------------------------------------------------------------------

/** A response that must not enter the catalogue. The message is the reason. */
export class RejectedOutput extends Error {}

const UsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  // Detail blocks are optional on the wire; a missing counter is zero.
  input_tokens_details: z
    .object({
      cached_tokens: z.number().int().default(0),
      cache_write_tokens: z.number().int().default(0),
      cache_write_tokens_details: z
        .object({ ttl_12h_tokens: z.number().int().default(0), ttl_30m_tokens: z.number().int().default(0) })
        .prefault({}),
    })
    .prefault({}),
  output_tokens_details: z.object({ reasoning_tokens: z.number().int().default(0) }).prefault({}),
});
export type Usage = z.infer<typeof UsageSchema>;

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

export type AttemptOutcome = "ok" | "invalid_output" | "refusal" | "incomplete" | "api_error";

export type Interpreted =
  | { outcome: "ok"; text: TruthText }
  | { outcome: Exclude<AttemptOutcome, "ok" | "api_error">; reason: string };

/** Turns a raw 200 response body into accepted text or a named rejection. */
export function interpretResponse(body: unknown, slotPlan: SlotPlan, expectation: Expectation): Interpreted {
  const envelope = ResponseEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return { outcome: "invalid_output", reason: `response envelope: ${z.prettifyError(envelope.error)}` };
  }
  if (envelope.data.status !== "completed") {
    const detail = envelope.data.incomplete_details?.reason ?? "no reason given";
    return { outcome: "incomplete", reason: `status "${envelope.data.status}": ${detail}` };
  }
  const parts = envelope.data.output.flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
  if (parts.some((part) => part.type === "refusal")) {
    return { outcome: "refusal", reason: "the model refused the request" };
  }
  const texts = parts.flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []));
  if (texts.length !== 1) {
    return { outcome: "invalid_output", reason: `expected one output_text part, found ${texts.length}` };
  }
  try {
    return { outcome: "ok", text: validateTruthText(parseJson(at(texts, 0)), slotPlan, expectation) };
  } catch (error) {
    if (error instanceof RejectedOutput) return { outcome: "invalid_output", reason: error.message };
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RejectedOutput("output text is not valid JSON");
  }
}

/**
 * Words that give a mechanic away. Used to reject a description that mentions
 * a mechanic the plan did not assign: the truth must be complete, or
 * evaluation would count a supported tag as an invented one.
 */
const MECHANIC_GIVEAWAYS: Record<Mechanic, RegExp> = {
  paylines: /\b(?:pay|win) ?lines?\b/i,
  ways: /\bways to win\b|\b\d[\d,]* ways\b|\ball[- ]ways\b/i,
  cluster_pays: /\bclusters?\b/i,
  free_spins: /\bfree[- ]?spins?\b|\bfree games?\b/i,
  multipliers: /\bmultipl(?:y|ies|ied|ier|iers)\b/i,
  cascading_reels: /\b(?:cascad|tumbl|avalanch)\w*/i,
  expanding_wilds: /\bexpand(?:s|ed|ing)?\b/i,
  sticky_wilds: /\bsticky\b/i,
  hold_and_respin: /\bre-?spins?\b|\bhold (?:and|&) (?:win|spin)\b/i,
  pick_bonus: /\bpicks?\b/i,
  progressive_jackpot: /\bjackpots?\b|\bprogressive\b/i,
  mystery_symbols: /\bmystery\b/i,
};

/**
 * Coinages the model produced that turned out to name something real. The
 * catalogue must stay fictional, so text that uses one is rejected. They are
 * kept as hashes (the first 16 hex characters of the SHA-256 of the
 * lower-cased word) so that this repository does not publish the names it
 * avoids. Add an entry whenever a name check finds another.
 */
const BLOCKED_NAME_HASHES: ReadonlySet<string> = new Set([
  "2148812bc9581192",
  "2962bc3b6018d331",
  "299232dfc65490df",
  "33d142e0c8013e27",
  "3ec2aa8a82c00c59",
  "6d81cde6701535dc",
  "a86f36e617200ba9",
  "f89983563d6ccfc1",
]);

const INVENTED_TITLE = /^[A-Z][A-Za-z']*(?: [A-Za-z][A-Za-z']*){1,3}$/;

export function validateTruthText(candidate: unknown, slotPlan: SlotPlan, expectation: Expectation): TruthText {
  const parsed = TruthTextSchema.safeParse(candidate);
  if (!parsed.success) throw new RejectedOutput(`shape: ${z.prettifyError(parsed.error)}`);
  const text = parsed.data;
  const reject = (problem: string): never => {
    throw new RejectedOutput(problem);
  };

  const copy = `${text.title} ${text.description} ${text.description_de ?? ""}`;
  const realName = (copy.match(/\p{L}+/gu) ?? []).find((word) =>
    BLOCKED_NAME_HASHES.has(sha256Hex(word.toLowerCase()).slice(0, 16)),
  );
  if (realName !== undefined) reject(`the name "${realName}" already exists outside this catalogue; invent a different one`);

  // Title
  if (expectation.requiredTitle !== null) {
    if (text.title !== expectation.requiredTitle) {
      reject(`title must be exactly "${expectation.requiredTitle}", got "${text.title}"`);
    }
  } else {
    if (!INVENTED_TITLE.test(text.title)) reject(`title "${text.title}" is not two to four plain words`);
    // Titles are kept apart by rejection, not by listing earlier titles in the request: a request
    // then depends only on its own slot, so replacing one title never invalidates the slots after it.
    const words = distinctiveWords(text.title);
    for (const used of expectation.usedTitles) {
      const shared = distinctiveWords(used).filter((word) => words.includes(word));
      if (used.toLowerCase() === text.title.toLowerCase() || shared.length >= 2) {
        reject(`title "${text.title}" is too close to the existing title "${used}"; use different words`);
      }
    }
  }
  const strangers = text.title_theme_terms.filter((term) => !slotPlan.themes.includes(term));
  if (strangers.length > 0) reject(`title_theme_terms names unplanned themes: ${strangers.join(", ")}`);
  if (slotPlan.titleStyle === "opaque" && text.title_theme_terms.length > 0) {
    reject(`an opaque title must state no theme, got ${text.title_theme_terms.join(", ")}`);
  }
  if (slotPlan.titleStyle === "thematic" && expectation.requiredTitle === null && text.title_theme_terms.length === 0) {
    reject("a thematic title must state at least one planned theme");
  }

  // Description
  const words = wordCount(text.description);
  if (words < 60 || words > 130) reject(`description has ${words} words, expected 60 to 130`);
  if (!/^[\x20-\x7E]+$/.test(text.description)) reject("description contains non-ASCII or control characters");
  if (/[<>%$€£]|\bRTP\b/i.test(text.description)) reject("description contains markup, a percentage, a currency or RTP");
  if (!slotPlan.copyMentionsFacts && /volatil|max(?:imum)? win/i.test(text.description)) {
    reject("description mentions volatility or maximum win, which the brief did not ask for");
  }
  for (const mechanic of MECHANICS) {
    if (!slotPlan.mechanics.includes(mechanic) && MECHANIC_GIVEAWAYS[mechanic].test(text.description)) {
      reject(`description mentions the unplanned mechanic "${mechanic}"`);
    }
  }

  // Evidence: one quote per planned term, each verbatim
  const planned = [...slotPlan.themes, ...slotPlan.mechanics].sort();
  const quoted = text.evidence.map((entry) => entry.term).sort();
  if (planned.join(",") !== quoted.join(",")) {
    reject(`evidence terms [${quoted.join(", ")}] do not match the plan [${planned.join(", ")}]`);
  }
  for (const entry of text.evidence) {
    checkQuote(entry.term, "span", entry.span, text.description);
  }

  // German copy
  if (expectation.germanCopy) {
    const german = text.description_de;
    if (german === null || wordCount(german) < 40) return reject("German copy was requested but is missing or too short");
    for (const entry of text.evidence) {
      if (entry.span_de === null) return reject(`evidence for "${entry.term}" has no German quote`);
      checkQuote(entry.term, "span_de", entry.span_de, german);
    }
  } else if (text.description_de !== null || text.evidence.some((entry) => entry.span_de !== null)) {
    reject("German copy was returned but not requested");
  }
  return text;
}

/** Words long enough to carry a title's identity, lower-cased and without a possessive. */
function distinctiveWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(" ")
    .map((word) => word.replace(/'s?$/, ""))
    .filter((word) => word.length >= 5);
}

function checkQuote(term: string, field: string, quote: string, source: string): void {
  const words = wordCount(quote);
  if (words < 2 || words > 15) throw new RejectedOutput(`${field} for "${term}" has ${words} words, expected 2 to 15`);
  if (!source.includes(quote)) throw new RejectedOutput(`${field} for "${term}" is not a verbatim quote: "${quote}"`);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Stored attempts
// ---------------------------------------------------------------------------

const AttemptSchema = z.strictObject({
  outcome: z.enum(["ok", "invalid_output", "refusal", "incomplete", "api_error"]),
  seconds: z.number(),
  http_status: z.number().int().nullable(),
  reason: z.string().nullable(),
  usage: UsageSchema.nullable(),
  /** The response body as received. Null for API errors, whose bodies are never kept. */
  body: z.unknown(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

const ResponseFileSchema = z.strictObject({
  slot: z.number().int(),
  model: z.string(),
  prompt_version: z.string(),
  request_sha256: z.string(),
  attempts: z.array(AttemptSchema),
});
export type ResponseFile = z.infer<typeof ResponseFileSchema>;

export function responseFileName(slot: number): string {
  return `slot-${String(slot).padStart(3, "0")}.json`;
}

export function readResponseFile(path: string): ResponseFile {
  const parsed = ResponseFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid response file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function estimateUsd(usage: Usage): number {
  const details = usage.input_tokens_details;
  const write12h = details.cache_write_tokens_details.ttl_12h_tokens;
  const write30m = details.cache_write_tokens - write12h;
  // Assumes input_tokens counts cached and cache-written tokens too.
  const plainInput = usage.input_tokens - details.cached_tokens - details.cache_write_tokens;
  return (
    (plainInput * PRICE_PER_MILLION.input +
      details.cached_tokens * PRICE_PER_MILLION.cached_input +
      write30m * PRICE_PER_MILLION.cache_write_30m +
      write12h * PRICE_PER_MILLION.cache_write_12h +
      usage.output_tokens * PRICE_PER_MILLION.output) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Obtaining the text for one slot: replay if committed, call if allowed
// ---------------------------------------------------------------------------

export interface WriterOptions {
  responsesDir: string;
  /** Null means replay only: a slot without a committed response is an error. */
  live: { apiKey: string; maxUsd: number; spentUsd: number } | null;
  log: (line: string) => void;
}

export async function obtainTruthText(
  slotPlan: SlotPlan,
  texts: ReadonlyMap<number, TruthText>,
  options: WriterOptions,
): Promise<TruthText> {
  const expectation = expectationFor(slotPlan, texts);
  const request = buildRequest(slotPlan, expectation, texts);
  const requestHash = sha256Hex(JSON.stringify(request));
  const path = join(options.responsesDir, responseFileName(slotPlan.slot));
  const label = `slot ${slotPlan.slot} (${slotPlan.scenario})`;

  let file: ResponseFile = {
    slot: slotPlan.slot,
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    request_sha256: requestHash,
    attempts: [],
  };
  if (existsSync(path)) {
    file = readResponseFile(path);
    if (file.request_sha256 !== requestHash) {
      throw new Error(
        `${label}: ${path} was produced by a different request (plan, prompt or an earlier title changed). ` +
          "Delete it and re-run with --live to regenerate, or restore the code that produced it.",
      );
    }
    const accepted = file.attempts.findLast((attempt) => attempt.outcome === "ok");
    if (accepted !== undefined) {
      // Re-validated on every replay: a committed response gets no free pass.
      const replayed = interpretResponse(accepted.body, slotPlan, expectation);
      if (replayed.outcome !== "ok") {
        throw new Error(`${label}: the committed response no longer passes validation: ${replayed.reason}`);
      }
      return replayed.text;
    }
  }

  if (options.live === null) {
    throw new Error(`${label}: no accepted response in ${path}. Re-run with --live and OPENAI_API_KEY set.`);
  }
  mkdirSync(options.responsesDir, { recursive: true });
  // A rejected answer is never repaired, but the next attempt is told why it was rejected.
  let rejection = file.attempts.findLast((attempt) => attempt.outcome === "invalid_output")?.reason ?? null;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS_PER_RUN; attemptNumber += 1) {
    if (options.live.spentUsd >= options.live.maxUsd) {
      throw new Error(
        `${label}: spend limit reached ($${options.live.spentUsd.toFixed(4)} of $${options.live.maxUsd.toFixed(2)}). ` +
          "Raise --max-usd to continue.",
      );
    }
    const attempt = await callOnce(
      rejection === null ? request : withRejectionNote(request, rejection),
      options.live.apiKey,
      slotPlan,
      expectation,
    );
    if (attempt.record.outcome === "invalid_output") rejection = attempt.record.reason;
    file.attempts.push(attempt.record);
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    if (attempt.record.usage !== null) options.live.spentUsd += estimateUsd(attempt.record.usage);
    options.log(
      `${label}: attempt ${attemptNumber} ${attempt.record.outcome} in ${attempt.record.seconds.toFixed(1)}s` +
        (attempt.record.reason === null ? "" : ` (${attempt.record.reason})`),
    );
    if (attempt.text !== null) return attempt.text;
    if (attempt.record.outcome === "api_error" && !attempt.retryable) break;
    if (attempt.record.outcome === "api_error") await sleep(2000 * attemptNumber);
  }
  throw new Error(`${label}: no acceptable response after ${file.attempts.length} stored attempt(s); see ${path}`);
}

function withRejectionNote(request: ModelRequest, reason: string): ModelRequest {
  return {
    ...request,
    input: `${request.input}\n\nAn earlier answer to this brief was rejected for this reason: ${reason}\nWrite a new answer that does not repeat it.`,
  };
}

async function callOnce(
  request: ModelRequest,
  apiKey: string,
  slotPlan: SlotPlan,
  expectation: Expectation,
): Promise<{ record: Attempt; text: TruthText | null; retryable: boolean }> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started) / 1000;
  const apiError = (status: number | null, reason: string, retryable: boolean) => ({
    record: { outcome: "api_error" as const, seconds: elapsed(), http_status: status, reason, usage: null, body: null },
    text: null,
    retryable,
  });

  let response: Response;
  let body: unknown;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = (await response.json()) as unknown;
  } catch (error) {
    // Only the error's class name: a transport message is not worth the risk of echoing a header.
    return apiError(null, `transport failure: ${error instanceof Error ? error.name : "unknown"}`, true);
  }

  if (!response.ok) {
    // The provider's message can echo part of the key, so only its machine-readable fields are kept.
    const fields = z
      .object({ error: z.object({ type: z.string().nullish(), code: z.string().nullish(), param: z.string().nullish() }) })
      .safeParse(body);
    const detail = fields.success
      ? `type=${fields.data.error.type ?? "?"} code=${fields.data.error.code ?? "?"} param=${fields.data.error.param ?? "?"}`
      : "unreadable error body";
    const retryable = [408, 409, 429].includes(response.status) || response.status >= 500;
    return apiError(response.status, `http ${response.status} ${detail}`, retryable);
  }

  const usage = z.object({ usage: UsageSchema }).safeParse(body);
  const interpreted = interpretResponse(body, slotPlan, expectation);
  return {
    record: {
      outcome: interpreted.outcome,
      seconds: elapsed(),
      http_status: response.status,
      reason: interpreted.outcome === "ok" ? null : interpreted.reason,
      usage: usage.success ? usage.data.usage : null,
      body,
    },
    text: interpreted.outcome === "ok" ? interpreted.text : null,
    retryable: true,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
