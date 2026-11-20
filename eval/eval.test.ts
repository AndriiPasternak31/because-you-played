/**
 * Proofs of the evaluation's invariants (docs/features/service.md). Each test name starts with
 * the invariant it proves. The committed results are never trusted on their own: the evaluation
 * is run again by the test and its output compared with what is committed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TruthGame } from "../src/dataset/model.ts";
import { Budget, SpendLimitReached, type Live } from "../src/pipeline/costs.ts";
import { sealManifest, type Index, type IndexRecord, type Manifest } from "../src/pipeline/index-store.ts";
import { sha256 } from "../src/pipeline/io.ts";
import { VERSIONS, type Version } from "../src/pipeline/versions.ts";
import { HELD_BACK, analyse, finish, questionsToAnswer, type Analysis, type EvalInputs, type Report } from "./evaluate.ts";
import { MARKS, decide, parseThresholds, type MarkResult, type Measured } from "./gate.ts";
import { LABEL_VERSIONS, isWordForWord, pairwiseByGame, summarisePairwise } from "./measures.ts";
import { ownerFile, ownerQuestions } from "./owner-check.ts";
import { REVIEWER_MAX_USD, REVIEWER_MODEL, answerPath, interpret, labelQuestion, obtainAnswer, readTemplates, requestHash, storedSpend, type Question, type ReviewerAnswer } from "./reviewer.ts";
import { DEFAULT_EVAL_PATHS, loadInputs, readHeldBack, runEvaluation, totalSpend, type EvalPaths } from "./run.ts";
import { grade, type Truth } from "./truth.ts";

const scratch = (name: string): string => mkdtempSync(join(tmpdir(), `${name}-`));
const quiet = (): void => {};

/**
 * The committed inputs without the owner's answers: the evaluation as it stands while his check is outstanding.
 * The proofs of that state are made on this, and on `outstandingTree`, whatever state the committed tree is in.
 */
const inputs = (): EvalInputs => loadInputs({ ...DEFAULT_EVAL_PATHS, ownerAnswers: null });
const base = analyse(inputs());

/** Replays the committed reviewer answers: every question but the ones held back for the owner's check. */
async function storedAnswers(analysis: Analysis): Promise<Map<string, ReviewerAnswer>> {
  const answers = new Map<string, ReviewerAnswer>();
  for (const question of questionsToAnswer(analysis)) answers.set(question.id, await obtainAnswer(question, { dir: DEFAULT_EVAL_PATHS.answersDir, live: null, log: quiet }));
  return answers;
}

/**
 * A tree in which the owner's check is outstanding, built here: the committed reviewer answers without the six to
 * his questions, no answers of his, and the record of the six saying they have not been brought back.
 */
function outstandingTree(name: string): EvalPaths & { ownerAnswers: null; noOwnerAnswers: string } {
  const dir = scratch(name);
  const answersDir = join(dir, "answers");
  cpSync(DEFAULT_EVAL_PATHS.answersDir, answersDir, { recursive: true });
  for (const id of base.heldBack) rmSync(answerPath(answersDir, id), { force: true });
  assert.equal(readdirSync(answersDir).length, questionsToAnswer(base).length, "the scratch tree does not hold exactly the answers that are not held back");
  const heldBack = join(dir, "held-back.json");
  writeFileSync(heldBack, JSON.stringify({ ...readHeldBack(DEFAULT_EVAL_PATHS.heldBack), brought_back: null }));
  return { ...DEFAULT_EVAL_PATHS, ownerAnswers: null, answersDir, heldBack, outDir: join(dir, "out"), noOwnerAnswers: join(dir, "no-owner-check.json") };
}
/** The command's options for a scratch tree. A path that holds no file stands for "the owner has not answered". */
const treeArgs = (paths: EvalPaths, ownerAnswers: string): string[] => ["--answers-dir", paths.answersDir, "--held-back", paths.heldBack, "--out-dir", paths.outDir, "--owner-answers", ownerAnswers];

const envelope = (answer: unknown): unknown => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }] });

/** Writes a stored answer by hand, in the format a live call stores. */
function writeAnswer(dir: string, question: Question, answer: unknown): void {
  mkdirSync(dir, { recursive: true });
  const file = {
    question_id: question.id,
    kind: question.kind,
    model: REVIEWER_MODEL,
    request_sha256: requestHash(question),
    attempts: [{ outcome: "ok", seconds: 0, http_status: 200, reason: null, usage: null, body: envelope(answer) }],
  };
  writeFileSync(answerPath(dir, question.id), `${JSON.stringify(file, null, 2)}\n`);
}

const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const { OPENAI_API_KEY: _key, ...clean } = process.env;
  return spawnSync(process.execPath, ["eval/run.ts", ...args], { encoding: "utf8", env: { ...clean, ...env }, timeout: 120_000 });
};

