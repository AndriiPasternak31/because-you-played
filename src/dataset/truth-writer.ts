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
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TruthTextSchema, type TruthText, type VolatilityBand } from "./model.ts";
import { studioById, winSystemOf, type SlotPlan, type VariantKind } from "./plan.ts";
import { at, sha256Hex } from "./rng.ts";
import { MECHANICS, MECHANIC_MEANING, THEMES, THEME_MEANING, type Mechanic } from "./vocabulary.ts";

export const MODEL = "gpt-6.2-sol";
export const PROMPT_VERSION = "truth-v4";
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_ATTEMPTS_PER_RUN = 4;
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
2. Title. If brief.title.mode is "exact", return brief.title.value unchanged. If it is "invent", write a title of two to four words that a real studio could ship but that no existing commercial game is likely to carry. Follow the pattern in brief.title.shape, filling it from the game's world as set by brief.setting; the invented word in the pattern is a name you make up that begins with the letter in brief.title.invented_word_initial. Do not simply put an invented word in front of a generic category label, and avoid well-worn openers such as "Book of", "Gates of", "Legend of", "Rise of", "Age of", "Big", "Lucky", "Mega", "Super" and "Golden". Use letters, spaces and apostrophes only: no digits and no symbols. With style "thematic" the title names the first briefed theme plainly enough that a reader could tell the theme from the title alone. With style "opaque" the title is an abstract name that hints at no theme and no mechanic.
3. Description. One paragraph of 70 to 110 words of English copy written in the house style given in brief.voice. brief.setting is the angle this game takes on its first theme: build the world of the game on it, with its own characters and details. When brief.setting is null, keep the world of the related game. Plain text with plain ASCII punctuation: no markup, no line breaks, no lists. It makes every briefed theme and every briefed mechanic unmistakable to a careful reader, the way real game sheets do: by the name suppliers and players use for the feature or by a concrete account of what happens on the reels. The "meaning" texts in the brief explain the terms to you; never copy their wording, and phrase each feature differently from how a glossary would. It does not mention or imply any theme or mechanic from the vocabulary below that is not in the brief; in particular do not mention wild symbols, bonus rounds or jackpots unless a briefed mechanic is about them. It never states RTP, a percentage, a stake or bet amount, a currency or any promise about winning.
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
  blockedNameHashes: ReadonlySet<string>;
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
    blockedNameHashes: BLOCKED_NAME_HASHES,
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
    setting: relation.kind === "variant_of" ? null : slotPlan.setting,
    title:
      expectation.requiredTitle === null
        ? {
            mode: "invent",
            style: slotPlan.titleStyle,
            shape: slotPlan.titleShape,
            invented_word_initial: slotPlan.titleInitial,
          }
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
export class RejectedOutput extends Error {
  /** Words that must not be written to disk; set when the rejection is about a blocked name. */
  readonly withheld: readonly string[];

  constructor(message: string, withheld: readonly string[] = []) {
    super(message);
    this.withheld = withheld;
  }
}

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
  | { outcome: Exclude<AttemptOutcome, "ok" | "api_error">; reason: string; withheld: readonly string[] };

