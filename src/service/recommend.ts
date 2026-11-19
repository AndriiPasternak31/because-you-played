/**
 * The recommender core: related games for one game on one brand. A plain function.
 *
 * It reads what was loaded at the start and nothing else: no file, no network, no model.
 * The order of the steps is the order of the code, and the trace reports them in that order:
 *
 *   1. look up the game                      -> decline `unknown_game`
 *   2. the game must be live on the brand    -> decline `anchor_not_available`
 *   3. the game's record must say something  -> decline `insufficient_data`
 *   4. remove every game that is not live on the brand        (product rule 3: before any score exists)
 *   5. remove the game itself and its duplicates
 *   6. remove records with too little data to compare
 *   7. score what is left against the game, and rank
 *   8. remove everything below the similarity floor           -> decline `nothing_above_floor`
 *   9. keep at most one game of the anchor's own family
 *  10. cut to the limit
 */
import type { OfferingStatus } from "../dataset/model.ts";
import type { Index, IndexRecord } from "../pipeline/index-store.ts";
import type { Field } from "../pipeline/versions.ts";
import type { Version } from "../pipeline/versions.ts";
import type { Offerings } from "./offerings.ts";

export const DECLINE_REASONS = ["unknown_game", "anchor_not_available", "insufficient_data", "nothing_above_floor"] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

const DECLINE_SENTENCES: Record<DeclineReason, string> = {
  unknown_game: "The index holds no game with this id.",
  anchor_not_available: "The game is not live on this brand, so nothing is recommended from it there.",
  insufficient_data: "The game's record has no description and no tag that maps to a label: too little to compare it with anything.",
  nothing_above_floor: "No game that is live on this brand is similar enough to clear the similarity floor.",
};

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 10;

/**
 * The similarity floor. It is a rule, not a hand-picked number: a candidate must be more
 * similar to the anchor than this share of all pairs of games in the same version of the index.
 * It was fixed before any evaluation result existed, and it reads the vectors only.
 */
export const FLOOR_RULE = {
  id: "floor-p90-v1",
  quantile: 0.9,
  rule: "The floor is the similarity that 90% of all pairs of games in this version fall below (nearest rank).",
} as const;

export interface ServingState {
  version: Version;
  indexHash: string;
  dimensions: number;
  records: readonly IndexRecord[];
  rowById: ReadonlyMap<string, number>;
  /** All vectors of the served version end to end, unit length. */
  vectors: Float32Array;
  offerings: Offerings;
  floor: number;
}

function dot(vectors: Float32Array, dimensions: number, a: number, b: number): number {
  let sum = 0;
  const offsetA = a * dimensions;
  const offsetB = b * dimensions;
  for (let column = 0; column < dimensions; column += 1) {
    sum += (vectors[offsetA + column] as number) * (vectors[offsetB + column] as number);
  }
  return sum;
}

/** Scores are rounded once, here, so that the floor, the ranking and the trace all see the same number. */
function similarity(vectors: Float32Array, dimensions: number, a: number, b: number): number {
  return Math.round(dot(vectors, dimensions, a, b) * 1e6) / 1e6;
}

export function similarityFloor(vectors: Float32Array, dimensions: number, count: number): number {
  const scores: number[] = [];
  for (let a = 0; a < count; a += 1) {
    for (let b = a + 1; b < count; b += 1) scores.push(similarity(vectors, dimensions, a, b));
  }
  if (scores.length === 0) throw new Error("the index holds fewer than two games, so there is no pair to set a similarity floor from");
  scores.sort((x, y) => x - y);
  const rank = Math.min(scores.length, Math.max(1, Math.ceil(FLOOR_RULE.quantile * scores.length)));
  return scores[rank - 1] as number;
}

/** Builds what a request reads. No verdict is involved: whether this may be served is decided in `state.ts`. */
export function buildState(index: Index, offerings: Offerings, version: Version): ServingState {
  const { dimensions } = index.manifest;
  const vectors = index.vectors[version];
  return {
    version,
    indexHash: index.manifest.index_hash,
    dimensions,
    records: index.records,
    rowById: new Map(index.records.map((record, row) => [record.game_id, row])),
    vectors,
    offerings,
    floor: similarityFloor(vectors, dimensions, index.records.length),
  };
}

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

export interface GameRef {
  game_id: string;
  title: string;
  provider: string;
}

export interface Scored extends GameRef {
  rank: number;
  score: number;
  family_id: string | null;
}

export interface Removal extends GameRef {
  why: string;
}

export interface FilterStep {
  filter: "not_live_on_brand" | "anchor_or_duplicate" | "insufficient_data" | "below_floor" | "family_cap" | "over_limit";
  /** What the filter does, in a sentence. */
  rule: string;
  removed: Removal[];
  remaining: number;
}

type TraceLabel = Field["labels"][number];

