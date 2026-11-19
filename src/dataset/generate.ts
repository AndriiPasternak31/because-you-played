/**
 * Builds the catalogue.
 *
 *   node src/dataset/generate.ts --count 14            rebuild from committed responses (no key)
 *   node src/dataset/generate.ts --count 100 --live    also call the model for slots that have none
 *   node src/dataset/generate.ts --count 100 --plan-only   show what would be planned; writes nothing
 *   node src/dataset/generate.ts --count 100 --retire 41,57 --retire-reason name_replacement
 *                                                          drop stored responses so those slots are
 *                                                          regenerated, keeping what they cost
 *   node src/dataset/generate.ts --name-hash Word          print a blocked-name entry for a word
 *
 * A pilot and the full catalogue are the same command with a different count.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { z } from "zod";
import { degrade, type Catalogue } from "./degrade.ts";
import { OfferingSchema, RawRecordSchema, TruthGameSchema, TruthRowSchema, type TruthText } from "./model.ts";
import { DEFAULT_SEED, SCENARIO_COUNT, buildPlan, type SlotPlan } from "./plan.ts";
import { assertCoverage, buildLedger, buildMessReport, formatTable, summarisePlan } from "./report.ts";
import { sha256Hex } from "./rng.ts";
import { RETIRE_REASONS, nameHash, obtainTruthText, responseFileName, retireSlot, type RetireReason } from "./truth-writer.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      count: { type: "string" },
      seed: { type: "string", default: DEFAULT_SEED },
      live: { type: "boolean", default: false },
      "plan-only": { type: "boolean", default: false },
      retire: { type: "string" },
      "retire-reason": { type: "string" },
      "name-hash": { type: "string" },
      "max-usd": { type: "string", default: "0.90" },
      "data-dir": { type: "string", default: "data" },
    },
    strict: true,
  });
  if (values["name-hash"] !== undefined) {
    console.log(nameHash(values["name-hash"]));
    return;
  }
  if (values.count === undefined) throw new Error("--count is required, for example --count 14");
  const count = Number(values.count);
  const maxUsd = Number(values["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`--max-usd must be a positive number, got "${values["max-usd"]}"`);

  const plan = buildPlan(count, values.seed);
  if (values["plan-only"]) {
    console.log(formatTable(`Plan for ${count} games (seed "${values.seed}"), nothing written`, Object.entries(summarisePlan(plan))));
    return;
  }

  const generationDir = join(values["data-dir"], "generation");
  const retiredPath = join(generationDir, "retired-attempts.jsonl");
  if (values.retire !== undefined) {
    retire(values.retire, values["retire-reason"], plan, join(generationDir, "responses"), retiredPath);
    return;
  }
  const responsesDir = join(generationDir, "responses");
  let live: { apiKey: string; maxUsd: number; spentUsd: number } | null = null;
  if (values.live) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey === "") throw new Error("--live needs OPENAI_API_KEY in the environment");
    live = { apiKey, maxUsd, spentUsd: 0 };
  }

  // Sequential: a title is checked against every earlier one, and a sequel or a
  // same-name twin is briefed with the text of the game it relates to.
  const texts = new Map<number, TruthText>();
  for (const slotPlan of plan) {
    texts.set(slotPlan.slot, await obtainTruthText(slotPlan, texts, { responsesDir, live, log: console.log }));
  }

  const catalogue = degrade(plan, texts, values.seed);
  checkCatalogue(catalogue);
  const report = buildMessReport(catalogue);
  const ledger = buildLedger(responsesDir, retiredPath, plan);

  mkdirSync(generationDir, { recursive: true });
  const files: [string, string][] = [
    [join(values["data-dir"], "catalogue.raw.jsonl"), jsonLines(catalogue.rawRecords, RawRecordSchema)],
    [join(values["data-dir"], "offerings.jsonl"), jsonLines(catalogue.offerings, OfferingSchema)],
    [join(generationDir, "truth.games.jsonl"), jsonLines(catalogue.truthGames, TruthGameSchema)],
    [join(generationDir, "truth.rows.jsonl"), jsonLines(catalogue.truthRows, TruthRowSchema)],
    [join(generationDir, "mess-report.json"), `${JSON.stringify({ seed: values.seed, count, ...report }, null, 2)}\n`],
    [join(generationDir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`],
  ];
  for (const [path, content] of files) writeFileSync(path, content);

  console.log(formatTable(`\nRaw rows by kind of mess (${report.raw_rows} rows, ${report.games} games)`, [
    ...Object.entries(report.rows_by_mess),
    ["clean_control", report.clean_control_rows],
    [
      "description missing as",
      `absent key ${report.description_missing_forms.absent_key}, null ${report.description_missing_forms.null}, empty string ${report.description_missing_forms.empty_string}`,
    ],
  ]));
  console.log(formatTable("\nIdentity", [
    ["families", report.families.families],
    ["family members", report.families.members],
    ["same-name pairs (different studios)", report.same_name_pairs],
    ["true duplicate pairs (shared supplier id)", report.duplicate_pairs],
  ]));
  console.log(formatTable("\nRaw rows by studio", Object.entries(report.rows_by_studio)));
  console.log(formatTable(`\nOfferings (${report.offerings.rows} rows)`, [
    ...Object.entries(report.offerings.by_brand).map(
      ([brand, statuses]) => [brand, Object.entries(statuses).map(([status, n]) => `${status} ${n}`).join(", ")] as const,
    ),
    ["games on one brand only", report.offerings.games_on_one_brand],
    ["games withdrawn somewhere", report.offerings.games_withdrawn_somewhere],
    ["games live nowhere", report.offerings.games_live_nowhere],
  ]));
  console.log(formatTable(`\nModel ledger (${ledger.model}, prompt ${ledger.prompt_version})`, [
    ["records", ledger.records],
    ["attempts", ledger.attempts],
    ["retries", ledger.retries],
    ["attempts by outcome", Object.entries(ledger.attempts_by_outcome).map(([outcome, n]) => `${outcome} ${n}`).join(", ")],
    ["records by result", Object.entries(ledger.records_by_result).map(([result, n]) => `${result} ${n}`).join(", ")],
    ["tokens in", `${ledger.tokens.input} (cached ${ledger.tokens.cached_input}, cache write ${ledger.tokens.cache_write})`],
    ["tokens out", `${ledger.tokens.output} (reasoning ${ledger.tokens.reasoning})`],
    ["attempts with unknown usage", ledger.attempts_with_unknown_usage],
    ["cost of the committed run (USD)", ledger.cost_usd.committed_run.toFixed(4)],
    [
      "cost of retired attempts (USD)",
      `${ledger.cost_usd.retired_attempts.toFixed(4)} (${ledger.retired.attempts} attempts on ${ledger.retired.slots} replaced responses: ` +
        `${Object.entries(ledger.retired.by_reason).map(([reason, bucket]) => `${reason} ${bucket.estimated_usd.toFixed(4)}`).join(", ")})`,
    ],
    ["total spent (USD)", ledger.cost_usd.total_spent.toFixed(4)],
    ["seconds per record", `mean ${ledger.seconds.per_record_mean}, median ${ledger.seconds.per_record_median}, max ${ledger.seconds.per_record_max}`],
    ["seconds total", ledger.seconds.total],
  ]));
  console.log(formatTable("\nFiles written (sha256)", files.map(([path, content]) => [path, sha256Hex(content)] as const)));

  const expected = new Set(plan.map((slotPlan) => responseFileName(slotPlan.slot)));
  const unused = readdirSync(responsesDir).filter((name) => !expected.has(name));
  if (unused.length > 0) console.log(`\nNote: ${unused.length} response file(s) beyond --count ${count} were not used.`);

  if (count >= SCENARIO_COUNT) assertCoverage(report);
  else console.log(`\nCoverage check skipped: fewer than ${SCENARIO_COUNT} games cannot hold every required case.`);
}

/**
 * Drops the stored responses of the given slots, and of the sequels and same-name twins that
 * were briefed with their text, so that the next live run regenerates them.
 */
