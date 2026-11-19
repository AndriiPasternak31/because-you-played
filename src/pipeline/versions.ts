/**
 * The four versions of a game's text, the rule for "thin", and the rule for a conflict.
 *
 *   raw               the delivered title, description and tag lists, untouched
 *   table             cleaned title and description, plus the labels the synonym table found
 *   model_where_thin  the table's labels, plus the model's labels on thin records only
 *   model_everywhere  cleaned title and description, plus the model's labels only
 *
 * What the versions are for is in eval/refs/evaluation-plan.md. Everything here is
 * deterministic: the model's answers arrive as an argument and are never fetched.
 */
import { z } from "zod";
import { MECHANICS, THEMES, WIN_SYSTEMS, type Term, type WinSystem } from "../dataset/vocabulary.ts";
import type { CanonicalRecord } from "./canonical.ts";
import { sha256 } from "./io.ts";
import { LabelSchema, type Label, type TableOutput } from "./synonyms.ts";

export const VERSIONS = ["raw", "table", "model_where_thin", "model_everywhere"] as const;
export type Version = (typeof VERSIONS)[number];

// ---------------------------------------------------------------------------
// Conflict: a win-system tag that the description contradicts
// ---------------------------------------------------------------------------

/**
 * How a description names a win system in plain English. German copy is not
 * recognised, so a conflict in a German record goes unseen by this rule.
 */
const WIN_SYSTEM_PHRASES: Record<WinSystem, RegExp> = {
  paylines: /\b(?:pay|win) ?lines?\b/i,
  ways: /\bways to win\b|\b\d[\d,.]* ways\b|\ball[- ]ways\b/i,
  cluster_pays: /\bclusters?\b/i,
};

