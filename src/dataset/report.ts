/**
 * Counts that describe a generated catalogue: how much of each kind of mess
 * it carries, what the offerings look like, and what the model calls cost.
 * All of it is derived from committed files, so it is reproducible.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MESS_KINDS, OFFERING_STATUSES, type MessKind, type OfferingStatus } from "./model.ts";
import type { Catalogue } from "./degrade.ts";
import { BRANDS, STUDIOS, studioById, type SlotPlan } from "./plan.ts";
import {
  MODEL,
  PRICE_PER_MILLION,
  PROMPT_VERSION,
  RETIRE_REASONS,
  estimateUsd,
  readResponseFile,
  readRetired,
  responseFileName,
  type AttemptOutcome,
  type RetireReason,
} from "./truth-writer.ts";

// ---------------------------------------------------------------------------
// Mess report
// ---------------------------------------------------------------------------

export interface MessReport {
  games: number;
  raw_rows: number;
  rows_by_mess: Record<MessKind, number>;
  clean_control_rows: number;
  /** A missing description arrives in three shapes; enrichment has to cope with each. */
  description_missing_forms: { absent_key: number; null: number; empty_string: number };
  rows_by_studio: Record<string, number>;
  families: { families: number; members: number };
  same_name_pairs: number;
  duplicate_pairs: number;
  offerings: {
    rows: number;
    by_brand: Record<string, Record<OfferingStatus, number>>;
    games_on_one_brand: number;
    games_withdrawn_somewhere: number;
    games_live_nowhere: number;
  };
}

export function buildMessReport(catalogue: Catalogue): MessReport {
  const { rawRecords, truthGames, truthRows, offerings } = catalogue;
  const descriptions = rawRecords.map((record) => record.payload.description);
  const familyIds = truthGames.flatMap((game) => (game.family_id === null ? [] : [game.family_id]));
  const offeringsByGame = Map.groupBy(offerings, (offering) => offering.game_id);
  const studioOfGame = new Map(truthGames.map((game) => [game.game_id, game.studio]));
  return {
    games: truthGames.length,
    raw_rows: truthRows.length,
    rows_by_mess: Object.fromEntries(
      MESS_KINDS.map((kind) => [kind, truthRows.filter((row) => row.mess.includes(kind)).length]),
    ) as Record<MessKind, number>,
    clean_control_rows: truthRows.filter((row) => row.clean_control).length,
    description_missing_forms: {
      absent_key: descriptions.filter((description) => description === undefined).length,
      null: descriptions.filter((description) => description === null).length,
      empty_string: descriptions.filter((description) => description === "").length,
    },
    rows_by_studio: Object.fromEntries(
      STUDIOS.map((studio) => [
        studio.name,
        truthRows.filter((row) => studioOfGame.get(row.game_id) === studio.name).length,
      ]),
    ),
    families: { families: new Set(familyIds).size, members: familyIds.length },
    same_name_pairs: truthGames.filter((game) => game.same_name_as !== null).length,
    duplicate_pairs: truthRows.filter((row) => row.duplicate_of !== null).length,
    offerings: {
      rows: offerings.length,
      by_brand: Object.fromEntries(
        BRANDS.map((brand) => [
          brand.id,
          Object.fromEntries(
            OFFERING_STATUSES.map((status) => [
              status,
              offerings.filter((offering) => offering.brand === brand.id && offering.status === status).length,
            ]),
          ) as Record<OfferingStatus, number>,
        ]),
      ),
      games_on_one_brand: [...offeringsByGame.values()].filter((rows) => rows.length === 1).length,
      games_withdrawn_somewhere: [...offeringsByGame.values()].filter((rows) =>
        rows.some((row) => row.status === "withdrawn"),
      ).length,
      games_live_nowhere: [...offeringsByGame.values()].filter((rows) => rows.every((row) => row.status !== "live")).length,
    },
  };
}

/**
 * The catalogue must be able to exercise everything downstream. Once it is
 * large enough to hold every hand-allocated scenario, a kind of mess with no
 * rows is a generator bug, not a detail.
 */
export function assertCoverage(report: MessReport): void {
  const missing: string[] = MESS_KINDS.filter((kind) => report.rows_by_mess[kind] === 0);
  if (report.clean_control_rows === 0) missing.push("clean_control");
  if (report.families.members < 2) missing.push("family with two members");
  if (report.same_name_pairs === 0) missing.push("same-name pair");
  if (report.duplicate_pairs === 0) missing.push("true duplicate");
  if (Object.keys(report.offerings.by_brand).filter((brand) => brandRows(report, brand) > 0).length < 2) {
    missing.push("offerings on two brands");
  }
  if (report.offerings.games_on_one_brand === 0) missing.push("game on a single brand");
  if (report.offerings.games_withdrawn_somewhere === 0) missing.push("withdrawn offering");
  if (report.games >= FULL_SIZE) {
    if (report.clean_control_rows < 5) missing.push(`five clean controls (found ${report.clean_control_rows})`);
    for (const [form, rows] of Object.entries(report.description_missing_forms)) {
      if (rows === 0) missing.push(`a missing description as ${form}`);
    }
  }
  if (missing.length > 0) throw new Error(`the catalogue is missing required cases: ${missing.join(", ")}`);
}

