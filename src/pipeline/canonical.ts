/**
 * Raw rows to canonical records. Deterministic code only: no model is involved,
 * and this module imports nothing that calls one.
 *
 * It answers the record-model questions that `data/README.md` leaves open:
 *   - the game id is the supplier game code, so two rows sharing a code are one game;
 *   - of two such rows the later `fetched_at` wins, and the other is recorded as superseded;
 *   - the title is the delivered one without trademark signs; its case is left alone;
 *   - an absent, null, empty or blank description all mean "no description";
 *   - the description is cleaned of markup and kept in its own language, facts included;
 *   - the two attribute tag lists stay two lists, verbatim, and merchandising tags stay apart;
 *   - a family is carried only when the feed supplies one, and never inferred;
 *   - facts are carried exactly as delivered and never parsed.
 */
import { z } from "zod";
import { RawRecordSchema, type RawRecord } from "../dataset/model.ts";
import { readJsonLines } from "./io.ts";

/** Facts of record. Their values are copied from the raw payload and never interpreted. */
export const FACT_KEYS = [
  "rtp",
  "volatility",
  "grid",
  "lines",
  "ways",
  "max_win",
  "min_bet",
  "max_bet",
  "release_date",
  "bonus_buy",
] as const;

const FactValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const CanonicalRecordSchema = z.strictObject({
  game_id: z.string().min(1),
  source: z.strictObject({
    system: z.string(),
    record_id: z.string(),
    fetched_at: z.string(),
    /** Earlier rows for the same game code, which this row replaced. */
    superseded_record_ids: z.array(z.string()),
  }),
  title: z.string().min(1),
  title_as_delivered: z.string(),
  provider: z.string(),
  category_as_delivered: z.string(),
  family_id: z.string().nullable(),
  /** Cleaned of markup. Null when the feed gave none. Evidence quotes are checked against this text. */
  description: z.string().nullable(),
  description_as_delivered: z.string().nullable(),
  source_tags: z.strictObject({ features: z.array(z.string()), themes: z.array(z.string()) }),
  merchandising_tags: z.array(z.string()),
  facts: z.partialRecord(z.enum(FACT_KEYS), FactValueSchema),
});
export type CanonicalRecord = z.infer<typeof CanonicalRecordSchema>;

export function readRawCatalogue(path: string): RawRecord[] {
  return readJsonLines(path, (value, source) => {
    const parsed = RawRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${source} is not a raw record: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  });
}

export function cleanTitle(delivered: string): string {
  return delivered.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

const ENTITIES: readonly (readonly [string, string])[] = [
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&nbsp;", " "],
  // Last, so that an escaped ampersand is not decoded twice.
  ["&amp;", "&"],
];

/** Removes markup and decodes entities. A paragraph break becomes one space. Null when nothing is left. */
export function cleanDescription(delivered: string | null | undefined): string | null {
  if (delivered == null) return null;
  const withoutTags = delivered.replace(/<\/p>\s*<p>/gi, " ").replace(/<\/?[a-z][^>]*>/gi, "");
  const text = ENTITIES.reduce((plain, [entity, raw]) => plain.replaceAll(entity, raw), withoutTags).trim();
  return text.length === 0 ? null : text;
}

function canonicalise(row: RawRecord, superseded: readonly RawRecord[]): CanonicalRecord {
  const { payload } = row;
  const facts: CanonicalRecord["facts"] = {};
  for (const key of FACT_KEYS) {
    const value = payload[key];
    if (value !== undefined) facts[key] = value;
  }
  const delivered = payload.description == null || payload.description.trim().length === 0 ? null : payload.description;
  return {
    game_id: payload.game_code,
    source: {
      system: row.source_system,
      record_id: row.source_record_id,
      fetched_at: row.fetched_at,
      superseded_record_ids: superseded.map((other) => other.source_record_id),
    },
    title: cleanTitle(payload.name),
    title_as_delivered: payload.name,
    provider: payload.provider,
    category_as_delivered: payload.category,
    family_id: payload.family ?? null,
    description: cleanDescription(delivered),
    description_as_delivered: delivered,
    source_tags: { features: [...(payload.features ?? [])], themes: [...(payload.themes ?? [])] },
    merchandising_tags: (payload.tags ?? []).map((tag) => tag.name),
    facts,
  };
}

/** One canonical record per game code, sorted by game id. */
export function canonicaliseCatalogue(rows: readonly RawRecord[]): CanonicalRecord[] {
  const recordIds = new Set<string>();
  for (const row of rows) {
    if (recordIds.has(row.source_record_id)) throw new Error(`two raw rows share the record id ${row.source_record_id}`);
    recordIds.add(row.source_record_id);
  }
  const records: CanonicalRecord[] = [];
  for (const [gameCode, group] of Map.groupBy(rows, (row) => row.payload.game_code)) {
    const newestFirst = [...group].sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at));
    const [winner, ...superseded] = newestFirst;
    if (winner === undefined) throw new Error(`game ${gameCode} has no row`);
    const tied = superseded.filter((other) => Date.parse(other.fetched_at) === Date.parse(winner.fetched_at));
    if (tied.length > 0) {
      throw new Error(
        `game ${gameCode} has rows fetched at the same time (${[winner, ...tied].map((row) => row.source_record_id).join(", ")}), ` +
          "so the rule that the later row wins cannot choose between them",
      );
    }
    records.push(canonicalise(winner, superseded));
  }
  return records.sort((a, b) => (a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : 0));
}
