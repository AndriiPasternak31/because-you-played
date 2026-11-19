/**
 * Builds the index from the raw catalogue.
 *
 *   node src/pipeline/build.ts                        rebuild from the stored responses: no key, no network
 *   node src/pipeline/build.ts --live --max-usd 2.5   also call the models where no response is stored
 *   node src/pipeline/build.ts --live --limit 5       enrich the first five records, print the answers, write no index
 *   node src/pipeline/build.ts --validate             load the committed index and check all of it
 *
 * `--data-dir` points at another copy of the data, which is how the tests rebuild in a scratch directory.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { canonicaliseCatalogue, readRawCatalogue, type CanonicalRecord } from "./canonical.ts";
import { Budget, httpTransport, type Live } from "./costs.ts";
import { obtainEmbeddings, shareVectors, type EmbeddingFile } from "./embed.ts";
import { instructions, obtainEnrichment, type EnrichmentFile, type ModelOutput } from "./enrich.ts";
import { loadIndex, writeIndex, type IndexRecord, type Manifest } from "./index-store.ts";
import { readBytes, sha256 } from "./io.ts";
import { buildLedger, buildReport, formatLedger, storedSpend, type BuildReport, type Ledger } from "./report.ts";
import { applyTable } from "./synonyms.ts";
import { VERSIONS, buildVersions, evidenceLevel, findConflict, isQuotedFromText, isThin, type Version } from "./versions.ts";

/** The spend limit a live run gets when none is given, in USD, counting what is already stored. */
export const DEFAULT_MAX_USD = 2.5;
const LIVE_CALLS_AT_ONCE = 8;

export const paths = (dataDir: string) => ({
  catalogue: join(dataDir, "catalogue.raw.jsonl"),
  responses: join(dataDir, "pipeline", "responses"),
  index: join(dataDir, "index"),
});

/** One index record: the canonical record, what the table and the model each found, and the four versions. */
export function assembleRecord(canonical: CanonicalRecord, model: ModelOutput): IndexRecord {
  const table = applyTable(canonical);
  const detected = findConflict(canonical, table);
  const versions = buildVersions(canonical, table, model);
  return {
    game_id: canonical.game_id,
    canonical,
    evidence: evidenceLevel(canonical, table),
    table,
    conflict:
      detected === null
        ? null
        : {
            ...detected,
            model_reading_used: versions.model_everywhere.mechanics?.status === "asserted",
            model_labels_withheld: model.mechanics.filter((label) => !isQuotedFromText(label)),
          },
    thin: isThin(canonical, table),
    model,
    versions,
  };
}

/** Runs `work` over the items, a few at a time. Stops handing out work at the first failure and rethrows it. */
async function inParallel<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Map<number, R>();
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const position = next;
      next += 1;
      const item = items[position];
      if (item === undefined) return;
      try {
        results.set(position, await work(item));
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failures.length > 0) throw failures[0];
  return items.map((_, position) => results.get(position) as R);
}

export interface BuildOptions {
  dataDir: string;
  /** Null rebuilds from stored responses only. */
  live: Live | null;
  /** Enrich only the first records, and stop before embedding. Nothing is written but stored responses. */
  limit?: number;
  log: (line: string) => void;
}

export interface BuildResult {
  manifest: Manifest | null;
  records: IndexRecord[];
  ledger: Ledger | null;
  report: BuildReport | null;
}

export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const { catalogue, responses, index } = paths(options.dataDir);
  const rows = readRawCatalogue(catalogue);
  const canonical = canonicaliseCatalogue(rows);
  const wanted = options.limit === undefined ? canonical : canonical.slice(0, options.limit);

  const enrichmentFiles = new Map<string, EnrichmentFile>();
  const records = await inParallel(wanted, options.live === null ? 1 : LIVE_CALLS_AT_ONCE, async (record) => {
    const { output, file } = await obtainEnrichment(record, { responsesDir: responses, live: options.live, log: options.log });
    enrichmentFiles.set(record.game_id, file);
    return assembleRecord(record, output);
  });
  if (options.limit !== undefined) return { manifest: null, records, ledger: null, report: null };

  const ownVectors = {} as Record<Version, Buffer>;
  const textHashes = {} as Record<Version, string[]>;
  const embeddingFiles = {} as Record<Version, EmbeddingFile>;
  for (const version of VERSIONS) {
    const items = records.map((record) => ({ game_id: record.game_id, text: record.versions[version].text }));
    const { bytes, file } = await obtainEmbeddings(version, items, { responsesDir: responses, live: options.live, log: options.log });
    ownVectors[version] = bytes;
    textHashes[version] = records.map((record) => record.versions[version].text_sha256);
    embeddingFiles[version] = file;
  }
  const { vectors, taken } = shareVectors(textHashes, ownVectors);

  const ledger = buildLedger(records, enrichmentFiles, embeddingFiles, responses);
  const report = buildReport(rows.length, records, enrichmentFiles, taken);
  const manifest = writeIndex(index, {
    catalogue: { sha256: sha256(readBytes(catalogue)), raw_rows: rows.length },
    promptSha256: sha256(instructions()),
    records,
    vectors,
    ledger,
    report,
  });
  return { manifest, records, ledger, report };
}

