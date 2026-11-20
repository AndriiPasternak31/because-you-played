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
import { analyse, finish, questionsToAnswer, type Analysis, type EvalInputs, type OwnerAnswers, type Report } from "./evaluate.ts";
import { parseThresholds } from "./gate.ts";
import { LABEL_VERSIONS, type Rate } from "./measures.ts";
import { REVIEWER_MAX_USD, answerPath, obtainAnswer, readTemplates, storedSpend, type Question, type ReviewerAnswer, type Spend } from "./reviewer.ts";
import { loadTruth } from "./truth.ts";

export interface EvalPaths {
  dataDir: string;
  thresholds: string;
  plan: string;
  /** Null: do not read the owner's answers. */
  ownerAnswers: string | null;
  answersDir: string;
  /** The record of the reviewer answers that were kept out of the tree for the owner's check, and of their return. */
  heldBack: string;
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
  heldBack: "eval/reviewer/held-back.json",
  outDir: "eval/results",
};

const OwnerAnswersSchema = z.strictObject({
  answered_on: z.string(),
  answers: z.array(z.strictObject({ question_id: z.string(), question_sha256: z.string(), answer: z.enum(["yes", "no", "unclear"]) })),
});

const HeldBackSchema = z.strictObject({
  why: z.string(),
  asked_on: z.string(),
  /** The commit of this repository's history in which the held-back answers were stored. */
  answers_stored_in_commit: z.string(),
  question_ids: z.array(z.string()),
  /** What those answers cost, as one total: a count per question would give the answer away by its length. */
  spend: z.strictObject({ calls: z.number(), input_tokens: z.number(), output_tokens: z.number(), usd: z.number(), seconds: z.number() }),
  /** Null while the answers are out of the tree. Once the owner has answered and they are back: the day, and how they came back. */
  brought_back: z.nullable(z.strictObject({ on: z.string(), how: z.string() })),
  disclosed_to_the_owner_before_he_answered: z.array(z.strictObject({ question_id: z.string(), what: z.string() })),
  also_said_before_they_were_held_back: z.string(),
});
export type HeldBack = z.infer<typeof HeldBackSchema>;