function retire(
  list: string,
  reason: string | undefined,
  plan: readonly SlotPlan[],
  responsesDir: string,
  retiredPath: string,
): void {
  if (reason === undefined || !(RETIRE_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`--retire needs --retire-reason, one of: ${RETIRE_REASONS.join(", ")}`);
  }
  const requested = list.split(",").map((item) => Number(item.trim()));
  const unknown = requested.filter((slot) => !Number.isInteger(slot) || plan[slot] === undefined);
  if (unknown.length > 0) throw new Error(`--retire names slots that are not in the plan: ${unknown.join(", ")}`);
  const dependents = plan
    .filter(
      ({ relation }) =>
        (relation.kind === "variant_of" && requested.includes(relation.parent)) ||
        (relation.kind === "same_name_as" && requested.includes(relation.twin)),
    )
    .map((slotPlan) => slotPlan.slot);
  for (const slot of [...new Set([...requested, ...dependents])].sort((a, b) => a - b)) {
    const attempts = retireSlot(responsesDir, retiredPath, slot, reason as RetireReason);
    console.log(attempts === null ? `slot ${slot}: nothing stored` : `slot ${slot}: retired ${attempts} attempt(s)`);
  }
}

/** Validates every record on its way out and serialises one per line. */
function jsonLines<Schema extends z.ZodType>(records: readonly unknown[], schema: Schema): string {
  return records.map((record) => `${JSON.stringify(schema.parse(record))}\n`).join("");
}

/** Cross-record checks that no single schema can express. */
function checkCatalogue(catalogue: Catalogue): void {
  const recordIds = catalogue.rawRecords.map((record) => record.source_record_id);
  if (new Set(recordIds).size !== recordIds.length) throw new Error("two raw rows share a source_record_id");

  const rowsPerGame = Map.groupBy(catalogue.rawRecords, (record) => record.payload.game_code);
  const duplicatedGames = new Set(catalogue.truthRows.filter((row) => row.duplicate_of !== null).map((row) => row.game_id));
  for (const [gameCode, rows] of rowsPerGame) {
    if ((rows.length > 1) !== duplicatedGames.has(gameCode) || rows.length > 2) {
      throw new Error(`game ${gameCode} has ${rows.length} raw rows, which does not match the planned duplicates`);
    }
  }
  for (const offering of catalogue.offerings) {
    if (!rowsPerGame.has(offering.game_id)) throw new Error(`offering refers to unknown game ${offering.game_id}`);
  }
  for (const game of catalogue.truthGames) {
    if (!rowsPerGame.has(game.game_id)) throw new Error(`truth game ${game.game_id} has no raw row`);
  }
}

main().catch((error: unknown) => {
  console.error(`\ndataset generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
