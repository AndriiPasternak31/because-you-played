/**
 * The answer key: the generator's plan, read from the hidden truth directory.
 *
 * Only the evaluation reads it. The grade of a pair of games is the rule in
 * eval/refs/evaluation-plan.md under "Related, by rule from the plan".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TruthGameSchema, TruthRowSchema, type TruthGame, type TruthRow } from "../src/dataset/model.ts";
import { WIN_SYSTEMS } from "../src/dataset/vocabulary.ts";

export interface Truth {
  games: ReadonlyMap<string, TruthGame>;
  /** Keyed by the raw row's `source_record_id`. */
  rows: ReadonlyMap<string, TruthRow>;
}

function readLines<T>(path: string, schema: z.ZodType<T>, what: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`the answer key file ${path} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return text.split("\n").flatMap((line, index) => {
    if (line.length === 0) return [];
    const where = `${path} line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`${where} is not ${what}: ${z.prettifyError(parsed.error)}`);
    return [parsed.data];
  });
}

export function loadTruth(generationDir: string): Truth {
  const games = readLines(join(generationDir, "truth.games.jsonl"), TruthGameSchema, "a truth game");
  const rows = readLines(join(generationDir, "truth.rows.jsonl"), TruthRowSchema, "a truth row");
  if (games.length === 0 || rows.length === 0) throw new Error(`the answer key in ${generationDir} is empty, so nothing could be scored`);
  return { games: new Map(games.map((game) => [game.game_id, game])), rows: new Map(rows.map((row) => [row.source_record_id, row])) };
}

export const GRADES = ["strong", "related", "weak", "unrelated"] as const;
export type Grade = (typeof GRADES)[number];

const isWinSystem = (mechanic: string): boolean => (WIN_SYSTEMS as readonly string[]).includes(mechanic);

/** How related two games are, by the plan's rule. A win system is not a feature. */
export function grade(a: TruthGame, b: TruthGame): Grade {
  const sharedTheme = a.themes.some((theme) => b.themes.includes(theme));
  const sharedFeatures = a.mechanics.filter((mechanic) => !isWinSystem(mechanic) && b.mechanics.includes(mechanic)).length;
  const sameWinSystem = a.mechanics.some((mechanic) => isWinSystem(mechanic) && b.mechanics.includes(mechanic));
  if (sharedTheme && sharedFeatures >= 2) return "strong";
  if (sharedTheme && (sharedFeatures === 1 || sameWinSystem)) return "related";
  if (sharedTheme || sharedFeatures >= 2) return "weak";
  return "unrelated";
}

/** What two games share in the plan, in words, for a report a person reads. */
export function shared(a: TruthGame, b: TruthGame): string {
  const themes = a.themes.filter((theme) => b.themes.includes(theme));
  const mechanics = a.mechanics.filter((mechanic) => b.mechanics.includes(mechanic));
  const parts = [...themes, ...mechanics].map((term) => term.replaceAll("_", " "));
  return parts.length === 0 ? "nothing" : parts.join(", ");
}