export function readHeldBack(path: string): HeldBack {
  const parsed = HeldBackSchema.safeParse(readJson(path, "the record of the reviewer answers held back for the owner's check"));
  if (!parsed.success) throw new Error(`${path} is not a record of held-back answers: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Everything the reviewer has cost: the stored answers, plus the held-back ones while they are out of the tree.
 * Once they are back, their files are counted like any other.
 */
export function totalSpend(answersDir: string, heldBack: HeldBack): Spend {
  const stored = storedSpend(answersDir);
  const back = heldBack.question_ids.filter((id) => existsSync(answerPath(answersDir, id))).length;
  if (back === heldBack.question_ids.length) return stored;
  if (back !== 0) throw new Error(`${back} of the ${heldBack.question_ids.length} held-back reviewer answers are in ${answersDir}: restore all of them or none, or their cost is counted wrongly`);
  return {
    calls: stored.calls + heldBack.spend.calls,
    input_tokens: stored.input_tokens + heldBack.spend.input_tokens,
    output_tokens: stored.output_tokens + heldBack.spend.output_tokens,
    usd: Math.round((stored.usd + heldBack.spend.usd) * 1e6) / 1e6,
    seconds: Math.round((stored.seconds + heldBack.spend.seconds) * 1000) / 1000,
    files: stored.files,
  };
}

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
    disclosedToOwner: readHeldBack(paths.heldBack).disclosed_to_the_owner_before_he_answered.map((entry) => entry.question_id),
  };
}

export interface RunResult {
  analysis: Analysis;
  report: Report;
  reportPath: string;
  verdictPath: string;
}

// ---------------------------------------------------------------------------
// The record of runs
// ---------------------------------------------------------------------------

/** One run of the evaluation in brief: the index it ran on and what it found. */
export interface RunSummary {
  key: string;
  index_hash: string;
  prompt_version: string;
  thresholds_sha256: string;
  owner_check: "outstanding" | "answered";
  recorded: string;
  ships: string | null;
  reason: string;
  disagreements: number;
  versions: Record<
    string,
    {
      marks_failed: string[];
      labels_asserted: number | null;
      /** Decided labels only. `held_back` is how many more were asserted whose reviewer answer was held back. */
      precision: { count: number; of: number; held_back: number } | null;
      recovery: { count: number; of: number } | null;
      recovery_without_tags: { count: number; of: number } | null;
      missed_abstentions: number | null;
      invalid_quotes: number | null;
      pairwise_pooled: { count: number; of: number };
      pairwise_mean_per_game: number | null;
      wrongly_shown: { count: number; of_shown: number };
      model_calls: number;
      estimated_usd: number;
    }
  >;
}

export function summarise(report: Report): RunSummary {
  const versions: RunSummary["versions"] = {};
  for (const version of VERSIONS) {
    const matching = report.matching[version];
    const enrichment = version === "raw" ? null : report.enrichment[version];
    versions[version] = {
      marks_failed: report.decision.versions[version].failed_marks,
      labels_asserted: enrichment?.labels_asserted ?? null,
      precision: enrichment === null ? null : { count: enrichment.precision.count, of: enrichment.precision.of, held_back: enrichment.precision.left_out.held_back },
      recovery: enrichment === null ? null : { count: enrichment.recovery.count, of: enrichment.recovery.of },
      recovery_without_tags: enrichment === null ? null : { count: enrichment.recovery_without_tags.count, of: enrichment.recovery_without_tags.of },
      missed_abstentions: enrichment?.missed_abstentions.count ?? null,
      invalid_quotes: enrichment?.invalid_quotes.count ?? null,
      pairwise_pooled: { count: matching.pairwise.pooled.count, of: matching.pairwise.pooled.of },
      pairwise_mean_per_game: matching.pairwise.per_game.mean,
      wrongly_shown: { count: matching.wrongly_shown.count, of_shown: matching.wrongly_shown.results_judged },
      model_calls: matching.cost.model_calls,
      estimated_usd: matching.cost.estimated_usd,
    };
  }
  return {
    key: `${report.index_hash}|${report.thresholds_sha256}|${report.prompt_version}|${report.owner_check.status}`,
    index_hash: report.index_hash,
    prompt_version: report.prompt_version,
    thresholds_sha256: report.thresholds_sha256,
    owner_check: report.owner_check.status,
    recorded: "by npm run eval, from the index in this tree",
    ships: report.decision.ships,
    reason: report.decision.reason,
    disagreements: report.disagreements.count,
    versions,
  };
}

const RunsSchema = z.object({ note: z.string(), runs: z.array(z.looseObject({ key: z.string() })) });
const RUNS_NOTE =
  "Every run of the evaluation whose result was looked at, oldest first: the index it ran on and what it found. No run is dropped. " +
  "A run on the same index, pass marks, prompt version and state of the owner's check replaces its own entry and no other. " +
  "While the owner's check is outstanding no entry holds a count that would give away the reviewer's answer to one of his questions: " +
  "precision counts decided labels only, and the control is left out.";

/** Adds this run to the record, or replaces the entry of the same run. Every other entry is kept as it is. */
function recordRun(path: string, summary: RunSummary): void {
  let runs: { key: string }[] = [];
  if (existsSync(path)) {
    const parsed = RunsSchema.safeParse(readJson(path, "the record of runs"));
    if (!parsed.success) throw new Error(`${path} is not a record of runs, so this run was not added to it: ${z.prettifyError(parsed.error)}`);
    runs = parsed.data.runs;
  }
  const at = runs.findIndex((run) => run.key === summary.key);
  if (at === -1) runs.push(summary);
  else runs[at] = summary;
  writeFileSync(path, `${JSON.stringify({ note: RUNS_NOTE, runs }, null, 2)}\n`);
}

/** Scores, writes the report, the verdict and the record of runs, and returns them. Throws when an input is missing or stale. */
export async function runEvaluation(paths: EvalPaths, live: Live | null, log: (line: string) => void): Promise<RunResult> {
  const analysis = analyse(loadInputs(paths));
  const heldBack = readHeldBack(paths.heldBack);

  // While the owner has not answered, the reviewer's answers to his questions may not be in the tree at all.
  const inTree = [...analysis.heldBack].filter((id) => existsSync(answerPath(paths.answersDir, id)));
  if (inTree.length > 0) {
    throw new Error(
      `the reviewer's answer to ${inTree.join(", ")} is stored in ${paths.answersDir} while the owner has not answered his check. ` +
        "He answers without sight of the reviewer's answers: remove those files until his answers exist.",
    );
  }
  // Once he has answered, they are needed like any other. Say where they are, not only that they are missing.
  const needed = analysis.heldBack.size === 0 ? analysis.ownerQuestions.map((entry) => entry.question_id).filter((id) => !existsSync(answerPath(paths.answersDir, id))) : [];
  if (needed.length > 0 && live === null) {
    const restorable = needed.filter((id) => heldBack.question_ids.includes(id));
    throw new Error(
      `missing input: the owner has answered, and the reviewer's answers to ${needed.length} of his questions are not in ${paths.answersDir}. ` +
        (restorable.length === needed.length
          ? `They were held back until now. Restore them as the reviewer gave them:\n  git checkout ${heldBack.answers_stored_in_commit} -- ${needed.map((id) => answerPath(paths.answersDir, id)).join(" ")}\n` +
            "or, if that commit is no longer in this clone, ask the reviewer again: npm run eval -- --live"
          : "Ask the reviewer: npm run eval -- --live"),
    );
  }

  // Asked one after another, in the seeded shuffled order. A held-back question is not asked and not read.
  const answers = new Map<string, ReviewerAnswer>();
  for (const question of questionsToAnswer(analysis)) answers.set(question.id, await obtainAnswer(question, { dir: paths.answersDir, live, log }));
  const { report, verdictFor } = finish(analysis, (question: Question) => answers.get(question.id) as ReviewerAnswer);

  // One directory per enrichment prompt version, so the result for an earlier prompt is never overwritten.
  const reportRelative = join(report.prompt_version, "report.json");
  const reportPath = join(paths.outDir, reportRelative);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(join(paths.outDir, report.prompt_version), { recursive: true });
  writeFileSync(reportPath, reportText);
  const verdictPath = join(paths.outDir, "verdict.json");
  writeFileSync(verdictPath, `${JSON.stringify(verdictFor(reportRelative, sha256(reportText)), null, 2)}\n`);
  recordRun(join(paths.outDir, "runs.json"), summarise(report));
  return { analysis, report, reportPath, verdictPath };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const precisionCell = (value: Report["enrichment"]["table"]["precision"]): string =>
  value.left_out.held_back === 0 ? share(value) : `${share(value)}, ${value.left_out.held_back} held back`;