/** Turns a raw 200 response body into accepted text or a named rejection. */
export function interpretResponse(body: unknown, slotPlan: SlotPlan, expectation: Expectation): Interpreted {
  const envelope = ResponseEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    return { outcome: "invalid_output", reason: `response envelope: ${z.prettifyError(envelope.error)}`, withheld: [] };
  }
  if (envelope.data.status !== "completed") {
    const detail = envelope.data.incomplete_details?.reason ?? "no reason given";
    return { outcome: "incomplete", reason: `status "${envelope.data.status}": ${detail}`, withheld: [] };
  }
  const parts = envelope.data.output.flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
  if (parts.some((part) => part.type === "refusal")) {
    return { outcome: "refusal", reason: "the model refused the request", withheld: [] };
  }
  const texts = parts.flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []));
  if (texts.length !== 1) {
    return { outcome: "invalid_output", reason: `expected one output_text part, found ${texts.length}`, withheld: [] };
  }
  try {
    return { outcome: "ok", text: validateTruthText(parseJson(at(texts, 0)), slotPlan, expectation) };
  } catch (error) {
    if (error instanceof RejectedOutput) {
      return { outcome: "invalid_output", reason: error.message, withheld: error.withheld };
    }
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
 * Names that a search found to belong to something real: words the model
 * coined, and candidates considered for a studio or brand. The catalogue must
 * stay fictional, so text that uses one is rejected.
 *
 * They are kept as hashes so that this repository does not itself publish the
 * names it avoids. An entry is the first 16 hex characters of the SHA-256 of
 * the lower-cased word; `npm run dataset -- --name-hash <word>` prints one.
 * Single words only.
 */
const BLOCKED_NAME_HASHES: ReadonlySet<string> = new Set([
  "0095b2922d7ab5a4",
  "1125ed82922327b7",
  "1fcbc9fd1c248e73",
  "2148812bc9581192",
  "21dc0918f1ee5e30",
  "2962bc3b6018d331",
  "299232dfc65490df",
  "33d142e0c8013e27",
  "3e1b7ea6a835400a",
  "3ec2aa8a82c00c59",
  "48e5ccaf5f57e0aa",
  "6d81cde6701535dc",
  "7b848e04bbcd443a",
  "86b3d34939c626cd",
  "941b7a89b88e9f93",
  "963ab7b003182b9a",
  "972fb3e6f0d34c3c",
  "a86f36e617200ba9",
  "bf64032e445e82d6",
  "cb2549b8b48a52b0",
  "d27dbd9c741561e6",
  "f89983563d6ccfc1",
]);

export function nameHash(word: string): string {
  return sha256Hex(word.toLowerCase()).slice(0, 16);
}

function blockedNamesIn(text: string, blocked: ReadonlySet<string>): string[] {
  const words = text.match(/\p{L}+/gu) ?? [];
  return [...new Set(words.filter((word) => blocked.has(nameHash(word))))];
}

/**
 * A title word such as "spell" or "rune" fused with another word. Every one the model produced
 * was found to be an existing game, so they are refused as a class instead of one at a time.
 */
const FUSED_FANTASY_COMPOUND = /^(?:spell|rune)\p{L}{3,}$/iu;

/** What is stored for a rejection that was about a blocked name: the reason without the name. */
const WITHHELD_REASON =
  "uses a name that already exists outside this catalogue; the name is withheld and the stored body is redacted";
const WITHHELD_MARK = "[name withheld]";

/** Replaces the given words in every string of a JSON value. */
export function redactNames(value: unknown, names: readonly string[]): unknown {
  if (typeof value === "string") {
    return names.reduce((text, name) => text.replaceAll(new RegExp(name, "giu"), WITHHELD_MARK), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactNames(item, names));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNames(item, names)]));
  }
  return value;
}

const INVENTED_TITLE = /^[A-Z][A-Za-z']*(?: [A-Za-z][A-Za-z']*){1,3}$/;