export const ConflictSchema = z.strictObject({
  tag: z.string(),
  tag_asserts: z.enum(WIN_SYSTEMS),
  description_states: z.array(z.enum(WIN_SYSTEMS)).min(1),
  description_quote: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

function isWinSystem(term: Term): term is WinSystem {
  return (WIN_SYSTEMS as readonly string[]).includes(term);
}

/**
 * A conflict exists when a tag maps to one win system and the description names
 * a win system but not that one. A game has exactly one, so both cannot be right,
 * and code cannot tell which is.
 */
export function findConflict(record: CanonicalRecord, table: TableOutput): Conflict | null {
  if (record.description === null) return null;
  const stated = WIN_SYSTEMS.flatMap((system) => {
    const match = WIN_SYSTEM_PHRASES[system].exec(record.description ?? "");
    return match === null ? [] : [{ system, quote: match[0] }];
  });
  const first = stated[0];
  if (first === undefined) return null;
  for (const label of table.mechanics) {
    if (isWinSystem(label.label) && !stated.some((entry) => entry.system === label.label)) {
      return {
        tag: label.quote,
        tag_asserts: label.label,
        description_states: stated.map((entry) => entry.system),
        description_quote: first.quote,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Descriptor fields
// ---------------------------------------------------------------------------

export const FieldSchema = z.strictObject({
  /** `asserted` has labels. `abstained` and `conflict` have none and add nothing to the text. */
  status: z.enum(["asserted", "abstained", "conflict"]),
  conflict_reason: z.enum(["tag_contradicts_description", "more_than_one_win_system"]).nullable(),
  labels: z.array(LabelSchema),
});
export type Field = z.infer<typeof FieldSchema>;

const VOCABULARY_ORDER: readonly Term[] = [...THEMES, ...MECHANICS];

/** A field with nothing in dispute: asserted when it has labels, abstained when it has none. */
function plainField(labels: readonly Label[]): Field {
  return labels.length === 0
    ? { status: "abstained", conflict_reason: null, labels: [] }
    : { status: "asserted", conflict_reason: null, labels: inVocabularyOrder(labels) };
}

function mechanicsField(labels: readonly Label[], conflict: Conflict | null): Field {
  if (conflict !== null) return { status: "conflict", conflict_reason: "tag_contradicts_description", labels: [] };
  if (new Set(labels.map((label) => label.label).filter(isWinSystem)).size > 1) {
    return { status: "conflict", conflict_reason: "more_than_one_win_system", labels: [] };
  }
  return plainField(labels);
}

function inVocabularyOrder(labels: readonly Label[]): Label[] {
  return [...labels].sort((a, b) => VOCABULARY_ORDER.indexOf(a.label) - VOCABULARY_ORDER.indexOf(b.label));
}

// ---------------------------------------------------------------------------
// Thin
// ---------------------------------------------------------------------------

/** Recorded in the index. Changing the rule means changing the id. */
export const THIN_RULE = {
  id: "thin-v1",
  rule:
    "A record is thin when the synonym table leaves its themes or its mechanics without a usable label: " +
    "no delivered tag mapped to a label of that field, or the mechanics tags are in conflict.",
} as const;

/** Uses only the raw record (through its canonical form) and the table's output. */
export function isThin(record: CanonicalRecord, table: TableOutput): boolean {
  const conflict = findConflict(record, table);
  return plainField(table.themes).status !== "asserted" || mechanicsField(table.mechanics, conflict).status !== "asserted";
}

/** What a record gives a reader to go on, for the service's decision to decline. */
export const EVIDENCE_LEVELS = ["description", "tags_only", "none"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export function evidenceLevel(record: CanonicalRecord, table: TableOutput): EvidenceLevel {
  if (record.description !== null) return "description";
  return table.themes.length + table.mechanics.length > 0 ? "tags_only" : "none";
}

// ---------------------------------------------------------------------------
// The four versions
// ---------------------------------------------------------------------------

export const VersionContentSchema = z.strictObject({
  text: z.string().min(1),
  text_sha256: z.string(),
  /** Null for `raw`, which has no descriptor fields. */
  themes: FieldSchema.nullable(),
  mechanics: FieldSchema.nullable(),
});
export type VersionContent = z.infer<typeof VersionContentSchema>;

/** The model's surviving labels for one record. Empty lists when it abstained or gave no usable answer. */
export interface ModelLabels {
  themes: readonly Label[];
  mechanics: readonly Label[];
}

function content(lines: readonly (string | null)[], themes: Field | null, mechanics: Field | null): VersionContent {
  const text = lines.filter((line): line is string => line !== null).join("\n");
  return { text, text_sha256: sha256(text), themes, mechanics };
}

function listLine(name: string, items: readonly string[]): string | null {
  return items.length === 0 ? null : `${name}: ${items.join(", ")}`;
}

function described(record: CanonicalRecord, themes: Field, mechanics: Field): VersionContent {
  const words = (field: Field): string[] => field.labels.map((label) => label.label.replaceAll("_", " "));
  return content(
    [record.title, record.description, listLine("Themes", words(themes)), listLine("Mechanics", words(mechanics))],
    themes,
    mechanics,
  );
}

/** The table's labels first; a model label is added only where the table has none for that label. */
function union(table: readonly Label[], model: readonly Label[]): Label[] {
  return [...table, ...model.filter((label) => !table.some((known) => known.label === label.label))];
}

export function buildVersions(record: CanonicalRecord, table: TableOutput, model: ModelLabels): Record<Version, VersionContent> {
  const conflict = findConflict(record, table);
  const thin = isThin(record, table);
  return {
    raw: content(
      [
        record.title_as_delivered,
        record.description_as_delivered,
        listLine("Features", record.source_tags.features),
        listLine("Themes", record.source_tags.themes),
        listLine("Tags", record.merchandising_tags),
      ],
      null,
      null,
    ),
    table: described(record, plainField(table.themes), mechanicsField(table.mechanics, conflict)),
    model_where_thin: described(
      record,
      plainField(thin ? union(table.themes, model.themes) : table.themes),
      mechanicsField(thin ? union(table.mechanics, model.mechanics) : table.mechanics, conflict),
    ),
    model_everywhere: described(record, plainField(model.themes), mechanicsField(model.mechanics, conflict)),
  };
}
