/**
 * The synonym table: delivered tags mapped onto the 24 labels by lookup. No model.
 *
 * A tag is normalised (lower case, "&" read as "and", punctuation read as a
 * space) and looked up. It is then one of three things: a label, a known
 * non-attribute that is dropped, or unknown. An unknown tag is counted and
 * listed. It is never guessed: there is no fuzzy match and no fallback.
 *
 * The table was written against the tags seen in this catalogue. A new feed
 * will bring spellings it does not know, and they will show up as unknown.
 */
import { z } from "zod";
import { MECHANICS, THEMES, isTheme, type Mechanic, type Term, type Theme } from "../dataset/vocabulary.ts";
import type { CanonicalRecord } from "./canonical.ts";

const SPELLINGS: Record<Term, readonly string[]> = {
  // Mechanics
  paylines: ["paylines", "pay lines", "win lines"],
  ways: ["ways", "ways to win", "all ways"],
  cluster_pays: ["cluster pays", "clusterpays", "cluster wins"],
  free_spins: ["free spins", "freespins", "fs"],
  multipliers: ["multiplier", "multipliers", "win multipliers"],
  cascading_reels: ["cascading reels", "cascades", "avalanche", "tumbling reels"],
  expanding_wilds: ["expanding wild", "expanding wilds", "wild expansion"],
  sticky_wilds: ["sticky wild", "sticky wilds", "locked wilds"],
  hold_and_respin: ["hold and respin", "hold and win"],
  pick_bonus: ["pick bonus", "bonus pick", "pick and click bonus"],
  progressive_jackpot: ["progressive jackpot", "progressive jackpots"],
  mystery_symbols: ["mystery symbol", "mystery symbols", "mystery reveal"],
  // Themes
  ancient_egypt: ["ancient egypt", "egyptian"],
  mythology: ["mythology", "myths and legends"],
  fantasy: ["fantasy", "magic and fantasy"],
  animals: ["animal", "animals"],
  adventure: ["adventure", "adventures"],
  classic_fruit: ["classic fruit", "fruit machine", "fruits"],
  east_asian: ["east asian", "asian", "asia"],
  irish_luck: ["irish luck", "irish"],
  western: ["western", "wild west"],
  horror: ["horror", "dark and horror", "spooky"],
  ocean_fishing: ["ocean and fishing", "ocean"],
  sci_fi: ["sci fi", "space"],
};

/** Entries of the attribute lists that say nothing about what the game is. */
const NON_ATTRIBUTES: readonly string[] = [
  "high rtp",
  "rtp range",
  "high volatility",
  "medium volatility",
  "mobile friendly",
  "new games",
  "popular",
  "top games",
  "video slots",
];

export function normaliseTag(tag: string): string {
  return tag
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type Lookup = { kind: "label"; label: Term } | { kind: "non_attribute" };

function buildTable(): ReadonlyMap<string, Lookup> {
  const table = new Map<string, Lookup>();
  const add = (spelling: string, entry: Lookup): void => {
    if (normaliseTag(spelling) !== spelling) throw new Error(`synonym table entry "${spelling}" is not in normalised form`);
    if (table.has(spelling)) throw new Error(`synonym table lists "${spelling}" twice`);
    table.set(spelling, entry);
  };
  for (const label of [...THEMES, ...MECHANICS]) {
    for (const spelling of SPELLINGS[label]) add(spelling, { kind: "label", label });
  }
  for (const spelling of NON_ATTRIBUTES) add(spelling, { kind: "non_attribute" });
  return table;
}

const TABLE = buildTable();

export const SOURCE_FIELDS = ["title", "description", "features", "themes"] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];

/**
 * One asserted label with the words behind it and where they came from.
 * `quote` is found word for word in `source_field` of the canonical record.
 */
export const LabelSchema = z.strictObject({
  label: z.enum([...THEMES, ...MECHANICS]),
  quote: z.string().min(1),
  source_field: z.enum(SOURCE_FIELDS),
  method: z.enum(["synonym_table", "model"]),
  /** The model that asserted it, and the prompt it was given. Null for the table. */
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
});
export type Label = z.infer<typeof LabelSchema>;

export const TableOutputSchema = z.strictObject({
  themes: z.array(LabelSchema),
  mechanics: z.array(LabelSchema),
  dropped: z.array(
    z.strictObject({
      tag: z.string(),
      source_field: z.enum(["features", "themes", "tags"]),
      reason: z.enum(["non_attribute", "merchandising"]),
    }),
  ),
  unknown: z.array(z.strictObject({ tag: z.string(), source_field: z.enum(["features", "themes"]) })),
});
export type TableOutput = z.infer<typeof TableOutputSchema>;

/** Applies the table to one record. A label keeps the first tag that mapped to it. */
export function applyTable(record: CanonicalRecord): TableOutput {
  const output: TableOutput = { themes: [], mechanics: [], dropped: [], unknown: [] };
  const seen = new Set<Term>();
  for (const sourceField of ["features", "themes"] as const) {
    for (const tag of record.source_tags[sourceField]) {
      const entry = TABLE.get(normaliseTag(tag));
      if (entry === undefined) {
        output.unknown.push({ tag, source_field: sourceField });
      } else if (entry.kind === "non_attribute") {
        output.dropped.push({ tag, source_field: sourceField, reason: "non_attribute" });
      } else if (!seen.has(entry.label)) {
        seen.add(entry.label);
        const label: Label = {
          label: entry.label,
          quote: tag,
          source_field: sourceField,
          method: "synonym_table",
          model: null,
          prompt_version: null,
        };
        (isTheme(entry.label) ? output.themes : output.mechanics).push(label);
      }
    }
  }
  // The merchandising list is never looked up: by its place in the feed it holds no attribute.
  for (const tag of record.merchandising_tags) output.dropped.push({ tag, source_field: "tags", reason: "merchandising" });
  return output;
}

/** Every label the table can produce, for the check that none of the 24 is unreachable. */
export function labelsInTable(): Set<Theme | Mechanic> {
  return new Set([...TABLE.values()].flatMap((entry) => (entry.kind === "label" ? [entry.label] : [])));
}
