/**
 * The measures of eval/refs/evaluation-plan.md, computed from the index and the answer key.
 * Every rate is returned with its counts. No pass mark is here: see gate.ts.
 */
import type { TruthRow } from "../src/dataset/model.ts";
import { MECHANICS, THEMES, type Term } from "../src/dataset/vocabulary.ts";
import type { Index, IndexRecord } from "../src/pipeline/index-store.ts";
import { VERSIONS, type Version } from "../src/pipeline/versions.ts";
import { grade, type Truth } from "./truth.ts";

export type LabelVersion = Exclude<Version, "raw">;
export const LABEL_VERSIONS = VERSIONS.filter((version): version is LabelVersion => version !== "raw");

export const FIELDS = ["themes", "mechanics"] as const;
export type FieldName = (typeof FIELDS)[number];

export interface Rate {
  count: number;
  of: number;
  /** Null when there was nothing to take a share of. */
  rate: number | null;
}

export const round = (value: number): number => Math.round(value * 1e6) / 1e6;
export const rate = (count: number, of: number): Rate => ({ count, of, rate: of === 0 ? null : round(count / of) });

const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /[\p{L}\p{N}]/u.test(character);

/**
 * True when `quote` stands in `text` word for word: the same characters, starting and ending
 * on a word boundary. A piece from inside a word ("ri" out of "riddles") is not a quote.
 * This is the evaluation's own check; it does not call the pipeline's.
 */
export function isWordForWord(text: string, quote: string): boolean {
  if (quote.trim().length === 0 || quote !== quote.trim()) return false;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const startsOnBoundary = !(isWordCharacter(text[at - 1]) && isWordCharacter(quote[0]));
    const endsOnBoundary = !(isWordCharacter(quote[quote.length - 1]) && isWordCharacter(text[at + quote.length]));
    if (startsOnBoundary && endsOnBoundary) return true;
  }
  return false;
}

/** Whether a label's quote is in the field it names. A tag is quoted whole. */
export function quoteIsInRecord(record: IndexRecord, sourceField: string, quote: string): boolean {
  const { canonical } = record;
  switch (sourceField) {
    case "title":
      return isWordForWord(canonical.title, quote);
    case "description":
      return canonical.description !== null && isWordForWord(canonical.description, quote);
    case "features":
      return canonical.source_tags.features.includes(quote);
    case "themes":
      return canonical.source_tags.themes.includes(quote);
    default:
      return false;
  }
}

export function truthRowOf(record: IndexRecord, truth: Truth): TruthRow {
  const row = truth.rows.get(record.canonical.source.record_id);
  if (row === undefined) throw new Error(`the answer key has no row ${record.canonical.source.record_id} for game ${record.game_id}`);
  if (row.game_id !== record.game_id) throw new Error(`the answer key's row ${row.source_record_id} is for ${row.game_id}, not ${record.game_id}`);
  return row;
}

/** What the plan says about one label on one row. */
export type PlanSays = "recoverable" | "unknowable" | "not_assigned";

export function planSays(row: TruthRow, field: FieldName, term: Term): PlanSays {
  if (row.recoverable[field].some((entry) => entry.term === term)) return "recoverable";
  if ((row.unknowable[field] as readonly string[]).includes(term)) return "unknowable";
  return "not_assigned";
}

export interface Disagreement {
  game_id: string;
  field: FieldName;
  label: Term;
  plan: Exclude<PlanSays, "recoverable">;
  /** The versions that assert it, each with the words it quoted. */
  asserted_by: { version: LabelVersion; quote: string; source_field: string; method: string }[];
}

export interface Miss {
  game_id: string;
  field: FieldName;
  label: Term;
  via: string[];
  /** `conflict_rule`: the field is empty in this version because a tag contradicts the description and nothing resolved it. */
  cause: "not_asserted" | "conflict_rule";
}

export interface EnrichmentCounts {
  asserted: number;
  asserted_recoverable: number;
  asserted_not_assigned: number;
  asserted_unknowable: number;
  recoverable: number;
  recovered: number;
  recoverable_without_tags: number;
  recovered_without_tags: number;
  missed_abstentions: { game_id: string; field: FieldName; asserted: Term[] }[];
  invalid_quotes: { game_id: string; field: FieldName; label: Term; quote: string; source_field: string }[];
  misses: Miss[];
  expected_abstentions: number;
}

