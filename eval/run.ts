/**
 * Runs the evaluation and writes the verdict the service reads.
 *
 *   node eval/run.ts                 score the committed outputs with the stored reviewer answers: no key, no network
 *   node eval/run.ts --live          also ask the reviewer any question that has no stored answer (needs OPENAI_API_KEY)
 *
 * Exit 0: a version may be served. Exit 1: no version passes its marks, or an input is missing or stale.
 * The same inputs give the same files, byte for byte.
 *
 * The other options point at other copies of the inputs, which is how the tests run it on a bad fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Budget, httpTransport, type Live } from "../src/pipeline/costs.ts";
import { loadIndex } from "../src/pipeline/index-store.ts";
import { sha256 } from "../src/pipeline/io.ts";
import { VERSIONS } from "../src/pipeline/versions.ts";
import { loadOfferings } from "../src/service/offerings.ts";
import { analyse, finish, type Analysis, type EvalInputs, type OwnerAnswers, type Report } from "./evaluate.ts";
import { parseThresholds } from "./gate.ts";
import { LABEL_VERSIONS, type Rate } from "./measures.ts";
import { REVIEWER_MAX_USD, obtainAnswer, readTemplates, storedSpend, type Question, type ReviewerAnswer } from "./reviewer.ts";
import { loadTruth } from "./truth.ts";

export interface EvalPaths {
  dataDir: string;
  thresholds: string;
  plan: string;
  /** Null: do not read the owner's answers. */
  ownerAnswers: string | null;
  answersDir: string;
  outDir: string;
}

/** Where the owner commits his six answers. Agents never write here. */
export const OWNER_ANSWERS_PATH = "eval/refs/owner-check.json";

export const DEFAULT_EVAL_PATHS: EvalPaths = {
  dataDir: "data",
  thresholds: "eval/thresholds.json",
  plan: "eval/refs/evaluation-plan.md",
  ownerAnswers: OWNER_ANSWERS_PATH,
  answersDir: "eval/reviewer/answers",
  outDir: "eval/results",
};

const OwnerAnswersSchema = z.strictObject({
  answered_on: z.string(),
  answers: z.array(z.strictObject({ question_id: z.string(), question_sha256: z.string(), answer: z.enum(["yes", "no", "unclear"]) })),
});

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`missing input: ${what} at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${what} at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function loadInputs(paths: EvalPaths): EvalInputs {
  const thresholdsText = (() => {
    try {
      return readFileSync(paths.thresholds);
    } catch (error) {
      throw new Error(`missing input: the pass marks at ${paths.thresholds} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  })();
  let ownerAnswers: OwnerAnswers | null = null;
  if (paths.ownerAnswers !== null && existsSync(paths.ownerAnswers)) {
    const parsed = OwnerAnswersSchema.safeParse(readJson(paths.ownerAnswers, "the owner's answers"));
    if (!parsed.success) throw new Error(`${paths.ownerAnswers} is not a file of owner's answers: ${z.prettifyError(parsed.error)}`);
    ownerAnswers = parsed.data;
  }
  return {
    index: loadIndex(join(paths.dataDir, "index"), { cataloguePath: join(paths.dataDir, "catalogue.raw.jsonl") }),
    truth: loadTruth(join(paths.dataDir, "generation")),
    offerings: loadOfferings(join(paths.dataDir, "offerings.jsonl")),
    thresholds: parseThresholds(JSON.parse(thresholdsText.toString("utf8")) as unknown, paths.thresholds),
    thresholdsSha256: sha256(thresholdsText),
    templates: readTemplates(paths.plan),
    ownerAnswers,
  };
}

export interface RunResult {
  analysis: Analysis;
  report: Report;
  reportPath: string;
  verdictPath: string;
}