export interface TraceAnchor extends GameRef {
  status_on_brand: OfferingStatus | "not_offered";
  family_id: string | null;
  evidence: IndexRecord["evidence"];
  thin: boolean;
  /** The record as the source delivered it. */
  delivered: {
    source_record_id: string;
    title: string;
    provider: string;
    category: string;
    description: string | null;
    features: string[];
    themes: string[];
    tags: string[];
    facts: IndexRecord["canonical"]["facts"];
  };
  /** What each offline step added, in order. Every label carries the words it quoted. */
  steps: {
    cleaned: { title: string; description: string | null };
    table: { themes: TraceLabel[]; mechanics: TraceLabel[]; dropped: IndexRecord["table"]["dropped"]; unknown: IndexRecord["table"]["unknown"] };
    conflict: IndexRecord["conflict"];
    /** `used` says whether this version of the index takes the model's labels for this record. */
    model: { used: boolean; themes: TraceLabel[]; mechanics: TraceLabel[]; stripped: IndexRecord["model"]["stripped"] };
  };
  /** The descriptor fields of the served version. Null for `raw`, which has none. */
  fields: { themes: Field; mechanics: Field } | null;
  /** The text that was embedded for this version. */
  text: string;
}

export interface Trace {
  anchor: TraceAnchor | null;
  filters: FilterStep[];
  /** Every candidate that was scored, in rank order. A game that is not live on the brand is never here. */
  scores: Scored[];
  floor: number;
  floor_rule: string;
  timings_ms: Record<string, number>;
}

export interface Recommendation {
  request: { game_id: string; brand: string; limit: number };
  served: { version: Version; index_hash: string };
  outcome: "results" | "declined";
  decline: { reason: DeclineReason; detail: string } | null;
  results: Scored[];
  trace?: Trace;
}

export interface RecommendRequest {
  gameId: string;
  brand: string;
  limit?: number;
  trace?: boolean;
}

/** Raised for a request the service cannot read as a question at all. The HTTP wrapper answers it with a 400. */
export class BadRequest extends Error {}

const ref = (record: IndexRecord): GameRef => ({ game_id: record.game_id, title: record.canonical.title, provider: record.canonical.provider });

/** Two records are duplicates when one studio delivered the same title twice under different ids. */
function sameGame(a: IndexRecord, b: IndexRecord): boolean {
  const key = (record: IndexRecord): string => `${record.canonical.provider}\n${record.canonical.title}`.toLowerCase();
  return key(a) === key(b);
}

function modelUsed(record: IndexRecord, version: Version): boolean {
  return version === "model_everywhere" || (version === "model_where_thin" && record.thin);
}

function traceAnchor(record: IndexRecord, version: Version, status: OfferingStatus | "not_offered"): TraceAnchor {
  const { canonical } = record;
  const content = record.versions[version];
  return {
    ...ref(record),
    status_on_brand: status,
    family_id: canonical.family_id,
    evidence: record.evidence,
    thin: record.thin,
    delivered: {
      source_record_id: canonical.source.record_id,
      title: canonical.title_as_delivered,
      provider: canonical.provider,
      category: canonical.category_as_delivered,
      description: canonical.description_as_delivered,
      features: canonical.source_tags.features,
      themes: canonical.source_tags.themes,
      tags: canonical.merchandising_tags,
      facts: canonical.facts,
    },
    steps: {
      cleaned: { title: canonical.title, description: canonical.description },
      table: { themes: record.table.themes, mechanics: record.table.mechanics, dropped: record.table.dropped, unknown: record.table.unknown },
      conflict: record.conflict,
      model: { used: modelUsed(record, version), themes: record.model.themes, mechanics: record.model.mechanics, stripped: record.model.stripped },
    },
    fields: content.themes === null || content.mechanics === null ? null : { themes: content.themes, mechanics: content.mechanics },
    text: content.text,
  };
}