export function validateTruthText(candidate: unknown, slotPlan: SlotPlan, expectation: Expectation): TruthText {
  const parsed = TruthTextSchema.safeParse(candidate);
  if (!parsed.success) throw new RejectedOutput(`shape: ${z.prettifyError(parsed.error)}`);
  const text = parsed.data;
  const reject = (problem: string): never => {
    throw new RejectedOutput(problem);
  };

  const realNames = blockedNamesIn(
    `${text.title} ${text.description} ${text.description_de ?? ""}`,
    expectation.blockedNameHashes,
  );
  if (realNames.length > 0) {
    throw new RejectedOutput(
      `the name ${realNames.map((name) => `"${name}"`).join(" and ")} already exists outside this catalogue; invent a different one`,
      realNames,
    );
  }
  const fused = text.title.split(" ").filter((word) => FUSED_FANTASY_COMPOUND.test(word));
  if (fused.length > 0) {
    throw new RejectedOutput(
      `the title word "${at(fused, 0)}" fuses two ordinary words, and such compounds are usually existing game titles; ` +
        "keep ordinary words separate and let the made-up name be the only invented word",
      fused,
    );
  }

  // Title
  if (expectation.requiredTitle !== null) {
    if (text.title !== expectation.requiredTitle) {
      reject(`title must be exactly "${expectation.requiredTitle}", got "${text.title}"`);
    }
  } else {
    if (!INVENTED_TITLE.test(text.title)) reject(`title "${text.title}" is not two to four plain words`);
    if (!text.title.split(" ").some((word) => word.toUpperCase().startsWith(slotPlan.titleInitial))) {
      reject(`title "${text.title}" has no word beginning with "${slotPlan.titleInitial}"`);
    }
    // Titles are kept apart by rejection, not by listing earlier titles in the request: a request
    // then depends only on its own slot, so replacing one title never invalidates the slots after it.
    const words = distinctiveWords(text.title);
    const tooClose = expectation.usedTitles.filter(
      (used) =>
        used.toLowerCase() === text.title.toLowerCase() ||
        distinctiveWords(used).filter((word) => words.includes(word)).length >= 2,
    );
    if (tooClose.length > 0) {
      // The retry is told every title that shares a word, not only the ones that tripped the rule.
      const related = expectation.usedTitles.filter((used) => distinctiveWords(used).some((word) => words.includes(word)));
      reject(
        `title "${text.title}" is too close to the existing title "${at(tooClose, 0)}"; ` +
          `use none of the main words of these titles: ${[...new Set(related)].join("; ")}`,
      );
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
  if (!slotPlan.copyMentionsFacts && (VOLATILITY_WORD.test(text.description) || /max(?:imum)? win/i.test(text.description))) {
    reject("description mentions volatility or maximum win, which the brief did not ask for");
  }
  // The copy may restate a fact of record, never set one: every number in it is one the brief
  // supplied (or part of the title), and a volatility it states is the planned one.
  const { facts } = slotPlan;
  const briefed = new Set([
    ...numbersIn(`${facts.grid} ${text.title}`),
    ...(facts.lines_or_ways === null ? [] : [facts.lines_or_ways]),
    ...(slotPlan.copyMentionsFacts ? [facts.max_win_multiplier] : []),
  ]);
  const unbriefed = numbersIn(`${text.description} ${text.description_de ?? ""}`).filter((number) => !briefed.has(number));
  if (unbriefed.length > 0) reject(`the copy states ${unbriefed.join(" and ")}, a number the brief did not supply`);
  const otherBands = statedVolatility(text.description).filter((band) => band !== facts.volatility);
  if (otherBands.length > 0) {
    reject(`description states the volatility as ${otherBands.join(" and ")}, but the brief says ${facts.volatility}`);
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

/** Every number written in digits, with thousands separators of either language removed. */
function numbersIn(text: string): number[] {
  return (text.match(/\d[\d.,]*\d|\d/g) ?? []).map((token) => Number(token.replace(/[.,]/g, "")));
}

/** Volatility under either of its trade names. Any other paraphrase, such as "low-risk", is not recognised. */
const VOLATILITY_WORD = /volatil|varian/i;

/** The volatility bands named in the sentences of an English description that speak of volatility. */
function statedVolatility(description: string): VolatilityBand[] {
  const sentences = description
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => VOLATILITY_WORD.test(sentence))
    .join(" ")
    .toLowerCase();
  // "very high" is tried first, so that it is not also read as "high".
  const phrases = sentences.match(/\b(?:very high|high|medium|low)\b/g) ?? [];
  return [...new Set(phrases)].map((phrase) => phrase.replace(" ", "_") as VolatilityBand);
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
  /** True when a blocked name was replaced in `body` before it was stored. */
  body_redacted: z.boolean(),
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

/** Parses JSON that was read from `source`; a failure names the source, which `JSON.parse` cannot. */
function parseStoredJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function readResponseFile(path: string): ResponseFile {
  const parsed = ResponseFileSchema.safeParse(parseStoredJson(readFileSync(path, "utf8"), path));
  if (!parsed.success) throw new Error(`${path} is not a valid response file: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Retired attempts: what was spent on responses that are no longer stored
// ---------------------------------------------------------------------------

export const RETIRE_REASONS = ["prompt_revision", "name_replacement", "other"] as const;
export type RetireReason = (typeof RETIRE_REASONS)[number];

const RetiredSchema = z.strictObject({
  slot: z.number().int(),
  model: z.string(),
  prompt_version: z.string(),
  reason: z.enum(RETIRE_REASONS),
  /** Accounting only: bodies and rejection reasons are not kept. */
  attempts: z.array(
    z.strictObject({
      outcome: AttemptSchema.shape.outcome,
      seconds: z.number(),
      http_status: z.number().int().nullable(),
      usage: UsageSchema.nullable(),
    }),
  ),
});
export type Retired = z.infer<typeof RetiredSchema>;

export function readRetired(path: string): Retired[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      const source = `${path} line ${index + 1}`;
      const parsed = RetiredSchema.safeParse(parseStoredJson(line, source));
      if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
      return [parsed.data];
    });
}

/**
 * Removes a slot's stored responses so that it is regenerated, keeping what
 * they cost. Returns the number of attempts retired, or null if the slot had
 * no response file.
 */
export function retireSlot(responsesDir: string, retiredPath: string, slot: number, reason: RetireReason): number | null {
  const path = join(responsesDir, responseFileName(slot));
  if (!existsSync(path)) return null;
  const file = readResponseFile(path);
  const retired: Retired = {
    slot,
    model: file.model,
    prompt_version: file.prompt_version,
    reason,
    attempts: file.attempts.map(({ outcome, seconds, http_status, usage }) => ({ outcome, seconds, http_status, usage })),
  };
  appendFileSync(retiredPath, `${JSON.stringify(RetiredSchema.parse(retired))}\n`);
  rmSync(path);
  return retired.attempts.length;
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
  // A rejected answer is never repaired, but the next attempt is told why earlier ones were
  // rejected. Every reason from this run is passed on: told only the latest, the model goes
  // back to a name it was refused two attempts ago.
  const stored = file.attempts.findLast((attempt) => attempt.outcome === "invalid_output")?.reason;
  const feedback: string[] = stored == null ? [] : [stored];
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS_PER_RUN; attemptNumber += 1) {
    if (options.live.spentUsd >= options.live.maxUsd) {
      throw new Error(
        `${label}: spend limit reached ($${options.live.spentUsd.toFixed(4)} of $${options.live.maxUsd.toFixed(2)}). ` +
          "Raise --max-usd to continue.",
      );
    }
    const attempt = await callOnce(
      feedback.length === 0 ? request : withRejectionNote(request, feedback),
      options.live.apiKey,
      slotPlan,
      expectation,
    );
    if (attempt.feedback !== null && !feedback.includes(attempt.feedback)) feedback.push(attempt.feedback);
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

function withRejectionNote(request: ModelRequest, reasons: readonly string[]): ModelRequest {
  return {
    ...request,
    input:
      `${request.input}\n\nEarlier answers to this brief were rejected for these reasons:\n` +
      `${reasons.map((reason) => `- ${reason}`).join("\n")}\nWrite a new answer that repeats none of them.`,
  };
}

async function callOnce(
  request: ModelRequest,
  apiKey: string,
  slotPlan: SlotPlan,
  expectation: Expectation,
): Promise<{ record: Attempt; text: TruthText | null; retryable: boolean; feedback: string | null }> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started) / 1000;
  const apiError = (status: number | null, reason: string, retryable: boolean) => ({
    record: {
      outcome: "api_error" as const,
      seconds: elapsed(),
      http_status: status,
      reason,
      usage: null,
      body_redacted: false,
      body: null,
    },
    text: null,
    retryable,
    feedback: null,
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
  // The model is told the real reason on the next attempt. What goes to disk never carries a
  // blocked name: the name is replaced in the body and left out of the stored reason.
  const withheld = interpreted.outcome === "ok" ? [] : interpreted.withheld;
  const redacted = withheld.length > 0;
  const rejection = interpreted.outcome === "ok" ? null : interpreted.reason;
  return {
    record: {
      outcome: interpreted.outcome,
      seconds: elapsed(),
      http_status: response.status,
      reason: redacted ? WITHHELD_REASON : rejection,
      usage: usage.success ? usage.data.usage : null,
      body_redacted: redacted,
      body: redacted ? redactNames(body, withheld) : body,
    },
    text: interpreted.outcome === "ok" ? interpreted.text : null,
    retryable: true,
    feedback: interpreted.outcome === "invalid_output" ? rejection : null,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