/** Scores, writes the report and the verdict, and returns them. Throws when an input is missing or stale. */
export async function runEvaluation(paths: EvalPaths, live: Live | null, log: (line: string) => void): Promise<RunResult> {
  const analysis = analyse(loadInputs(paths));
  // Asked one after another, in the seeded shuffled order.
  const answers = new Map<string, ReviewerAnswer>();
  for (const question of analysis.questions) answers.set(question.id, await obtainAnswer(question, { dir: paths.answersDir, live, log }));
  const { report, verdictFor } = finish(analysis, (question: Question) => answers.get(question.id) as ReviewerAnswer);

  // One directory per enrichment prompt version, so the result for an earlier prompt is never overwritten.
  const reportRelative = join(report.prompt_version, "report.json");
  const reportPath = join(paths.outDir, reportRelative);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(join(paths.outDir, report.prompt_version), { recursive: true });
  writeFileSync(reportPath, reportText);
  const verdictPath = join(paths.outDir, "verdict.json");
  writeFileSync(verdictPath, `${JSON.stringify(verdictFor(reportRelative, sha256(reportText)), null, 2)}\n`);
  return { analysis, report, reportPath, verdictPath };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const share = (value: Rate): string => (value.rate === null ? `none of ${value.of}` : `${(value.rate * 100).toFixed(1)}% (${value.count}/${value.of})`);
const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function formatReport(report: Report, spend: ReturnType<typeof storedSpend>): string {
  const out: string[] = [];
  out.push(`Evaluation of index ${report.index_hash}`);
  out.push(`${report.games} games, enrichment prompt ${report.prompt_version}, reviewer ${report.models.reviewer}, seed ${report.seed}\n`);

  out.push("1. Is enrichment safe to automate?\n");
  out.push(
    table(
      ["version", "precision", "recovery", "recovery without tags", "missed abstentions", "invalid quotes", "marks"],
      LABEL_VERSIONS.map((version) => {
        const row = report.enrichment[version];
        const failed = report.decision.versions[version].failed_marks.filter((mark) => mark.startsWith("enrichment."));
        return [
          version,
          share(row.precision),
          share(row.recovery),
          share(row.recovery_without_tags),
          `${row.missed_abstentions.count} of ${row.missed_abstentions.of}`,
          `${row.invalid_quotes.count} of ${row.invalid_quotes.of}`,
          failed.length === 0 ? "pass" : `FAIL ${failed.map((mark) => mark.replace("enrichment.", "")).join(", ")}`,
        ];
      }),
    ),
  );
  out.push("raw asserts no labels, so these marks do not apply to it.");
  out.push(
    `Recoverable labels not asserted: ${LABEL_VERSIONS.map((version) => `${version} ${report.enrichment[version].missed.not_asserted} + ${report.enrichment[version].missed.conflict_rule} on a field left empty by a tag conflict`).join("; ")}.`,
  );
  const conflicts = report.conflict_games.games;
  out.push(
    `A delivered tag contradicts the description on ${conflicts.length} games (${conflicts.map((game) => game.game_id).join(", ")}). The table version asserts no mechanic there; ` +
      `the model's reading stands in the two model versions on ${conflicts.filter((game) => game.model_reading_used).length} of them.`,
  );
  out.push(`Disagreements with the plan: ${report.disagreements.count}.`);
  for (const entry of report.disagreements.list) {
    const reviewer = typeof entry.reviewer === "string" ? "reviewer's answer withheld until the owner has answered" : `reviewer says ${entry.reviewer.answer}`;
    out.push(`  ${entry.game_id} "${entry.title}": ${entry.label} (${entry.plan.replace("_", " ")} in the plan), asserted by ${entry.asserted_by.map((by) => by.version).join(", ")}; ${reviewer}`);
  }
  out.push(
    `Control: the reviewer agreed with the plan on ${report.control.agreed} of ${report.control.size} ` +
      `(${report.control.applies.agreed} of ${report.control.applies.of} where the label applies, ${report.control.does_not_apply.agreed} of ${report.control.does_not_apply.of} where it does not).`,
  );
  out.push(`Owner's check: ${report.owner_check.note}`);
  out.push(`Reviewer answers: ${report.reviewer.answers.yes} yes, ${report.reviewer.answers.no} no, ${report.reviewer.answers.unclear} unclear, over ${report.reviewer.questions} questions.\n`);

  out.push("2. What does each step add to matching, and what does it cost?\n");
  out.push(
    table(
      ["version", "pairwise pooled", "mean per game", "wrongly shown", "model calls", "est. cost", "marks"],
      VERSIONS.map((version) => {
        const row = report.matching[version];
        const failed = report.decision.versions[version].failed_marks.filter((mark) => mark.startsWith("matching."));
        return [
          version,
          share(row.pairwise.pooled),
          `${percent(row.pairwise.per_game.mean)} (${row.pairwise.per_game.games} games)`,
          `${row.wrongly_shown.count} of ${row.wrongly_shown.results_judged} shown`,
          String(row.cost.model_calls),
          `$${row.cost.estimated_usd.toFixed(4)}`,
          failed.length === 0 ? "pass" : `FAIL ${failed.map((mark) => mark.replace("matching.", "")).join(", ")}`,
        ];
      }),
    ),
  );
  out.push("\nBy the condition of the record asked about (mean per game, with the number of games):\n");
  out.push(
    table(
      ["version", "has a description", "tags only", "nearly empty", "thin", "not thin"],
      VERSIONS.map((version) => {
        const row = report.matching[version];
        const cell = (value: { per_game: { mean: number | null; games: number } }): string => `${percent(value.per_game.mean)} (${value.per_game.games})`;
        return [version, cell(row.by_condition.description), cell(row.by_condition.tags_only), cell(row.by_condition.none), cell(row.by_thin.thin), cell(row.by_thin.not_thin)];
      }),
    ),
  );
  out.push(`\nCheck games on ${report.check_games.brand}: ${report.check_games.games.join(", ")}.`);

  out.push(`\nVerdict: ${report.decision.reason}`);
  out.push(`\nReal failures found (${report.gallery.real.length}):`);
  for (const entry of report.gallery.real) out.push(`  ${entry.kind}: ${entry.game_id} "${entry.title}"${entry.version === null ? "" : ` in ${entry.version}`}`);
  out.push(`Planted on purpose, listed apart (${report.gallery.injected.length}): ${[...new Set(report.gallery.injected.map((entry) => entry.kind))].join(", ")}.`);
  out.push(
    `\nReviewer spend on record: $${spend.usd.toFixed(6)} of the $${REVIEWER_MAX_USD.toFixed(2)} limit, over ${spend.calls} calls in ${spend.files} stored answers ` +
      `(${spend.input_tokens} input and ${spend.output_tokens} output tokens).`,
  );
  return out.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string", default: DEFAULT_EVAL_PATHS.dataDir },
      thresholds: { type: "string", default: DEFAULT_EVAL_PATHS.thresholds },
      plan: { type: "string", default: DEFAULT_EVAL_PATHS.plan },
      "owner-answers": { type: "string", default: OWNER_ANSWERS_PATH },
      "answers-dir": { type: "string", default: DEFAULT_EVAL_PATHS.answersDir },
      "out-dir": { type: "string", default: DEFAULT_EVAL_PATHS.outDir },
      live: { type: "boolean", default: false },
      "max-usd": { type: "string", default: String(REVIEWER_MAX_USD) },
    },
    strict: true,
  });
  const paths: EvalPaths = {
    dataDir: values["data-dir"],
    thresholds: values.thresholds,
    plan: values.plan,
    ownerAnswers: values["owner-answers"],
    answersDir: values["answers-dir"],
    outDir: values["out-dir"],
  };
  let live: Live | null = null;
  if (values.live) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey === "") throw new Error("--live needs OPENAI_API_KEY in the environment");
    const maxUsd = Number(values["max-usd"]);
    if (!(maxUsd > 0) || maxUsd > REVIEWER_MAX_USD) throw new Error(`--max-usd must be above 0 and at most ${REVIEWER_MAX_USD}, the limit for the reviewer; got "${values["max-usd"]}"`);
    live = { apiKey, budget: new Budget(maxUsd, storedSpend(paths.answersDir).usd), transport: httpTransport, retryDelayMs: 2000 };
  }
  const { report, reportPath, verdictPath } = await runEvaluation(paths, live, console.log);
  console.log(formatReport(report, storedSpend(paths.answersDir)));
  console.log(`\nWrote ${reportPath} and ${verdictPath}.`);
  if (!report.decision.passed) {
    console.error("\nevaluation failed: no version passes its marks, so the service will not start.");
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\nevaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
