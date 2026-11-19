/**
 * The ledger (calls, tokens, estimated cost and seconds per version) and the build report
 * (what the table dropped and did not know, what was stripped from the model's answers).
 * Both are computed from the stored responses and the built records, so a rebuild repeats them.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PRICES, embeddingUsd, enrichmentUsd } from "./costs.ts";
import { embeddingPath, readEmbeddingFile, type EmbeddingFile } from "./embed.ts";
import { ATTEMPT_OUTCOMES, PROMPT_VERSION, STRIP_REASONS, readEnrichmentFile, type AttemptOutcome, type EnrichmentFile } from "./enrich.ts";
import type { IndexRecord } from "./index-store.ts";
import { EVIDENCE_LEVELS, VERSIONS, type EvidenceLevel, type Version } from "./versions.ts";

const usd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const seconds = (value: number): number => Math.round(value * 1000) / 1000;

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface EnrichmentCost {
  /** Records whose text this version sends to the model. */
  records: number;
  calls: number;
  calls_by_outcome: Record<AttemptOutcome, number>;
  calls_with_unknown_usage: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  estimated_usd: number;
  /** Call durations added up. Calls ran side by side, so this is not time on the clock. */
  seconds: number;
}

export interface VersionLedger {
  enrichment: EnrichmentCost;
  embedding: { calls: number; texts: number; tokens: number; estimated_usd: number; seconds: number };
  estimated_usd: number;
  seconds: number;
}

export interface Ledger {
  prices: typeof PRICES;
  /** What each version would cost to build on its own. The two model versions share stored answers, so these do not add up to `spent`. */
  versions: Record<Version, VersionLedger>;
  /** Every stored response counted once: what building all four versions cost. */
  spent: {
    enrichment_usd_by_prompt_version: Record<string, number>;
    embedding_usd: number;
    total_usd: number;
  };
}

function enrichmentCost(files: readonly EnrichmentFile[]): EnrichmentCost {
  const cost: EnrichmentCost = {
    records: files.length,
    calls: 0,
    calls_by_outcome: Object.fromEntries(ATTEMPT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<AttemptOutcome, number>,
    calls_with_unknown_usage: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    estimated_usd: 0,
    seconds: 0,
  };
  for (const attempt of files.flatMap((file) => file.attempts)) {
    cost.calls += 1;
    cost.calls_by_outcome[attempt.outcome] += 1;
    cost.seconds += attempt.seconds;
    if (attempt.usage === null) {
      // An API error reports no usage and costs nothing. A 200 without usage is a cost nobody can state.
      if (attempt.outcome !== "api_error") cost.calls_with_unknown_usage += 1;
      continue;
    }
    cost.input_tokens += attempt.usage.input_tokens;
    cost.cached_input_tokens += attempt.usage.input_tokens_details.cached_tokens;
    cost.output_tokens += attempt.usage.output_tokens;
    cost.estimated_usd += enrichmentUsd(attempt.usage);
  }
  cost.estimated_usd = usd(cost.estimated_usd);
  cost.seconds = seconds(cost.seconds);
  return cost;
}

/** What every stored response under `responsesDir` cost, each counted once. */
export function storedSpend(responsesDir: string): Ledger["spent"] {
  const byPromptVersion: Record<string, number> = {};
  const enrichmentRoot = join(responsesDir, "enrichment");
  for (const promptVersion of existsSync(enrichmentRoot) ? readdirSync(enrichmentRoot).sort() : []) {
    const dir = join(enrichmentRoot, promptVersion);
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readEnrichmentFile(join(dir, name)));
    byPromptVersion[promptVersion] = enrichmentCost(files).estimated_usd;
  }
  let embedding = 0;
  for (const version of VERSIONS) {
    const path = embeddingPath(responsesDir, version);
    if (!existsSync(path)) continue;
    const file = readEmbeddingFile(path);
    embedding += embeddingUsd(file.usage) + file.superseded.reduce((sum, earlier) => sum + embeddingUsd(earlier.usage), 0);
  }
  const total = Object.values(byPromptVersion).reduce((sum, value) => sum + value, 0) + embedding;
  return { enrichment_usd_by_prompt_version: byPromptVersion, embedding_usd: usd(embedding), total_usd: usd(total) };
}