function describeLabels(record: IndexRecord): string {
  const side = (labels: IndexRecord["model"]["themes"]): string =>
    labels.length === 0 ? "(none)" : labels.map((label) => `${label.label} <- ${label.source_field}: "${label.quote}"`).join("; ");
  return (
    `${record.game_id}  ${record.canonical.title}\n  themes: ${side(record.model.themes)}\n  mechanics: ${side(record.model.mechanics)}` +
    (record.model.stripped.length === 0
      ? ""
      : `\n  stripped: ${record.model.stripped.map((entry) => `${entry.label} (${entry.reason}: "${entry.quote}")`).join("; ")}`)
  );
}

function printSummary(manifest: Manifest, report: BuildReport, ledger: Ledger, where: string): void {
  const { table, enrichment } = report;
  console.log(`\nIndex ${manifest.index_hash} at ${where}`);
  console.log(
    `  format ${manifest.format_version}, ${manifest.game_ids.length} games from ${report.raw_rows} raw rows, ` +
      `${manifest.dimensions} dimensions, models ${manifest.models.enrichment} and ${manifest.models.embedding}, ` +
      `prompt ${manifest.prompt_version}, thin rule ${manifest.thin_rule.id}`,
  );
  console.log(
    `\nSynonym table: ${table.tags_seen} tags seen, ${table.mapped_to_a_label} mapped, ${table.dropped_non_attribute} non-attribute dropped, ` +
      `${table.dropped_merchandising} merchandising dropped, ${table.unknown} unknown`,
  );
  for (const entry of table.unknown_tags) console.log(`  unknown: "${entry.tag}" in ${entry.source_field} (${entry.game_ids.join(", ")})`);
  console.log(`Thin records: ${report.thin_records}. Conflicts: ${report.conflicts.length}.`);
  console.log(
    `Model answers: ${Object.entries(enrichment.calls_by_outcome).map(([outcome, count]) => `${outcome} ${count}`).join(", ")}; ` +
      `labels kept ${enrichment.labels_kept}; stripped ${Object.entries(enrichment.labels_stripped).map(([reason, count]) => `${reason} ${count}`).join(", ")}; ` +
      `records with no accepted answer ${enrichment.records_without_an_accepted_answer.length}`,
  );
  console.log(`\nLedger\n${formatLedger(ledger)}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", default: "data" },
      live: { type: "boolean", default: false },
      "max-usd": { type: "string", default: String(DEFAULT_MAX_USD) },
      limit: { type: "string" },
      validate: { type: "boolean", default: false },
    },
    strict: true,
  });
  const { catalogue, responses, index } = paths(values["data-dir"]);
  if (values.validate) {
    const loaded = loadIndex(index, { cataloguePath: catalogue });
    printSummary(loaded.manifest, loaded.report, loaded.ledger, index);
    console.log("\nThe index is valid and was built from this catalogue.");
    return;
  }

  let live: Live | null = null;
  if (values.live) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey === "") throw new Error("--live needs OPENAI_API_KEY in the environment");
    live = { apiKey, budget: new Budget(Number(values["max-usd"]), storedSpend(responses).total_usd), transport: httpTransport, retryDelayMs: 2000 };
  }
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit must be a positive whole number, got "${values.limit}"`);
  }

  try {
    const result = await runBuild({ dataDir: values["data-dir"], live, ...(limit === undefined ? {} : { limit }), log: console.log });
    if (result.manifest === null || result.report === null || result.ledger === null) {
      for (const record of result.records) console.log(describeLabels(record));
      console.log(`\n${result.records.length} record(s) enriched. No index was written.`);
    } else {
      printSummary(result.manifest, result.report, result.ledger, index);
    }
  } finally {
    if (live !== null) console.log(`\nStored responses have cost $${storedSpend(responses).total_usd.toFixed(6)} of the $${live.budget.maxUsd.toFixed(2)} limit.`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\npipeline build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