test("EV-1: with no key the evaluation reproduces the committed report and verdict byte for byte, twice", async () => {
  const verdictText = readFileSync(join(DEFAULT_EVAL_PATHS.outDir, "verdict.json"), "utf8");
  const reportFile = (JSON.parse(verdictText) as { report: { path: string } }).report.path;
  const committed = { report: readFileSync(join(DEFAULT_EVAL_PATHS.outDir, reportFile), "utf8"), verdict: verdictText };
  const committedRuns = readFileSync(join(DEFAULT_EVAL_PATHS.outDir, "runs.json"), "utf8");
  const recorded = (JSON.parse(committedRuns) as { runs: { key: string; index_hash: string; owner_check: string; ships: string | null; recorded: string }[] }).runs;
  assert.ok(recorded.length >= 4, "the record of runs has lost a run");
  const indexHash = (JSON.parse(verdictText) as { index_hash: string }).index_hash;
  // Two runs recorded by hand, on indexes that are gone. Then the two the command recorded on the index in this tree:
  // one while the owner's check was outstanding, one after he answered. Both of those are run again below.
  const byHand = recorded.filter((run) => run.recorded.startsWith("by hand"));
  const byCommand = recorded.slice(byHand.length);
  assert.ok(byHand.length >= 2 && byCommand.every((run) => run.recorded.startsWith("by npm run eval") && run.index_hash === indexHash));
  assert.deepEqual(byCommand.map((run) => run.owner_check), ["outstanding", "answered"]);
  assert.equal((JSON.parse(committed.report) as { owner_check: { status: string } }).owner_check.status, "answered");
  const outputs: string[] = [];
  for (const run of [1, 2]) {
    const outDir = scratch(`ev1-${run}`);
    // Run 1 starts from the record without its latest entry and has to add it; run 2 starts from the whole record and has to leave it alone.
    const before = JSON.parse(committedRuns) as { note: string; runs: unknown[] };
    writeFileSync(join(outDir, "runs.json"), run === 1 ? JSON.stringify({ ...before, runs: before.runs.slice(0, -1) }) : committedRuns);
    const result = cli(["--out-dir", outDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(outDir, reportFile), "utf8"), committed.report, "the report differs from the committed one");
    assert.equal(readFileSync(join(outDir, "verdict.json"), "utf8"), committed.verdict, "the verdict differs from the committed one");
    // The record of runs gains this run and keeps every other: started from the committed record, it comes out the same.
    assert.equal(readFileSync(join(outDir, "runs.json"), "utf8"), committedRuns, "the record of runs differs from the committed one");
    outputs.push(result.stdout.replaceAll(outDir, "<out>"));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.match(outputs[0] ?? "", /Verdict: \w+ ships/);

  // The run recorded while the owner's check was outstanding is reproduced too, on a tree built here in that state.
  // Started from the record without that entry, the command adds it back as it was and keeps every other.
  const open = outstandingTree("ev1-outstanding");
  const kept = recorded.filter((run) => run !== byCommand[0]);
  mkdirSync(open.outDir);
  writeFileSync(join(open.outDir, "runs.json"), JSON.stringify({ note: "", runs: kept }));
  const result = cli(treeArgs(open, open.noOwnerAnswers));
  assert.equal(result.status, 0, result.stderr);
  const after = (JSON.parse(readFileSync(join(open.outDir, "runs.json"), "utf8")) as { runs: unknown[] }).runs;
  assert.deepEqual(after.slice(0, -1), kept, "a run was dropped or changed while another was recorded");
  assert.deepEqual(after.at(-1), byCommand[0], "the run recorded while the owner's check was outstanding is not what the command records in that state");
  // The verdict did not wait for his answers: but for the hash of its report, it is the committed one.
  const verdictOf = (text: string): unknown => ({ ...(JSON.parse(text) as { report: { path: string } }), report: null });
  assert.deepEqual(verdictOf(readFileSync(join(open.outDir, "verdict.json"), "utf8")), verdictOf(committed.verdict));
  assert.notEqual(readFileSync(join(open.outDir, reportFile), "utf8"), committed.report);
});

test("EV-1: a missing or stale input stops the evaluation with exit 1 and names what is missing", () => {
  const outDir = scratch("ev1-missing");
  // One stored answer missing from the committed tree: the question is named.
  const oneShort = scratch("ev1-one-short");
  cpSync(DEFAULT_EVAL_PATHS.answersDir, oneShort, { recursive: true });
  const lost = (questionsToAnswer(base)[0] as Question).id;
  rmSync(answerPath(oneShort, lost));
  const noAnswer = cli(["--out-dir", outDir, "--answers-dir", oneShort]);
  assert.equal(noAnswer.status, 1);
  assert.ok(noAnswer.stderr.includes(`missing input: no stored reviewer answer for ${lost} at ${answerPath(oneShort, lost)}`), noAnswer.stderr);
  assert.ok(!existsSync(join(outDir, "verdict.json")), "a verdict was written although an input was missing");
  // No stored answer at all, while the owner's check is outstanding: the first question asked is named.
  // (Once he has answered, the first thing missed is the reviewer's answers to his six: EV-6 reads that message.)
  const open = outstandingTree("ev1-outstanding-missing");
  const noAnswers = cli(treeArgs({ ...open, answersDir: scratch("ev1-no-answers"), outDir }, open.noOwnerAnswers));
  assert.equal(noAnswers.status, 1);
  assert.match(noAnswers.stderr, /missing input: no stored reviewer answer for (label|recommendation)\.\S+ at /);
  assert.ok(!existsSync(join(outDir, "verdict.json")), "a verdict was written although an input was missing");

  const noTruth = scratch("ev1-no-truth");
  cpSync("data/index", join(noTruth, "index"), { recursive: true });
  cpSync("data/catalogue.raw.jsonl", join(noTruth, "catalogue.raw.jsonl"));
  cpSync("data/offerings.jsonl", join(noTruth, "offerings.jsonl"));
  const withoutKey = cli(["--out-dir", outDir, "--data-dir", noTruth]);
  assert.equal(withoutKey.status, 1);
  assert.match(withoutKey.stderr, /answer key file .*truth\.games\.jsonl is missing/);

  const noMarks = cli(["--out-dir", outDir, "--thresholds", join(noTruth, "no-thresholds.json")]);
  assert.equal(noMarks.status, 1);
  assert.match(noMarks.stderr, /missing input: the pass marks at .*no-thresholds\.json/);

  // A stored answer to a question that has since changed is refused, not reused.
  const stale = scratch("ev1-stale");
  cpSync(DEFAULT_EVAL_PATHS.answersDir, stale, { recursive: true });
  const first = readdirSync(stale).sort()[0] as string;
  const file = JSON.parse(readFileSync(join(stale, first), "utf8")) as { request_sha256: string };
  file.request_sha256 = "0".repeat(64);
  writeFileSync(join(stale, first), JSON.stringify(file));
  const staleRun = cli(["--out-dir", outDir, "--answers-dir", stale]);
  assert.equal(staleRun.status, 1);
  assert.ok(staleRun.stderr.includes(first) && staleRun.stderr.includes("answers a different question"));
  assert.ok(!existsSync(join(outDir, "verdict.json")));

  // A live run needs the key, and may not raise the spend limit.
  assert.match(cli(["--out-dir", outDir, "--live"]).stderr, /--live needs OPENAI_API_KEY/);
  const raised = cli(["--out-dir", outDir, "--live", "--max-usd", "5"], { OPENAI_API_KEY: "not-a-real-key" });
  assert.equal(raised.status, 1);
  assert.match(raised.stderr, /--max-usd must be above 0 and at most 1/);
});

/**
 * A copy of the data in which every text holds the vector of another text: the index is valid and its
 * matching is noise. The swap is made per text, not per row, because the loader refuses an index in
 * which one text sits at two points.
 */
function scrambledFixture(): { dataDir: string } {
  const dataDir = scratch("ev1-bad-fixture");
  for (const part of ["index", "generation", "catalogue.raw.jsonl", "offerings.jsonl"]) cpSync(join("data", part), join(dataDir, part), { recursive: true });
  const manifestPath = join(dataDir, "index", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const bytesPerVector = manifest.dimensions * 4;
  const records = readFileSync(join(dataDir, "index", "records.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IndexRecord);
  const files = Object.fromEntries(VERSIONS.map((version) => [version, readFileSync(join(dataDir, "index", `vectors.${version}.f32`))])) as Record<Version, Buffer>;
  // Every distinct text, in order of first appearance, with the vector it holds now.
  const texts: string[] = [];
  const vectorOf = new Map<string, Buffer>();
  for (const version of VERSIONS) {
    records.forEach((record, row) => {
      const hash = record.versions[version].text_sha256;
      if (vectorOf.has(hash)) return;
      texts.push(hash);
      vectorOf.set(hash, Buffer.from(files[version].subarray(row * bytesPerVector, (row + 1) * bytesPerVector)));
    });
  }
  // Text j takes the vector of the text half the list away: a fixed swap with no pattern the plan shares.
  const swapped = new Map(texts.map((hash, position) => [hash, vectorOf.get(texts[(position + Math.floor(texts.length / 2)) % texts.length] as string) as Buffer]));
  for (const version of VERSIONS) {
    const name = `vectors.${version}.f32`;
    const moved = Buffer.concat(records.map((record) => swapped.get(record.versions[version].text_sha256) as Buffer));
    assert.notDeepEqual(moved, files[version]);
    writeFileSync(join(dataDir, "index", name), moved);
    manifest.files[name] = { sha256: sha256(moved), bytes: moved.length };
  }
  writeFileSync(manifestPath, `${JSON.stringify(sealManifest(manifest), null, 2)}\n`);
  return { dataDir };
}

test("EV-1: on a deliberately bad index the gate fails, the command exits 1, and the service refuses the verdict it wrote", () => {
  const { dataDir } = scrambledFixture();
  const paths: EvalPaths = { ...DEFAULT_EVAL_PATHS, dataDir, ownerAnswers: null, answersDir: scratch("ev1-bad-answers"), outDir: scratch("ev1-bad-out") };
  // The fixture's own questions, answered "no" by hand: the reviewer cannot rescue a result the rule calls unrelated.
  const analysis = analyse(loadInputs(paths));
  for (const question of questionsToAnswer(analysis)) writeAnswer(paths.answersDir, question, question.kind === "label" ? { answer: "no", quote: "" } : { answer: "no", in_common: "nothing" });
  const result = cli(["--data-dir", dataDir, "--answers-dir", paths.answersDir, "--out-dir", paths.outDir, "--owner-answers", join(paths.outDir, "none.json")]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /no version passes its marks, so the service will not start/);
  const verdict = JSON.parse(readFileSync(join(paths.outDir, "verdict.json"), "utf8")) as { passed: boolean; ships: string | null; versions: Record<string, { failed_marks: string[] }> };
  assert.equal(verdict.passed, false);
  assert.equal(verdict.ships, null);
  for (const version of VERSIONS) assert.ok(verdict.versions[version]?.failed_marks.includes("matching.min_pairwise_accuracy"), `${version} passed matching on scrambled vectors`);

  const serve = spawnSync(process.execPath, ["src/service/serve.ts", "--port", "0", "--index", join(dataDir, "index"), "--catalogue", join(dataDir, "catalogue.raw.jsonl"), "--offerings", join(dataDir, "offerings.jsonl"), "--verdict", join(paths.outDir, "verdict.json")], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(serve.status, 1);
  assert.match(serve.stderr, /not serving: the verdict .* does not pass: No version passes its marks/);
});

test("EV-2: every pass mark is read from the owner's file: moving one mark in the file fails exactly that mark, and none is defined in code", async () => {
  const answers = await storedAnswers(base);
  const answer = (question: Question): ReviewerAnswer => answers.get(question.id) as ReviewerAnswer;
  const committed = finish(base, answer).report;
  const ships = committed.decision.ships;
  assert.ok(ships !== null);
  const text = readFileSync(DEFAULT_EVAL_PATHS.thresholds, "utf8");

  for (const mark of MARKS) {
    const result: MarkResult | undefined = committed.decision.versions[ships].marks.find((entry) => entry.mark === mark.id);
    assert.ok(result !== undefined && result.applies && result.measured !== null && result.pass, mark.id);
    // Set the mark just past what was measured, in a copy of the file, and evaluate with that file.
    const beyond: number = mark.direction === "min" ? result.measured + 0.000001 : result.measured - 1;
    const moved = JSON.parse(text) as Record<string, Record<string, number>>;
    (moved[mark.group] as Record<string, number>)[mark.key] = beyond;
    const path = join(scratch("ev2"), "thresholds.json");
    writeFileSync(path, JSON.stringify(moved));
    const report = finish(analyse(loadInputs({ ...DEFAULT_EVAL_PATHS, ownerAnswers: null, thresholds: path })), answer).report;
    assert.deepEqual(report.decision.versions[ships].failed_marks, [mark.id], `moving ${mark.id} to ${beyond}`);
    assert.notEqual(report.thresholds_sha256, committed.thresholds_sha256);
    // At exactly the measured value the mark passes: the comparison includes the mark itself.
    (moved[mark.group] as Record<string, number>)[mark.key] = result.measured;
    assert.ok(decide(committed.measured, parseThresholds(moved, "test")).versions[ships].marks.find((entry) => entry.mark === mark.id)?.pass);
  }
  // Every numeric mark in the file is one the gate applies, and the gate applies no other.
  const file = JSON.parse(text) as { enrichment: object; matching: object };
  assert.deepEqual(MARKS.map((mark) => mark.id).sort(), [...Object.keys(file.enrichment).map((key) => `enrichment.${key}`), ...Object.keys(file.matching).map((key) => `matching.${key}`)].sort());

  // A file the gate does not fully understand is refused, never partly applied.
  const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;
  assert.throws(() => parseThresholds({ ...parsed, enrichment: { ...parsed["enrichment"], min_coverage: 0.5 } }, "t"), /not a pass-mark file/);
  const { min_precision: _dropped, ...withoutPrecision } = parsed["enrichment"] as Record<string, unknown>;
  assert.throws(() => parseThresholds({ ...parsed, enrichment: withoutPrecision }, "t"), /not a pass-mark file/);
  assert.throws(() => parseThresholds({ ...parsed, ship_rule: { ...parsed["ship_rule"], ship: "best" } }, "t"), /not a pass-mark file/);
});

const measuredWith = (accuracy: Record<Version, number | null>, overrides: Partial<Record<Version, Partial<NonNullable<Measured["enrichment"]>>>> = {}): Record<Version, Measured> =>
  Object.fromEntries(
    VERSIONS.map((version) => [
      version,
      {
        enrichment: version === "raw" ? null : { precision: 1, recovery: 1, recovery_without_tags: 1, missed_abstentions: 0, invalid_quotes: 0, ...overrides[version] },
        matching: { pairwise_accuracy: accuracy[version], wrongly_shown: 0 },
      },
    ]),
  ) as Record<Version, Measured>;

test("EV-3: the ship rule picks the simplest passing version within the margin of the best passing one", () => {
  const marks = parseThresholds(JSON.parse(readFileSync(DEFAULT_EVAL_PATHS.thresholds, "utf8")), "thresholds");
  const { margin } = marks.ship_rule;
  const floor = marks.matching.min_pairwise_accuracy;
  const top = Math.min(0.99, floor + 0.2);
  const ships = (measured: Record<Version, Measured>): string | null => decide(measured, marks).ships;

  // All pass, all within the margin: the first rung ships.
  assert.equal(ships(measuredWith({ raw: top - margin, table: top, model_where_thin: top, model_everywhere: top })), "raw");
  // The cheap rungs fall just outside the margin: the first rung inside it ships, not the best.
  assert.equal(ships(measuredWith({ raw: top - margin - 0.001, table: top - margin - 0.001, model_where_thin: top - margin / 2, model_everywhere: top })), "model_where_thin");
  // Only the top of the ladder is within the margin of itself.
  assert.equal(ships(measuredWith({ raw: floor, table: floor, model_where_thin: floor, model_everywhere: top })), "model_everywhere");
  // A version that fails a mark cannot ship, and is not "the best" either: the margin is taken from the best that passes.
  const failingBest = measuredWith({ raw: top - 0.1, table: top - 0.1, model_where_thin: top - 0.1, model_everywhere: top }, { model_everywhere: { invalid_quotes: marks.enrichment.max_invalid_quotes + 1 } });
  const decision = decide(failingBest, marks);
  assert.equal(decision.ships, "raw");
  assert.deepEqual(decision.versions.model_everywhere.failed_marks, ["enrichment.max_invalid_quotes"]);
  assert.equal(decision.best?.version, "raw");
  // The enrichment marks do not apply to raw, and do apply to the table.
  const tableFails = decide(measuredWith({ raw: top, table: top, model_where_thin: top, model_everywhere: top }, { table: { recovery_without_tags: 0 } }), marks);
  assert.equal(tableFails.versions.table.passed, false);
  assert.ok(tableFails.versions.raw.marks.filter((mark) => mark.mark.startsWith("enrichment.")).every((mark) => !mark.applies && mark.pass));
  // Below the pairwise mark nothing ships, and a rate over nothing is a failure, not a pass.
  const none = decide(measuredWith({ raw: floor - 0.01, table: floor - 0.01, model_where_thin: floor - 0.01, model_everywhere: null }), marks);
  assert.equal(none.passed, false);
  assert.equal(none.ships, null);
  assert.match(none.reason, /No version passes its marks/);
  assert.ok(none.versions.model_everywhere.failed_marks.includes("matching.min_pairwise_accuracy"));
  const emptyRate = decide(measuredWith({ raw: top, table: top, model_where_thin: top, model_everywhere: top }, { model_where_thin: { precision: null } }), marks);
  assert.deepEqual(emptyRate.versions.model_where_thin.failed_marks, ["enrichment.min_precision"]);
});

const game = (id: string, themes: string[], mechanics: string[], family: string | null = null): TruthGame => ({ game_id: id, themes, mechanics, family_id: family }) as unknown as TruthGame;

test("EV-4: the grade of a pair follows the plan's rule, and pairwise accuracy counts related above unrelated only", () => {
  const anchor = game("a", ["western", "adventure"], ["paylines", "free_spins", "multipliers", "sticky_wilds"]);
  const cases: [TruthGame, string][] = [
    [game("strong", ["western"], ["ways", "free_spins", "multipliers"]), "strong"],
    [game("one-feature", ["adventure"], ["ways", "free_spins"]), "related"],
    [game("win-system", ["western"], ["paylines", "pick_bonus"]), "related"],
    [game("theme-only", ["western"], ["ways", "pick_bonus"]), "weak"],
    [game("features-only", ["horror"], ["ways", "free_spins", "multipliers"]), "weak"],
    // Without a shared theme, the same win system and one shared feature are not enough.
    [game("near-miss", ["horror"], ["paylines", "free_spins"]), "unrelated"],
    [game("nothing", ["sci_fi"], ["cluster_pays", "cascading_reels"]), "unrelated"],
  ];
  for (const [other, expected] of cases) {
    assert.equal(grade(anchor, other), expected, other.game_id);
    assert.equal(grade(other, anchor), expected, `${other.game_id}, the other way round`);
  }

  // Four games on a line: the anchor, a related game, an unrelated game, and a weak one that must not count.
  const toy = (related: number, unrelated: number, weak: number, sibling: number): number => {
    const games = [anchor, cases[0]?.[0], cases[6]?.[0], cases[3]?.[0], game("sibling", ["sci_fi"], ["cluster_pays"], "fam")].map((entry) => entry as TruthGame);
    (games[0] as TruthGame).family_id = "fam";
    const vectors = new Float32Array([1, 0, related, 0, unrelated, 0, weak, 0, sibling, 0]);
    const index = { manifest: { dimensions: 2 }, records: games.map((entry) => ({ game_id: entry.game_id })), vectors: { raw: vectors } } as unknown as Index;
    const truth: Truth = { games: new Map(games.map((entry) => [entry.game_id, entry])), rows: new Map() };
    const [first] = pairwiseByGame(index, truth, "raw");
    assert.equal(first?.pairs, 1, "one related game against one unrelated game: the weak game and the family member are left out");
    (games[0] as TruthGame).family_id = null;
    return first?.wins ?? -1;
  };
  assert.equal(toy(0.9, 0.5, 0.99, 0.99), 1);
  assert.equal(toy(0.5, 0.9, 0.1, 0.1), 0);
  assert.equal(toy(0.5, 0.5, 0.1, 0.1), 0, "a tie is not a win");

  const summary = summarisePairwise([
    { game_id: "x", wins: 9, pairs: 10 },
    { game_id: "y", wins: 1, pairs: 90 },
    { game_id: "z", wins: 0, pairs: 0 },
  ]);
  assert.deepEqual(summary.pooled, { count: 10, of: 100, rate: 0.1 });
  assert.deepEqual(summary.per_game, { mean: 0.455556, games: 2, games_without_a_pair: 1 });
});

/** The committed index with one record changed in memory. */
function withRecord(change: (record: IndexRecord, all: IndexRecord[]) => void, pick: (record: IndexRecord) => boolean): EvalInputs {
  const fresh = inputs();
  const records = structuredClone(fresh.index.records) as IndexRecord[];
  const target = records.find(pick);
  if (target === undefined) throw new Error("the test found no record to change");
  change(target, records);
  return { ...fresh, index: { ...fresh.index, records } };
}

test("EV-4: an invented quote, a quote cut from inside a word, a label on a field that should be silent and a lost label each move their own measure", async () => {
  const answers = await storedAnswers(base);
  const report = (changed: EvalInputs) => {
    const analysis = analyse(changed);
    // Any new question is answered "no": the plan did not assign the label.
    return finish(analysis, (question) => answers.get(question.id) ?? { answer: "no", said: "no", words: "", note: null }).report;
  };
  const clean = report(inputs());
  for (const version of LABEL_VERSIONS) assert.equal(clean.enrichment[version].invalid_quotes.count, 0);
  const withLabels = (record: IndexRecord): boolean => (record.versions.model_everywhere.themes?.labels.length ?? 0) > 0 && (record.canonical.description?.length ?? 0) > 40;

  // A quote that is not in the record at all.
  const invented = report(withRecord((record) => ((record.versions.model_everywhere.themes?.labels[0] as { quote: string }).quote = "words that are not in the record"), withLabels));
  assert.equal(invented.enrichment.model_everywhere.invalid_quotes.count, 1);
  assert.equal(invented.enrichment.model_where_thin.invalid_quotes.count, 0);
  assert.ok(invented.decision.versions.model_everywhere.failed_marks.includes("enrichment.max_invalid_quotes"));
  assert.notEqual(invented.decision.ships, "model_everywhere");

  // A piece cut from inside a word of the description: the characters are there, the words are not.
  const fragment = report(
    withRecord((record) => {
      const word = /[A-Za-z]{6,}/.exec(record.canonical.description ?? "")?.[0] ?? "";
      assert.ok(word.length >= 6);
      const label = record.versions.model_everywhere.themes?.labels[0] as { quote: string; source_field: string };
      label.quote = word.slice(1, 4);
      label.source_field = "description";
      assert.ok((record.canonical.description ?? "").includes(label.quote));
    }, withLabels),
  );
  assert.equal(fragment.enrichment.model_everywhere.invalid_quotes.count, 1, "a fragment of a word was accepted as a quote");
  assert.equal(isWordForWord("a sphinx and its riddles", "ri"), false);
  assert.equal(isWordForWord("a sphinx and its riddles", "its riddles"), true);
  assert.equal(isWordForWord("a sphinx and its riddles", "sphinx and it"), false);
  assert.equal(isWordForWord("wins paid along 20 fixed paylines.", "20 fixed paylines"), true);
  assert.equal(isWordForWord("Its Riddles", "its riddles"), false);

  // A label asserted where the plan expects silence.
  const silent = base.inputs.index.records.find((record) => {
    const row = base.inputs.truth.rows.get(record.canonical.source.record_id);
    return row?.expected_abstain.mechanics === true && record.versions.model_everywhere.mechanics?.status === "abstained";
  });
  assert.ok(silent !== undefined, "no record with an expected abstention to test on");
  const donor = base.inputs.index.records.find((record) => (record.versions.model_everywhere.mechanics?.labels.length ?? 0) > 0)?.versions.model_everywhere.mechanics?.labels[0];
  assert.ok(donor !== undefined);
  const spoke = report(
    withRecord((record) => {
      record.versions.model_everywhere.mechanics = { status: "asserted", conflict_reason: null, labels: [structuredClone(donor)] };
    }, (record) => record.game_id === silent.game_id),
  );
  assert.equal(spoke.enrichment.model_everywhere.missed_abstentions.count, clean.enrichment.model_everywhere.missed_abstentions.count + 1);
  assert.equal(spoke.disagreements.count, clean.disagreements.count + 1);
  // The plan calls that label unknowable or never assigned; an unknowable one is left out of precision, as the plan says.
  const planted = spoke.disagreements.list.find((entry) => entry.game_id === silent.game_id);
  assert.ok(planted !== undefined);
  // A disagreement is one of the owner's questions before any control label is, so its answer is held back:
  // it stays out of the reported precision and counts as wrong for the pass mark.
  const precision = spoke.enrichment.model_everywhere.precision;
  const before = clean.enrichment.model_everywhere.precision;
  if (planted.plan === "unknowable") assert.equal(precision.left_out.unknowable, before.left_out.unknowable + 1);
  else {
    assert.equal(planted.reviewer, HELD_BACK);
    assert.deepEqual([precision.count, precision.of], [before.count, before.of]);
    assert.equal(precision.left_out.held_back, before.left_out.held_back + 1);
    assert.deepEqual([precision.gate.count, precision.gate.of], [before.gate.count, before.gate.of + 1]);
    assert.equal(spoke.measured.model_everywhere.enrichment?.precision, precision.gate.rate);
  }

  // Labels lost: recovery falls by exactly the labels removed that the plan calls recoverable.
  const lost = report(
    withRecord((_record, all) => {
      for (const record of all) for (const field of ["themes", "mechanics"] as const) (record.versions.model_everywhere[field] as { labels: unknown[] }).labels = [];
    }, withLabels),
  );
  assert.equal(lost.enrichment.model_everywhere.recovery.count, 0);
  assert.equal(lost.enrichment.model_everywhere.recovery.of, clean.enrichment.model_everywhere.recovery.of);
  assert.equal(lost.enrichment.model_everywhere.precision.rate, null);
  assert.deepEqual(
    lost.decision.versions.model_everywhere.failed_marks.filter((mark) => mark.startsWith("enrichment.")),
    ["enrichment.min_precision", "enrichment.min_recovery", "enrichment.min_recovery_without_tags"],
  );
  assert.deepEqual(lost.enrichment.model_where_thin, clean.enrichment.model_where_thin);
});

test("EV-4: counts stand beside every rate, and the measures agree with a second count made here", async () => {
  const answers = await storedAnswers(base);
  const report = finish(base, (question) => answers.get(question.id) as ReviewerAnswer).report;
  const { index, truth } = base.inputs;
  for (const version of LABEL_VERSIONS) {
    let recoverable = 0;
    let recovered = 0;
    let withoutTags = 0;
    let recoveredWithoutTags = 0;
    let asserted = 0;
    for (const record of index.records) {
      const row = truth.rows.get(record.canonical.source.record_id);
      assert.ok(row !== undefined);
      for (const field of ["themes", "mechanics"] as const) {
        const labels = new Set(record.versions[version][field]?.labels.map((label) => label.label as string));
        asserted += labels.size;
        for (const entry of row.recoverable[field]) {
          recoverable += 1;
          if (labels.has(entry.term)) recovered += 1;
          if (!entry.via.includes("source_tags")) {
            withoutTags += 1;
            if (labels.has(entry.term)) recoveredWithoutTags += 1;
          }
        }
      }
    }
    const measured = report.enrichment[version];
    assert.deepEqual([measured.recovery.count, measured.recovery.of], [recovered, recoverable]);
    assert.deepEqual([measured.recovery_without_tags.count, measured.recovery_without_tags.of], [recoveredWithoutTags, withoutTags]);
    assert.equal(measured.labels_asserted, asserted);
    assert.equal(measured.missed.not_asserted + measured.missed.conflict_rule, recoverable - recovered);
    const leftOut = measured.precision.left_out;
    assert.equal(measured.precision.of + leftOut.unclear + leftOut.unknowable + leftOut.held_back, asserted, "every asserted label is counted once: decided, unclear, unknowable or held back");
    assert.equal(measured.precision.gate.of, measured.precision.of + leftOut.held_back);
    assert.ok(recoverable > 100 && withoutTags > 10);
  }
  for (const version of VERSIONS) {
    const row = report.matching[version];
    assert.ok(row.pairwise.pooled.of > 1000 && row.pairwise.per_game.games > 0);
    assert.equal(row.gate_accuracy, Math.min(row.pairwise.pooled.rate ?? 0, row.pairwise.per_game.mean ?? 0));
    const split = Object.values(row.by_condition);
    assert.equal(split.reduce((sum, part) => sum + part.games_in_condition, 0), index.records.length);
    assert.equal(split.reduce((sum, part) => sum + part.pooled.of, 0), row.pairwise.pooled.of);
    assert.equal(row.by_thin.thin.games_in_condition, index.records.filter((record) => record.thin).length);
    assert.equal(row.wrongly_shown.results_judged, Object.values(row.wrongly_shown.by_grade).reduce((sum, count) => sum + count, 0));
  }
  // The check games are judged on what the service core returns, on the largest brand.
  assert.equal(report.check_games.games.length, 6);
  const live = (brand: string): number => [...(base.inputs.offerings.statusByBrand.get(brand)?.values() ?? [])].filter((status) => status === "live").length;
  for (const brand of base.inputs.offerings.brands) assert.ok(live(report.check_games.brand) >= live(brand));
});

test("EV-5: a reviewer's yes counts only with a word-for-word quote from the text it was shown; anything else is recorded as unclear", () => {
  const templates = readTemplates(DEFAULT_EVAL_PATHS.plan);
  const record = base.inputs.index.records.find((candidate) => (candidate.canonical.description?.length ?? 0) > 80) as IndexRecord;
  const question = labelQuestion(templates, record, "free_spins");
  const shown = record.versions.raw.text;
  const sentence = (record.canonical.description_as_delivered ?? "").split(". ");
  const [first, second] = [sentence[0] as string, sentence[1] as string];
  const answered = (answer: unknown) => {
    const result = interpret(envelope(answer), question);
    assert.equal(result.outcome, "ok");
    return result.outcome === "ok" ? result.answer : null;
  };
  assert.ok(shown.includes(first) && shown.includes(second));
  assert.deepEqual(answered({ answer: "yes", quote: first }), { answer: "yes", said: "yes", words: first, note: null });
  // Two real phrases stitched into one "quote" are not word for word.
  for (const quote of [`${first.slice(0, 20)} ... ${second.slice(0, 20)}`, `${first.split(" ").slice(0, 3).join(" ")} ${second.split(" ").slice(0, 3).join(" ")}`, "", "   ", first.toUpperCase(), first.slice(2, 12), "wins are multiplied by a factor"]) {
    assert.deepEqual(answered({ answer: "yes", quote }), { answer: "unclear", said: "yes", words: quote, note: "yes_without_word_for_word_quote" }, `"${quote}"`);
  }
  assert.equal(answered({ answer: "no", quote: "" })?.answer, "no");
  assert.equal(answered({ answer: "unclear", quote: "" })?.answer, "unclear");
  // An answer that cannot be read is rejected under its own name, and never repaired.
  assert.equal(interpret(envelope({ answer: "maybe", quote: "" }), question).outcome, "invalid_output");
  assert.equal(interpret(envelope({ answer: "yes" }), question).outcome, "invalid_output");
  assert.equal(interpret(envelope({ answer: "yes", quote: first, confidence: 1 }), question).outcome, "invalid_output");
  assert.equal(interpret({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, question).outcome, "incomplete");
  assert.equal(interpret({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", text: "no" }] }] }, question).outcome, "refusal");

  // The question is the plan's text with the blanks filled, shows the record as delivered, and does not say who asserted the label.
  assert.ok(question.text.startsWith("Here is the text a game supplier sent for one slot game.\n\n\""));
  assert.ok(question.text.includes(`"${shown}"`));
  assert.ok(question.text.includes("Label: free spins. It means: a bonus round of spins that cost nothing."));
  assert.ok(!/\{[a-z ,]+\}/.test(question.text.replace(shown, "")), "a blank was left unfilled");
  assert.ok(!/model|pipeline|table|synonym|gpt/i.test(question.text.replace(shown, "")));
  const plan = readFileSync(DEFAULT_EVAL_PATHS.plan, "utf8");
  for (const line of question.text.replace(`"${shown}"`, "").split("\n").filter((part) => part.length > 0 && !part.startsWith("Label:"))) assert.ok(plan.includes(line), `not the plan's words: ${line}`);
  // One question per game and label, whichever versions assert it, asked in an order that the seed fixes.
  assert.equal(new Set(base.questions.map((entry) => entry.id)).size, base.questions.length);
  assert.deepEqual(analyse(inputs()).questions.map((entry) => entry.id), base.questions.map((entry) => entry.id));
  assert.notDeepEqual(base.questions.map((entry) => entry.id), [...base.questions.map((entry) => entry.id)].sort());
});

test("EV-5: the control is twenty labels the plan and every version agree on, half each way, and agreement is a count", async () => {
  const answers = await storedAnswers(base);
  const report = finish(base, (question) => answers.get(question.id) as ReviewerAnswer).report;
  assert.equal(report.control.size, 20);
  assert.equal(base.control.filter((item) => item.agreed === "applies").length, 10);
  assert.equal(base.control.filter((item) => item.agreed === "does_not_apply").length, 10);
  const { index, truth } = base.inputs;
  let agreed = 0;
  let reported = 0;
  for (const item of base.control) {
    const record = index.records.find((candidate) => candidate.game_id === item.game_id) as IndexRecord;
    const row = truth.rows.get(record.canonical.source.record_id);
    const inPlan = row?.recoverable[item.field].some((entry) => entry.term === item.label) ?? false;
    const assigned = (truth.games.get(item.game_id)?.[item.field] as string[]).includes(item.label);
    const asserting = LABEL_VERSIONS.filter((version) => record.versions[version][item.field]?.labels.some((label) => label.label === item.label)).length;
    if (item.agreed === "applies") assert.ok(inPlan && asserting === LABEL_VERSIONS.length, `${item.game_id} ${item.label}`);
    else assert.ok(!assigned && asserting === 0, `${item.game_id} ${item.label}`);
    // The count covers the labels whose answers are not held back for the owner's check.
    if (base.heldBack.has(item.question_id)) continue;
    reported += 1;
    const given = answers.get(item.question_id)?.answer;
    if ((item.agreed === "applies" && given === "yes") || (item.agreed === "does_not_apply" && given === "no")) agreed += 1;
  }
  assert.equal(report.control.reported, reported);
  assert.equal(report.control.held_back, 20 - reported);
  assert.equal(report.control.list.length, reported);
  assert.equal(report.control.agreed, agreed);
  assert.equal(report.control.applies.agreed + report.control.does_not_apply.agreed, agreed);
  assert.equal(report.control.applies.of + report.control.does_not_apply.of, reported);
});

const sayAll = (word: "yes" | "no" | "unclear"): ReviewerAnswer => ({ answer: word, said: word, words: word === "yes" ? "some words" : "", note: null });

test("EV-6: while the owner has not answered, nothing the evaluation writes depends on the reviewer's answers to his six questions", async () => {
  const six = new Set(ownerQuestions(base).map((entry) => entry.question.id));
  assert.equal(six.size, 6);
  const others = new Map<string, ReviewerAnswer>();
  for (const question of base.questions) {
    if (!six.has(question.id)) others.set(question.id, await obtainAnswer(question, { dir: DEFAULT_EVAL_PATHS.answersDir, live: null, log: quiet }));
  }
  // The same evaluation, with the reviewer answering the six every way it could. What is written must not move.
  const written = (["yes", "no", "unclear"] as const).map((word) => {
    const { report, verdictFor } = finish(base, (question) => (six.has(question.id) ? sayAll(word) : (others.get(question.id) as ReviewerAnswer)));
    return JSON.stringify({ report, verdict: verdictFor("report.json", "0") });
  });
  assert.equal(written[0], written[1], "the report or the verdict changes with the reviewer's answers to the owner's questions: they can be worked out from it");
  assert.equal(written[0], written[2], "the report or the verdict changes with the reviewer's answers to the owner's questions: they can be worked out from it");
  // And a verdict was reached all the same.
  assert.ok((JSON.parse(written[0] as string) as { verdict: { passed: boolean; ships: string | null } }).verdict.ships !== null);
});

test("EV-6: while the owner has not answered, the reviewer's answers to his six are not read, not asked for and in no count, a tree that holds one is refused, and the check is reported as outstanding", async () => {
  const six = ownerQuestions(base);
  const ids = new Set(six.map((entry) => entry.question.id));
  assert.deepEqual([...base.heldBack].sort(), [...ids].sort());
  // The state is built here: a tree without the six and without the owner's answers.
  const tree = outstandingTree("ev6-outstanding");
  for (const id of ids) assert.ok(!existsSync(answerPath(tree.answersDir, id)));
  // Not read: the command finishes on that tree, where the six are not there to be read,
  // and so does an evaluation in which asking for one of them is an error.
  const ran = cli(treeArgs(tree, tree.noOwnerAnswers));
  assert.equal(ran.status, 0, ran.stderr);
  const answers = await storedAnswers(base);
  const open = finish(base, (question) => {
    if (ids.has(question.id)) throw new Error(`the held-back answer to ${question.id} was asked for`);
    return answers.get(question.id) as ReviewerAnswer;
  }).report;
  // What the command wrote is that report, and what it printed says the same.
  assert.equal(readFileSync(join(tree.outDir, open.prompt_version, "report.json"), "utf8"), `${JSON.stringify(open, null, 2)}\n`);
  assert.match(ran.stdout, /Owner's check: Outstanding: the owner has not answered his 6 questions/);
  assert.match(ran.stdout, /reviewer's answer held back until the owner has answered; the pass mark counts it as wrong meanwhile/);
  assert.ok(ran.stdout.includes(`over ${open.reviewer.answered} questions; 6 more are held back.`) && ran.stdout.includes(`${open.reviewer.answered} answers are stored in the tree`));
  // Reported plainly, with nothing about the six but how many there are and where they come from.
  assert.equal(open.owner_check.status, "outstanding");
  assert.match(open.owner_check.note, /^Outstanding: the owner has not answered his 6 questions.*held back/);
  assert.equal(open.owner_check.of, 6);
  assert.equal(open.owner_check.matched, null);
  assert.deepEqual(open.owner_check.questions, []);
  assert.equal(open.owner_check.from_disagreements, Math.min(6, open.disagreements.count));
  assert.equal(open.owner_check.from_control, 6 - open.owner_check.from_disagreements);
  if (open.disagreements.count < 6) assert.match(open.owner_check.note, /drawn from the control sample/);
  // Every disagreement is among the six before any control label is.
  for (const entry of open.disagreements.list.slice(0, 6)) assert.ok(ids.has(entry.question_id));
  // In no count: the control and the reviewer's totals cover the other questions only, and no list holds one of the six with an answer.
  assert.equal(open.control.reported + open.control.held_back, open.control.size);
  assert.equal(open.control.held_back, open.owner_check.from_control);
  assert.ok(open.control.list.every((item) => !ids.has(item.question_id)));
  assert.equal(open.reviewer.held_back, 6);
  assert.equal(open.reviewer.answered, open.reviewer.questions - 6);
  assert.equal(open.reviewer.answers.yes + open.reviewer.answers.no + open.reviewer.answers.unclear, open.reviewer.answered);
  assert.ok(open.reviewer.unclear.every((entry) => !ids.has(entry.question_id)));
  for (const entry of open.disagreements.list.filter((item) => ids.has(item.question_id))) assert.equal(entry.reviewer, HELD_BACK);
  // The derivation that worked on the earlier report finds nothing to start from.
  for (const id of ids) assert.equal(open.control.list.find((item) => item.question_id === id), undefined);
  for (const version of LABEL_VERSIONS) {
    const precision = open.enrichment[version].precision;
    const asked = open.disagreements.list.filter((entry) => ids.has(entry.question_id) && entry.plan === "not_assigned" && entry.asserted_by.some((by) => by.version === version)).length;
    assert.equal(precision.left_out.held_back, asked);
    assert.equal(precision.gate.of, precision.of + asked, "a held-back label must count as wrong for the pass mark");
  }

  // A stored answer to one of the six, appearing in the tree while the check is outstanding, stops the evaluation.
  const leaky = scratch("ev6-leak");
  cpSync(tree.answersDir, leaky, { recursive: true });
  writeAnswer(leaky, six[0]?.question as Question, { answer: "no", quote: "" });
  const leakOut = scratch("ev6-leak-out");
  const stopped = cli(treeArgs({ ...tree, answersDir: leaky, outDir: leakOut }, tree.noOwnerAnswers));
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /is stored in .* while the owner has not answered his check/);
  assert.deepEqual(readdirSync(leakOut), [], "something was written although the run was refused");

  // Not asked for: a live run, while the check is outstanding, makes no call for the six. Here it has nothing to ask at all.
  const dir = scratch("ev6-live");
  cpSync(tree.answersDir, dir, { recursive: true });
  let calls = 0;
  const live: Live = { apiKey: "test-key", budget: new Budget(REVIEWER_MAX_USD, 0), retryDelayMs: 0, transport: () => ((calls += 1), Promise.resolve({ status: 500, body: {} })) };
  await runEvaluation({ ...tree, answersDir: dir, outDir: scratch("ev6-live-out") }, live, quiet);
  assert.equal(calls, 0);
  for (const id of ids) assert.ok(!existsSync(answerPath(dir, id)));

  // The owner's check needs a person at a terminal, and writes nothing without one.
  const out = join(scratch("ev6"), "owner-check.json");
  const piped = spawnSync(process.execPath, ["eval/owner-check.ts", "--out", out], { encoding: "utf8", input: "y\ny\ny\ny\ny\ny\n", timeout: 60_000 });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /needs a person at a terminal/);
  assert.ok(!existsSync(out));
});

test("EV-6: once the owner has answered, the reviewer's six are brought back or asked, and the answer he had been told beforehand is counted apart from the blind ones", async () => {
  const six = ownerQuestions(base);
  const disclosed = readHeldBack(DEFAULT_EVAL_PATHS.heldBack).disclosed_to_the_owner_before_he_answered.map((entry) => entry.question_id);
  assert.equal(disclosed.length, 1, "the record of what the owner was told has changed");
  assert.ok(six.some((entry) => entry.question.id === disclosed[0]));
  const stored = await storedAnswers(base);
  // The owner says yes to everything; the reviewer, in this test, says yes to the first three in id order and no to the rest.
  const order = six.map((entry) => entry.question.id).sort();
  const reviewerSays = new Map(order.map((id, position) => [id, sayAll(position < 3 ? "yes" : "no")]));
  const answered = analyse({ ...inputs(), ownerAnswers: ownerFile(base, six.map(() => "yes"), "2026-11-19") });
  assert.equal(answered.heldBack.size, 0);
  const report = finish(answered, (question) => reviewerSays.get(question.id) ?? (stored.get(question.id) as ReviewerAnswer)).report;
  assert.equal(report.owner_check.status, "answered");
  assert.equal(report.owner_check.matched, 3);
  const blindMatches = order.filter((id, position) => position < 3 && id !== disclosed[0]).length;
  assert.deepEqual(report.owner_check.blind, { of: 5, matched: blindMatches });
  assert.deepEqual(report.owner_check.not_blind, { of: 1, matched: 3 - blindMatches, question_ids: disclosed });
  assert.equal(report.owner_check.questions.length, 6);
  assert.equal(report.owner_check.questions.find((entry) => entry.question_id === disclosed[0])?.blind, false);
  assert.match(report.owner_check.note, new RegExp(`^Answered: on the 5 questions he answered blind, the reviewer matched the owner on ${blindMatches}\\.`));
  assert.match(report.owner_check.note, /had been told the reviewer's answer to it, so that answer is not a blind check/);
  // Nothing is held back any more: the control is over all twenty, and every disagreement shows its answer.
  assert.equal(report.control.held_back, 0);
  assert.equal(report.control.reported, 20);
  assert.equal(report.reviewer.held_back, 0);
  assert.ok(report.disagreements.list.every((entry) => typeof entry.reviewer !== "string"));
  // The verdict is the one reached while the check was outstanding, whatever the six turn out to be.
  const outstanding = finish(base, (question) => stored.get(question.id) as ReviewerAnswer).report;
  assert.equal(report.decision.ships, outstanding.decision.ships);
  for (const word of ["yes", "no", "unclear"] as const) {
    const other = finish(answered, (question) => (reviewerSays.has(question.id) ? sayAll(word) : (stored.get(question.id) as ReviewerAnswer))).report;
    assert.equal(other.decision.ships, outstanding.decision.ships, `the verdict would change if the reviewer said ${word}`);
  }

  // Answers to other questions, or to a question whose text has changed, are refused.
  const file = ownerFile(base, six.map(() => "yes"), "2026-11-19");
  const other = { ...file, answers: file.answers.map((entry, position) => (position === 0 ? { ...entry, question_id: "label.nothing.fantasy" } : entry)) };
  assert.throws(() => finish(analyse({ ...inputs(), ownerAnswers: other }), (question) => stored.get(question.id) ?? sayAll("no")), /other questions than the six/);
  const changed = { ...file, answers: file.answers.map((entry, position) => (position === 0 ? { ...entry, question_sha256: "0".repeat(64) } : entry)) };
  assert.throws(() => finish(analyse({ ...inputs(), ownerAnswers: changed }), (question) => stored.get(question.id) ?? sayAll("no")), /text has since changed/);

  // The command, on a tree built here that holds the owner's answers and no reviewer answers to his six,
  // says where they are and how to bring them back, and writes nothing.
  const tree = outstandingTree("ev6-answered");
  const ownerPath = join(scratch("ev6-owner"), "owner-check.json");
  writeFileSync(ownerPath, JSON.stringify(file));
  const missing = cli(treeArgs(tree, ownerPath));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /the owner has answered, and the reviewer's answers to 6 of his questions are not in/);
  assert.match(missing.stderr, /git checkout [0-9a-f]{40} -- .*label\./);
  assert.match(missing.stderr, /npm run eval -- --live/);
  assert.ok(!existsSync(tree.outDir), "something was written although the reviewer's six answers were missing");
  // Asked live, exactly the six are asked, stored, and scored.
  const dir = scratch("ev6-reveal");
  cpSync(tree.answersDir, dir, { recursive: true });
  const asked: string[] = [];
  const usage = { input_tokens: 200, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } };
  const live: Live = {
    apiKey: "test-key",
    budget: new Budget(REVIEWER_MAX_USD, totalSpend(dir, readHeldBack(tree.heldBack)).usd),
    retryDelayMs: 0,
    transport: (_url, _key, request) => {
      asked.push((request as { input: string }).input);
      return Promise.resolve({ status: 200, body: { ...(envelope({ answer: "no", quote: "" }) as object), usage } });
    },
  };
  const revealed = await runEvaluation({ ...tree, ownerAnswers: ownerPath, answersDir: dir }, live, quiet);
  assert.deepEqual([...asked].sort(), six.map((entry) => entry.question.text).sort());
  for (const { question } of six) assert.ok(existsSync(answerPath(dir, question.id)));
  assert.equal(revealed.report.owner_check.status, "answered");
  assert.equal(revealed.report.owner_check.matched, 0);
  // With the six in the tree the command needs no key, holds nothing back, and says how the check came out.
  const answeredRun = cli(treeArgs({ ...tree, answersDir: dir, outDir: scratch("ev6-answered-out") }, ownerPath));
  assert.equal(answeredRun.status, 0, answeredRun.stderr);
  assert.match(answeredRun.stdout, /Owner's check: Answered: on the 5 questions he answered blind, the reviewer matched the owner on 0\. Not blind: .* \(the reviewer did not match it\); it is counted apart\./);
  assert.ok(!/held back/.test(answeredRun.stdout), "the command still reports something as held back after the owner has answered");
  assert.ok(answeredRun.stdout.includes(`over ${base.questions.length} questions.`) && answeredRun.stdout.includes(`${base.questions.length} answers are stored in the tree`));
});

test("EV-6: in the committed tree the owner has answered: his six answers, the reviewer's six, the record of what was held back and the committed report agree", async () => {
  const committedInputs = loadInputs(DEFAULT_EVAL_PATHS);
  const owner = committedInputs.ownerAnswers;
  assert.ok(owner !== null, `${String(DEFAULT_EVAL_PATHS.ownerAnswers)} holds no answers: the committed tree is not in the answered state`);
  const analysis = analyse(committedInputs);
  assert.equal(analysis.heldBack.size, 0);
  const six = ownerQuestions(analysis);
  // The record of what was held back names these six, says they are back, and they are: one stored answer per question, and no other file.
  const record = readHeldBack(DEFAULT_EVAL_PATHS.heldBack);
  assert.deepEqual([...record.question_ids].sort(), six.map((entry) => entry.question.id).sort());
  assert.ok(record.brought_back !== null, "the record still says the reviewer's six answers are out of the tree");
  assert.deepEqual(readdirSync(DEFAULT_EVAL_PATHS.answersDir).sort(), analysis.questions.map((question) => `${question.id}.json`).sort());
  // A second count, made here from the owner's file and the stored answers.
  const disclosed = new Set(record.disclosed_to_the_owner_before_he_answered.map((entry) => entry.question_id));
  const counted = { blind: { of: 0, matched: 0 }, not_blind: { of: 0, matched: 0 } };
  for (const { question } of six) {
    const his = owner.answers.find((entry) => entry.question_id === question.id)?.answer;
    assert.ok(his !== undefined, `the owner has no answer to ${question.id}`);
    const its = (await obtainAnswer(question, { dir: DEFAULT_EVAL_PATHS.answersDir, live: null, log: quiet })).answer;
    const side = disclosed.has(question.id) ? counted.not_blind : counted.blind;
    side.of += 1;
    if (his === its) side.matched += 1;
  }
  const verdict = JSON.parse(readFileSync(join(DEFAULT_EVAL_PATHS.outDir, "verdict.json"), "utf8")) as { report: { path: string } };
  const text = readFileSync(join(DEFAULT_EVAL_PATHS.outDir, verdict.report.path), "utf8");
  const committed = JSON.parse(text) as Report;
  assert.equal(committed.owner_check.status, "answered");
  assert.equal(committed.owner_check.questions.length, six.length);
  assert.deepEqual(committed.owner_check.blind, counted.blind);
  assert.deepEqual(committed.owner_check.not_blind, { ...counted.not_blind, question_ids: [...disclosed] });
  assert.equal(committed.owner_check.matched, counted.blind.matched + counted.not_blind.matched);
  assert.ok(committed.owner_check.note.startsWith(`Answered: on the ${counted.blind.of} questions he answered blind, the reviewer matched the owner on ${counted.blind.matched}.`));
  // Nothing is held back any more, in any count or list.
  assert.ok(!text.includes(HELD_BACK) && !/"held_back": [1-9]/.test(text), "the committed report still holds something back");
  assert.deepEqual([committed.control.reported, committed.control.size], [20, 20]);
  assert.deepEqual([committed.reviewer.answered, committed.reviewer.held_back], [analysis.questions.length, 0]);
  for (const version of LABEL_VERSIONS) {
    const precision = committed.enrichment[version].precision;
    assert.deepEqual([precision.gate.count, precision.gate.of], [precision.count, precision.of], "with nothing held back the pass mark reads the precision that is shown");
  }
});

test("EV-7: a live reviewer call is refused before it could pass the spend limit, stores what it got, and leaves the key in no file", async () => {
  const dir = scratch("ev7");
  const question = base.questions[0] as Question;
  const key = "test-key-that-must-not-be-stored";
  let calls = 0;
  const live = (maxUsd: number, spent: number, body: unknown, status = 200): Live => ({
    apiKey: key,
    budget: new Budget(maxUsd, spent),
    retryDelayMs: 0,
    transport: (_url, apiKey, request) => {
      calls += 1;
      assert.equal(apiKey, key);
      assert.equal((request as { model: string }).model, REVIEWER_MODEL);
      assert.equal((request as { input: string }).input, question.text);
      assert.ok(!("instructions" in (request as object)) && !("reasoning" in (request as object)));
      return Promise.resolve({ status, body });
    },
  });
  // Already at the limit: no call is made and nothing is stored.
  await assert.rejects(obtainAnswer(question, { dir, live: live(REVIEWER_MAX_USD, REVIEWER_MAX_USD - 0.0001, envelope({ answer: "no", quote: "" })), log: quiet }), SpendLimitReached);
  assert.equal(calls, 0);
  assert.ok(!existsSync(answerPath(dir, question.id)));

  // Two unreadable answers, then the question is settled as unclear; both attempts are kept and counted.
  const usage = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } };
  const bad = { ...(envelope("not an answer") as object), usage };
  const given = await obtainAnswer(question, { dir, live: live(REVIEWER_MAX_USD, 0, bad), log: quiet });
  assert.deepEqual(given, { answer: "unclear", said: null, words: "", note: "no_accepted_answer" });
  assert.equal(calls, 2);
  const spend = storedSpend(dir);
  assert.equal(spend.calls, 2);
  assert.equal(spend.usd, 0.0004);
  // Replayed without a key, it is the same answer and no call.
  assert.deepEqual(await obtainAnswer(question, { dir, live: null, log: quiet }), given);
  assert.equal(calls, 2);
  // An API error is stored without its body, and the key is in no file.
  const second = base.questions[1] as Question;
  await assert.rejects(obtainAnswer(second, { dir, live: live(REVIEWER_MAX_USD, 0, { error: { message: `bad key ${key}`, type: "invalid_request_error", code: "invalid_api_key" } }, 401), log: quiet }), /kept failing/);
  for (const name of readdirSync(dir)) assert.ok(!readFileSync(join(dir, name), "utf8").includes(key), `${name} holds the key`);
  rmSync(dir, { recursive: true });

  // While the owner's six are out of the tree, on a tree built here in that state, what they cost is still
  // counted against the limit, as the one total the record holds.
  const tree = outstandingTree("ev7-outstanding");
  const heldBack = readHeldBack(tree.heldBack);
  const without = storedSpend(tree.answersDir);
  assert.equal(without.files, questionsToAnswer(base).length);
  const total = totalSpend(tree.answersDir, heldBack);
  assert.equal(total.calls, without.calls + heldBack.spend.calls);
  assert.equal(total.usd, Math.round((without.usd + heldBack.spend.usd) * 1e6) / 1e6);
  assert.ok(without.usd > 0 && heldBack.spend.usd > 0 && total.usd <= REVIEWER_MAX_USD);
  // Restored in part, their cost could be counted wrongly: that is refused.
  const partly = scratch("ev7-partly");
  cpSync(tree.answersDir, partly, { recursive: true });
  const one = ownerQuestions(base).find((entry) => heldBack.question_ids.includes(entry.question.id))?.question;
  assert.ok(one !== undefined);
  writeAnswer(partly, one, { answer: "no", quote: "" });
  assert.throws(() => totalSpend(partly, heldBack), /restore all of them or none/);
  // Back in the tree, as they are in the committed one, the six are counted from their own files like any other answer.
  // That comes to the same total the record gave while they were out, within the limit, with every stored answer one the evaluation uses.
  const committed = storedSpend(DEFAULT_EVAL_PATHS.answersDir);
  assert.equal(committed.files, base.questions.length);
  assert.deepEqual(totalSpend(DEFAULT_EVAL_PATHS.answersDir, readHeldBack(DEFAULT_EVAL_PATHS.heldBack)), committed);
  assert.deepEqual({ ...total, files: committed.files }, committed, "the cost recorded for the six while they were held back is not what their files hold");
});

test("EV-8: the gallery holds three to five real failures from the system's own output, apart from the mess that was planted", async () => {
  const answers = await storedAnswers(base);
  const { gallery } = finish(base, (question) => answers.get(question.id) as ReviewerAnswer).report;
  assert.ok(gallery.real.length >= 3 && gallery.real.length <= 5, `${gallery.real.length} real failures`);
  assert.equal(new Set(gallery.real.map((entry) => entry.kind)).size, gallery.real.length);
  const realKinds = new Set(gallery.real.map((entry) => entry.kind));
  assert.ok(gallery.injected.length > 0);
  for (const entry of gallery.injected) {
    assert.ok(!realKinds.has(entry.kind));
    assert.match(entry.kind, /planted/);
    // Each planted entry is a record the generator's plan marks as carrying that defect.
    const record = base.inputs.index.records.find((candidate) => candidate.game_id === entry.game_id) as IndexRecord;
    const row = base.inputs.truth.rows.get(record.canonical.source.record_id);
    assert.ok(row !== undefined && (row.injected_instruction || row.conflicting_tags.length > 0 || row.mess.includes("near_empty")), entry.game_id);
  }
  const { rows } = base.inputs.truth;
  const winners = new Set(base.inputs.index.records.map((record) => record.canonical.source.record_id));
  const planted = [...rows.values()].filter((row) => winners.has(row.source_record_id));
  assert.equal(gallery.injected.filter((entry) => entry.kind === "instruction_planted_in_the_description").length, planted.filter((row) => row.injected_instruction).length);
  assert.equal(gallery.injected.filter((entry) => entry.kind === "record_planted_nearly_empty").length, planted.filter((row) => row.mess.includes("near_empty")).length);
});