export function recommend(state: ServingState, request: RecommendRequest): Recommendation {
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}, got ${String(request.limit)}`);
  }
  if (request.gameId.length === 0) throw new BadRequest("game must not be empty");
  const statuses = state.offerings.statusByBrand.get(request.brand);
  if (statuses === undefined) {
    throw new BadRequest(`unknown brand "${request.brand}". Known brands: ${state.offerings.brands.join(", ")}`);
  }

  const timings: Record<string, number> = {};
  const started = performance.now();
  let mark = started;
  const lap = (stage: string): void => {
    const now = performance.now();
    timings[stage] = Math.round((now - mark) * 1000) / 1000;
    mark = now;
  };

  const filters: FilterStep[] = [];
  let scores: Scored[] = [];
  let anchor: TraceAnchor | null = null;

  const finish = (decline: DeclineReason | null, results: Scored[]): Recommendation => {
    timings["total"] = Math.round((performance.now() - started) * 1000) / 1000;
    const response: Recommendation = {
      request: { game_id: request.gameId, brand: request.brand, limit },
      served: { version: state.version, index_hash: state.indexHash },
      outcome: decline === null ? "results" : "declined",
      decline: decline === null ? null : { reason: decline, detail: DECLINE_SENTENCES[decline] },
      results: decline === null ? results : [],
    };
    if (request.trace === true) {
      response.trace = { anchor, filters, scores, floor: state.floor, floor_rule: `${FLOOR_RULE.id}: ${FLOOR_RULE.rule}`, timings_ms: timings };
    }
    return response;
  };

  // 1 to 3: the anchor.
  const anchorRow = state.rowById.get(request.gameId);
  const anchorRecord = anchorRow === undefined ? undefined : state.records[anchorRow];
  if (anchorRow === undefined || anchorRecord === undefined) {
    lap("lookup");
    return finish("unknown_game", []);
  }
  const anchorStatus = statuses.get(request.gameId) ?? "not_offered";
  if (request.trace === true) anchor = traceAnchor(anchorRecord, state.version, anchorStatus);
  lap("lookup");
  if (anchorStatus !== "live") return finish("anchor_not_available", []);
  if (anchorRecord.evidence === "none") return finish("insufficient_data", []);

  // 4: availability, before any score exists.
  let candidates: number[] = [];
  const notLive: Removal[] = [];
  state.records.forEach((record, row) => {
    const status = statuses.get(record.game_id) ?? "not_offered";
    if (status === "live") candidates.push(row);
    else notLive.push({ ...ref(record), why: status });
  });
  filters.push({
    filter: "not_live_on_brand",
    rule: `Only a game whose status on ${request.brand} is "live" may be recommended there.`,
    removed: notLive,
    remaining: candidates.length,
  });
  lap("availability");

  // 5 and 6: the anchor itself, its duplicates, and records with nothing to compare.
  const record = (row: number): IndexRecord => state.records[row] as IndexRecord;
  const duplicates: Removal[] = [];
  candidates = candidates.filter((row) => {
    if (row === anchorRow) duplicates.push({ ...ref(record(row)), why: "the game that was asked about" });
    else if (sameGame(record(row), anchorRecord)) duplicates.push({ ...ref(record(row)), why: "same studio and same title as the game that was asked about" });
    else return true;
    return false;
  });
  filters.push({
    filter: "anchor_or_duplicate",
    rule: "The game that was asked about is never recommended, and neither is a second record of it.",
    removed: duplicates,
    remaining: candidates.length,
  });
  const tooLittle: Removal[] = [];
  candidates = candidates.filter((row) => {
    if (record(row).evidence !== "none") return true;
    tooLittle.push({ ...ref(record(row)), why: "no description and no tag that maps to a label" });
    return false;
  });
  filters.push({
    filter: "insufficient_data",
    rule: "A record with no description and no mapped tag has nothing to be compared on.",
    removed: tooLittle,
    remaining: candidates.length,
  });
  lap("exclusions");

  // 7: score and rank. Only games that passed the availability filter are scored.
  scores = candidates
    .map((row) => ({ row, score: similarity(state.vectors, state.dimensions, anchorRow, row) }))
    .sort((a, b) => b.score - a.score || (record(a.row).game_id < record(b.row).game_id ? -1 : 1))
    .map(({ row, score }, position) => ({ ...ref(record(row)), rank: position + 1, score, family_id: record(row).canonical.family_id }));
  lap("scoring");

  // 8: the floor.
  let kept = scores.filter((entry) => entry.score >= state.floor);
  filters.push({
    filter: "below_floor",
    rule: `A candidate must score at least the floor, ${state.floor}.`,
    removed: scores.filter((entry) => entry.score < state.floor).map(({ game_id, title, provider, score }) => ({ game_id, title, provider, why: `score ${score}` })),
    remaining: kept.length,
  });
  if (kept.length === 0) {
    lap("floor_and_caps");
    return finish("nothing_above_floor", []);
  }

  // 9: at most one game of the anchor's own family.
  const familyId = anchorRecord.canonical.family_id;
  const overFamily: Removal[] = [];
  if (familyId !== null) {
    let seen = false;
    kept = kept.filter((entry) => {
      if (entry.family_id !== familyId) return true;
      if (!seen) {
        seen = true;
        return true;
      }
      overFamily.push({ game_id: entry.game_id, title: entry.title, provider: entry.provider, why: `a second game of family ${familyId}` });
      return false;
    });
  }
  filters.push({
    filter: "family_cap",
    rule: "At most one result may come from the same family as the game that was asked about.",
    removed: overFamily,
    remaining: kept.length,
  });

  // 10: the limit.
  const results = kept.slice(0, limit);
  filters.push({
    filter: "over_limit",
    rule: `At most ${limit} results are returned.`,
    removed: kept.slice(limit).map(({ game_id, title, provider, rank }) => ({ game_id, title, provider, why: `ranked ${rank}, past the limit` })),
    remaining: results.length,
  });
  lap("floor_and_caps");
  return finish(null, results);
}