export function buildLedger(
  records: readonly IndexRecord[],
  enrichmentFiles: ReadonlyMap<string, EnrichmentFile>,
  embeddingFiles: Record<Version, EmbeddingFile>,
  responsesDir: string,
): Ledger {
  const filesFor = (wanted: (record: IndexRecord) => boolean): EnrichmentFile[] =>
    records.filter(wanted).map((record) => {
      const file = enrichmentFiles.get(record.game_id);
      if (file === undefined) throw new Error(`no enrichment file for ${record.game_id}, so the ledger cannot count it`);
      return file;
    });
  const sentToModel: Record<Version, (record: IndexRecord) => boolean> = {
    raw: () => false,
    table: () => false,
    model_where_thin: (record) => record.thin,
    model_everywhere: () => true,
  };
  const versions = Object.fromEntries(
    VERSIONS.map((version) => {
      const enrichment = enrichmentCost(filesFor(sentToModel[version]));
      const file = embeddingFiles[version];
      const embedding = {
        calls: 1,
        texts: records.length,
        tokens: file.usage.total_tokens,
        estimated_usd: usd(embeddingUsd(file.usage)),
        seconds: file.seconds,
      };
      const entry: VersionLedger = {
        enrichment,
        embedding,
        estimated_usd: usd(enrichment.estimated_usd + embedding.estimated_usd),
        seconds: seconds(enrichment.seconds + embedding.seconds),
      };
      return [version, entry];
    }),
  ) as Record<Version, VersionLedger>;
  return { prices: PRICES, versions, spent: storedSpend(responsesDir) };
}