const share = (value: Rate): string => (value.rate === null ? `none of ${value.of}` : `${(value.rate * 100).toFixed(1)}% (${value.count}/${value.of})`);
const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function formatReport(report: Report, spend: Spend): string {
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
          precisionCell(row.precision),
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
    const reviewer = typeof entry.reviewer === "string" ? "reviewer's answer held back until the owner has answered; the pass mark counts it as wrong meanwhile" : `reviewer says ${entry.reviewer.answer}`;
    out.push(`  ${entry.game_id} "${entry.title}": ${entry.label} (${entry.plan.replace("_", " ")} in the plan), asserted by ${entry.asserted_by.map((by) => by.version).join(", ")}; ${reviewer}`);
  }
  out.push(
    `Control: the reviewer agreed with the plan on ${report.control.agreed} of ${report.control.reported} ` +
      `(${report.control.applies.agreed} of ${report.control.applies.of} where the label applies, ${report.control.does_not_apply.agreed} of ${report.control.does_not_apply.of} where it does not)` +
      (report.control.held_back === 0 ? "." : `. ${report.control.held_back} more of the ${report.control.size} control labels are the owner's questions and are held back.`),
  );
  out.push(`Owner's check: ${report.owner_check.note}`);
  out.push(
    `Reviewer answers: ${report.reviewer.answers.yes} yes, ${report.reviewer.answers.no} no, ${report.reviewer.answers.unclear} unclear, over ${report.reviewer.answered} questions` +
      (report.reviewer.held_back === 0 ? ".\n" : `; ${report.reviewer.held_back} more are held back.\n`),
  );

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
    `\nReviewer spend on record: $${spend.usd.toFixed(6)} of the $${REVIEWER_MAX_USD.toFixed(2)} limit, over ${spend.calls} calls ` +
      `(${spend.input_tokens} input and ${spend.output_tokens} output tokens); ${spend.files} answers are stored in the tree.`,
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
      "held-back": { type: "string", default: DEFAULT_EVAL_PATHS.heldBack },
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
    heldBack: values["held-back"],
    outDir: values["out-dir"],
  };
  let live: Live | null = null;
  if (values.live) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey === undefined || apiKey === "") throw new Error("--live needs OPENAI_API_KEY in the environment");
    const maxUsd = Number(values["max-usd"]);
    if (!(maxUsd > 0) || maxUsd > REVIEWER_MAX_USD) throw new Error(`--max-usd must be above 0 and at most ${REVIEWER_MAX_USD}, the limit for the reviewer; got "${values["max-usd"]}"`);
    live = { apiKey, budget: new Budget(maxUsd, totalSpend(paths.answersDir, readHeldBack(paths.heldBack)).usd), transport: httpTransport, retryDelayMs: 2000 };
  }
  const { report, reportPath, verdictPath } = await runEvaluation(paths, live, console.log);
  console.log(formatReport(report, totalSpend(paths.answersDir, readHeldBack(paths.heldBack))));
  console.log(`\nWrote ${reportPath} and ${verdictPath}, and recorded the run in ${join(paths.outDir, "runs.json")}.`);
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