/** Counts for one version, and the disagreements it adds to `disagreements` (keyed by game and label). */
export function countEnrichment(index: Index, truth: Truth, version: LabelVersion, disagreements: Map<string, Disagreement>): EnrichmentCounts {
  const counts: EnrichmentCounts = {
    asserted: 0,
    asserted_recoverable: 0,
    asserted_not_assigned: 0,
    asserted_unknowable: 0,
    recoverable: 0,
    recovered: 0,
    recoverable_without_tags: 0,
    recovered_without_tags: 0,
    missed_abstentions: [],
    invalid_quotes: [],
    misses: [],
    expected_abstentions: 0,
  };
  for (const record of index.records) {
    const row = truthRowOf(record, truth);
    for (const field of FIELDS) {
      const content = record.versions[version][field];
      if (content === null) throw new Error(`${record.game_id}: version ${version} has no ${field} field, so it asserts no labels to measure`);
      const asserted = content.labels;
      for (const label of asserted) {
        counts.asserted += 1;
        if (!quoteIsInRecord(record, label.source_field, label.quote)) {
          counts.invalid_quotes.push({ game_id: record.game_id, field, label: label.label, quote: label.quote, source_field: label.source_field });
        }
        const says = planSays(row, field, label.label);
        if (says === "recoverable") {
          counts.asserted_recoverable += 1;
          continue;
        }
        if (says === "unknowable") counts.asserted_unknowable += 1;
        else counts.asserted_not_assigned += 1;
        const key = `${record.game_id}|${label.label}`;
        const entry = disagreements.get(key) ?? { game_id: record.game_id, field, label: label.label, plan: says, asserted_by: [] };
        entry.asserted_by.push({ version, quote: label.quote, source_field: label.source_field, method: label.method });
        disagreements.set(key, entry);
      }
      for (const entry of row.recoverable[field]) {
        const hit = asserted.some((label) => label.label === entry.term);
        const withoutTags = !entry.via.includes("source_tags");
        counts.recoverable += 1;
        if (hit) counts.recovered += 1;
        if (withoutTags) counts.recoverable_without_tags += 1;
        if (withoutTags && hit) counts.recovered_without_tags += 1;
        if (!hit) counts.misses.push({ game_id: record.game_id, field, label: entry.term, via: entry.via, cause: content.status === "conflict" ? "conflict_rule" : "not_asserted" });
      }
      if (row.expected_abstain[field]) {
        counts.expected_abstentions += 1;
        if (asserted.length > 0) counts.missed_abstentions.push({ game_id: record.game_id, field, asserted: asserted.map((label) => label.label) });
      }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface PairwiseGame {
  game_id: string;
  wins: number;
  pairs: number;
}

export interface Pairwise {
  pooled: Rate;
  per_game: { mean: number | null; games: number; games_without_a_pair: number };
}

function dot(vectors: Float32Array, dimensions: number, a: number, b: number): number {
  let sum = 0;
  for (let column = 0; column < dimensions; column += 1) sum += (vectors[a * dimensions + column] as number) * (vectors[b * dimensions + column] as number);
  return sum;
}

/**
 * For each game: over every pair of one strong-or-related game and one unrelated game, how often
 * the related one scores strictly higher. Weak pairs and members of the game's own family are left out.
 * The index holds one record per game, so it holds no duplicate to leave out.
 */
export function pairwiseByGame(index: Index, truth: Truth, version: Version): PairwiseGame[] {
  const { dimensions } = index.manifest;
  const vectors = index.vectors[version];
  const games = index.records.map((record) => {
    const game = truth.games.get(record.game_id);
    if (game === undefined) throw new Error(`the answer key has no game ${record.game_id}`);
    return game;
  });
  return index.records.map((record, anchor) => {
    const anchorGame = games[anchor] as (typeof games)[number];
    const related: number[] = [];
    const unrelated: number[] = [];
    games.forEach((other, row) => {
      if (row === anchor) return;
      if (anchorGame.family_id !== null && other.family_id === anchorGame.family_id) return;
      const pairGrade = grade(anchorGame, other);
      if (pairGrade === "strong" || pairGrade === "related") related.push(dot(vectors, dimensions, anchor, row));
      else if (pairGrade === "unrelated") unrelated.push(dot(vectors, dimensions, anchor, row));
    });
    let wins = 0;
    for (const relatedScore of related) for (const unrelatedScore of unrelated) if (relatedScore > unrelatedScore) wins += 1;
    return { game_id: record.game_id, wins, pairs: related.length * unrelated.length };
  });
}

export function summarisePairwise(games: readonly PairwiseGame[]): Pairwise {
  const withPairs = games.filter((game) => game.pairs > 0);
  const wins = games.reduce((sum, game) => sum + game.wins, 0);
  const pairs = games.reduce((sum, game) => sum + game.pairs, 0);
  return {
    pooled: rate(wins, pairs),
    per_game: {
      mean: withPairs.length === 0 ? null : round(withPairs.reduce((sum, game) => sum + game.wins / game.pairs, 0) / withPairs.length),
      games: withPairs.length,
      games_without_a_pair: games.length - withPairs.length,
    },
  };
}

/** The figure the gate reads: the lower of the pooled accuracy and the mean per game. */
export function gateAccuracy(pairwise: Pairwise): number | null {
  if (pairwise.pooled.rate === null || pairwise.per_game.mean === null) return null;
  return Math.min(pairwise.pooled.rate, pairwise.per_game.mean);
}

export const ALL_TERMS: readonly Term[] = [...THEMES, ...MECHANICS];