export function formatLedger(ledger: Ledger): string {
  const rows = VERSIONS.map((version) => {
    const { enrichment, embedding, estimated_usd, seconds: total } = ledger.versions[version];
    return [
      version,
      String(enrichment.calls),
      String(enrichment.input_tokens),
      String(enrichment.output_tokens),
      String(embedding.calls),
      String(embedding.tokens),
      estimated_usd.toFixed(6),
      total.toFixed(1),
    ];
  });
  const header = ["version", "model calls", "tokens in", "tokens out", "embed calls", "embed tokens", "est. USD", "seconds"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [
    line(header),
    ...rows.map(line),
    `spent, every stored response counted once: $${ledger.spent.total_usd.toFixed(6)} ` +
      `(enrichment ${Object.entries(ledger.spent.enrichment_usd_by_prompt_version)
        .map(([promptVersion, value]) => `${promptVersion} $${value.toFixed(6)}`)
        .join(", ")}; embeddings $${ledger.spent.embedding_usd.toFixed(6)})`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

export interface BuildReport {
  games: number;
  raw_rows: number;
  rows_superseded_by_a_later_row: number;
  records_by_evidence: Record<EvidenceLevel, number>;
  table: {
    tags_seen: number;
    mapped_to_a_label: number;
    dropped_non_attribute: number;
    dropped_merchandising: number;
    unknown: number;
    /** Every tag the table did not know, with the games it came from. Never guessed. */
    unknown_tags: { tag: string; source_field: string; game_ids: string[] }[];
  };
  conflicts: { game_id: string; tag: string; description_quote: string }[];
  thin_records: number;
  enrichment: {
    prompt_version: string;
    records: number;
    calls_by_outcome: Record<AttemptOutcome, number>;
    records_without_an_accepted_answer: string[];
    labels_kept: number;
    labels_stripped: Record<(typeof STRIP_REASONS)[number], number>;
    fields_abstained: { themes: number; mechanics: number };
  };
  /** Per version: labels in the text, and fields that add nothing to it. */
  versions: Record<Version, { labels: number; fields_abstained: number; fields_in_conflict: number } | null>;
}

export function buildReport(
  rawRows: number,
  records: readonly IndexRecord[],
  enrichmentFiles: ReadonlyMap<string, EnrichmentFile>,
): BuildReport {
  const count = <T>(items: readonly T[], test: (item: T) => boolean): number => items.filter(test).length;
  const tableOutputs = records.map((record) => record.table);
  const unknown = new Map<string, { tag: string; source_field: string; game_ids: string[] }>();
  for (const record of records) {
    for (const entry of record.table.unknown) {
      const key = `${entry.source_field}\u0000${entry.tag}`;
      const listed = unknown.get(key) ?? { tag: entry.tag, source_field: entry.source_field, game_ids: [] };
      listed.game_ids.push(record.game_id);
      unknown.set(key, listed);
    }
  }
  const mapped = records.reduce(
    (sum, record) =>
      sum +
      record.canonical.source_tags.features.length +
      record.canonical.source_tags.themes.length -
      count(record.table.dropped, (entry) => entry.reason === "non_attribute") -
      record.table.unknown.length,
    0,
  );
  const dropped = tableOutputs.flatMap((output) => output.dropped);
  const stripped = records.flatMap((record) => record.model.stripped);
  const fields = (version: Version) => records.flatMap((record) => [record.versions[version].themes, record.versions[version].mechanics]);
  return {
    games: records.length,
    raw_rows: rawRows,
    rows_superseded_by_a_later_row: records.reduce((sum, record) => sum + record.canonical.source.superseded_record_ids.length, 0),
    records_by_evidence: Object.fromEntries(
      EVIDENCE_LEVELS.map((level) => [level, count(records, (record) => record.evidence === level)]),
    ) as Record<EvidenceLevel, number>,
    table: {
      tags_seen: records.reduce(
        (sum, record) =>
          sum + record.canonical.source_tags.features.length + record.canonical.source_tags.themes.length + record.canonical.merchandising_tags.length,
        0,
      ),
      mapped_to_a_label: mapped,
      dropped_non_attribute: count(dropped, (entry) => entry.reason === "non_attribute"),
      dropped_merchandising: count(dropped, (entry) => entry.reason === "merchandising"),
      unknown: tableOutputs.reduce((sum, output) => sum + output.unknown.length, 0),
      unknown_tags: [...unknown.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)),
    },
    conflicts: records.flatMap((record) =>
      record.conflict === null
        ? []
        : [{ game_id: record.game_id, tag: record.conflict.tag, description_quote: record.conflict.description_quote }],
    ),
    thin_records: count(records, (record) => record.thin),
    enrichment: {
      prompt_version: PROMPT_VERSION,
      records: records.length,
      calls_by_outcome: enrichmentCost([...enrichmentFiles.values()]).calls_by_outcome,
      records_without_an_accepted_answer: records
        .filter((record) => record.model.outcome === "no_accepted_response")
        .map((record) => record.game_id),
      labels_kept: records.reduce((sum, record) => sum + record.model.themes.length + record.model.mechanics.length, 0),
      labels_stripped: Object.fromEntries(
        STRIP_REASONS.map((reason) => [reason, count(stripped, (entry) => entry.reason === reason)]),
      ) as BuildReport["enrichment"]["labels_stripped"],
      fields_abstained: {
        themes: count(records, (record) => record.model.outcome === "accepted" && record.model.themes.length === 0),
        mechanics: count(records, (record) => record.model.outcome === "accepted" && record.model.mechanics.length === 0),
      },
    },
    versions: Object.fromEntries(
      VERSIONS.map((version) => [
        version,
        version === "raw"
          ? null
          : {
              labels: fields(version).reduce((sum, field) => sum + (field?.labels.length ?? 0), 0),
              fields_abstained: count(fields(version), (field) => field?.status === "abstained"),
              fields_in_conflict: count(fields(version), (field) => field?.status === "conflict"),
            },
      ]),
    ) as BuildReport["versions"],
  };
}