/** From this many games on, the catalogue is expected to hold enough of the rarer cases too. */
const FULL_SIZE = 80;

function brandRows(report: MessReport, brand: string): number {
  return Object.values(report.offerings.by_brand[brand] ?? {}).reduce((sum, count) => sum + count, 0);
}

// ---------------------------------------------------------------------------
// Plan summary (no model, no files): what a catalogue of this size would hold
// ---------------------------------------------------------------------------

export function summarisePlan(plan: readonly SlotPlan[]): Record<string, number> {
  const count = (test: (slotPlan: SlotPlan) => boolean): number => plan.filter(test).length;
  const noDescription = (slotPlan: SlotPlan): boolean =>
    slotPlan.mess.nearEmpty ||
    slotPlan.mess.description === "missing" ||
    studioById(slotPlan.studio).omits.includes("description");
  const roots = new Set(
    plan.flatMap((slotPlan) => (slotPlan.relation.kind === "variant_of" ? [slotPlan.relation.parent] : [])),
  );
  return {
    games: plan.length,
    raw_rows: plan.length + count((slotPlan) => slotPlan.mess.duplicateRow),
    description_missing: count(noDescription),
    description_boilerplate: count((s) => !noDescription(s) && s.mess.description === "boilerplate"),
    description_terse: count((s) => !noDescription(s) && s.mess.description === "terse"),
    description_non_english: count((s) => !noDescription(s) && studioById(s.studio).descriptionLocale === "de"),
    prompt_injection: count((s) => s.mess.injection),
    near_empty: count((s) => s.mess.nearEmpty),
    tags_removed: count((s) => !s.mess.nearEmpty && s.mess.tags === "removed"),
    tags_drift: count((s) => !s.mess.nearEmpty && s.mess.tags === "drift"),
    tags_one_dropped: count((s) => s.mess.tags === "one_dropped"),
    tags_conflict: count((s) => s.mess.tags === "conflict"),
    non_attribute_tags: count((s) => !s.mess.nearEmpty && s.mess.nonAttributes),
    title_decoration: count((s) => s.mess.titleDecoration !== "none"),
    duplicate_rows: count((s) => s.mess.duplicateRow),
    families: roots.size,
    family_members: roots.size + count((s) => s.relation.kind === "variant_of"),
    same_name_pairs: count((s) => s.relation.kind === "same_name_as"),
    ...Object.fromEntries(STUDIOS.map((studio) => [`studio_${studio.id}`, count((s) => s.studio === studio.id)])),
    ...Object.fromEntries(
      BRANDS.flatMap((brand) =>
        OFFERING_STATUSES.map((status) => [
          `offerings_${brand.id}_${status}`,
          count((s) => s.offerings.some(([offeredBy, offered]) => offeredBy === brand.id && offered === status)),
        ]),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Ledger of the model calls
// ---------------------------------------------------------------------------

export interface Ledger {
  model: string;
  prompt_version: string;
  price_per_million_usd: typeof PRICE_PER_MILLION;
  records: number;
  attempts: number;
  retries: number;
  attempts_by_outcome: Record<AttemptOutcome, number>;
  records_by_result: { succeeded_first_try: number; succeeded_after_retry: number; no_accepted_response: number };
  tokens: { input: number; cached_input: number; cache_write: number; output: number; reasoning: number };
  attempts_with_unknown_usage: number;
  /**
   * `committed_run` is what the stored responses cost. `retired_attempts` is what was spent on
   * responses that were later replaced: prompt revisions and names found to exist.
   */
  cost_usd: { committed_run: number; retired_attempts: number; total_spent: number };
  retired: {
    slots: number;
    attempts: number;
    tokens: { input: number; output: number };
    by_reason: Record<RetireReason, { slots: number; attempts: number; estimated_usd: number }>;
  };
  seconds: { total: number; per_record_mean: number; per_record_median: number; per_record_max: number };
  per_record: {
    slot: number;
    attempts: number;
    seconds: number;
    input_tokens: number;
    output_tokens: number;
    estimated_usd: number;
  }[];
}

export function buildLedger(responsesDir: string, retiredPath: string, plan: readonly SlotPlan[]): Ledger {
  const outcomes: Record<AttemptOutcome, number> = { ok: 0, invalid_output: 0, refusal: 0, incomplete: 0, api_error: 0 };
  const tokens = { input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning: 0 };
  const results = { succeeded_first_try: 0, succeeded_after_retry: 0, no_accepted_response: 0 };
  const perRecord: Ledger["per_record"] = [];
  let unknownUsage = 0;

  for (const slotPlan of plan) {
    const path = join(responsesDir, responseFileName(slotPlan.slot));
    if (!existsSync(path)) throw new Error(`cannot build the ledger: ${path} is missing`);
    const { attempts } = readResponseFile(path);
    const record = { slot: slotPlan.slot, attempts: attempts.length, seconds: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0 };
    for (const attempt of attempts) {
      outcomes[attempt.outcome] += 1;
      record.seconds += attempt.seconds;
      if (attempt.usage === null) {
        // An API error is not billed; any other attempt without usage is a hole in the ledger.
        if (attempt.outcome !== "api_error") unknownUsage += 1;
        continue;
      }
      const details = attempt.usage.input_tokens_details;
      tokens.input += attempt.usage.input_tokens;
      tokens.cached_input += details.cached_tokens;
      tokens.cache_write += details.cache_write_tokens;
      tokens.output += attempt.usage.output_tokens;
      tokens.reasoning += attempt.usage.output_tokens_details.reasoning_tokens;
      record.input_tokens += attempt.usage.input_tokens;
      record.output_tokens += attempt.usage.output_tokens;
      record.estimated_usd += estimateUsd(attempt.usage);
    }
    const acceptedAt = attempts.findIndex((attempt) => attempt.outcome === "ok");
    if (acceptedAt === 0) results.succeeded_first_try += 1;
    else if (acceptedAt > 0) results.succeeded_after_retry += 1;
    else results.no_accepted_response += 1;
    perRecord.push({ ...record, seconds: round(record.seconds, 3), estimated_usd: round(record.estimated_usd, 6) });
  }

  const seconds = perRecord.map((record) => record.seconds).sort((a, b) => a - b);
  const totalSeconds = seconds.reduce((sum, value) => sum + value, 0);
  const attempts = perRecord.reduce((sum, record) => sum + record.attempts, 0);
  const committedUsd = perRecord.reduce((sum, record) => sum + record.estimated_usd, 0);
  const retired = summariseRetired(retiredPath);
  const middle = Math.floor(seconds.length / 2);
  const median = seconds.length % 2 === 1 ? (seconds[middle] ?? 0) : ((seconds[middle - 1] ?? 0) + (seconds[middle] ?? 0)) / 2;
  return {
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    price_per_million_usd: PRICE_PER_MILLION,
    records: perRecord.length,
    attempts,
    retries: attempts - perRecord.length,
    attempts_by_outcome: outcomes,
    records_by_result: results,
    tokens,
    attempts_with_unknown_usage: unknownUsage,
    cost_usd: {
      committed_run: round(committedUsd, 6),
      retired_attempts: round(retired.usd, 6),
      total_spent: round(committedUsd + retired.usd, 6),
    },
    retired: retired.summary,
    seconds: {
      total: round(totalSeconds, 3),
      per_record_mean: round(totalSeconds / Math.max(perRecord.length, 1), 3),
      per_record_median: round(median, 3),
      per_record_max: round(seconds.at(-1) ?? 0, 3),
    },
    per_record: perRecord,
  };
}

function summariseRetired(retiredPath: string): { usd: number; summary: Ledger["retired"] } {
  const byReason = Object.fromEntries(
    RETIRE_REASONS.map((reason) => [reason, { slots: 0, attempts: 0, estimated_usd: 0 }]),
  ) as Ledger["retired"]["by_reason"];
  const tokens = { input: 0, output: 0 };
  const lines = readRetired(retiredPath);
  for (const line of lines) {
    const bucket = byReason[line.reason];
    bucket.slots += 1;
    bucket.attempts += line.attempts.length;
    for (const attempt of line.attempts) {
      if (attempt.usage === null) continue;
      tokens.input += attempt.usage.input_tokens;
      tokens.output += attempt.usage.output_tokens;
      bucket.estimated_usd += estimateUsd(attempt.usage);
    }
  }
  const usd = RETIRE_REASONS.reduce((sum, reason) => sum + byReason[reason].estimated_usd, 0);
  for (const reason of RETIRE_REASONS) byReason[reason].estimated_usd = round(byReason[reason].estimated_usd, 6);
  return {
    usd,
    summary: {
      slots: lines.length,
      attempts: lines.reduce((sum, line) => sum + line.attempts.length, 0),
      tokens,
      by_reason: byReason,
    },
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function formatTable(title: string, rows: readonly (readonly [string, string | number])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return [title, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join("\n");
}
