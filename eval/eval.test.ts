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
import { analyse, finish, type Analysis, type EvalInputs } from "./evaluate.ts";
import { MARKS, decide, parseThresholds, type MarkResult, type Measured } from "./gate.ts";
import { LABEL_VERSIONS, isWordForWord, pairwiseByGame, summarisePairwise } from "./measures.ts";
import { ownerFile, ownerQuestions } from "./owner-check.ts";
import { REVIEWER_MAX_USD, REVIEWER_MODEL, answerPath, interpret, labelQuestion, obtainAnswer, readTemplates, requestHash, storedSpend, type Question, type ReviewerAnswer } from "./reviewer.ts";
import { DEFAULT_EVAL_PATHS, loadInputs, runEvaluation, type EvalPaths } from "./run.ts";
import { grade, type Truth } from "./truth.ts";

const scratch = (name: string): string => mkdtempSync(join(tmpdir(), `${name}-`));
const quiet = (): void => {};

/** The committed inputs, without the owner's answers, so that these proofs do not change when he commits them. */
const inputs = (): EvalInputs => loadInputs({ ...DEFAULT_EVAL_PATHS, ownerAnswers: null });
const base = analyse(inputs());

/** Replays the committed reviewer answers. */
async function storedAnswers(analysis: Analysis): Promise<Map<string, ReviewerAnswer>> {
  const answers = new Map<string, ReviewerAnswer>();
  for (const question of analysis.questions) answers.set(question.id, await obtainAnswer(question, { dir: DEFAULT_EVAL_PATHS.answersDir, live: null, log: quiet }));
  return answers;
}

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
  const outputs: string[] = [];
  for (const run of [1, 2]) {
    const outDir = scratch(`ev1-${run}`);
    const result = cli(["--out-dir", outDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(outDir, reportFile), "utf8"), committed.report, "the report differs from the committed one");
    assert.equal(readFileSync(join(outDir, "verdict.json"), "utf8"), committed.verdict, "the verdict differs from the committed one");
    outputs.push(result.stdout.replaceAll(outDir, "<out>"));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.match(outputs[0] ?? "", /Verdict: \w+ ships/);
  // In process as well, with the owner's answers left out: the verdict does not depend on them.
  const outDir = scratch("ev1-in-process");
  const again = await runEvaluation({ ...DEFAULT_EVAL_PATHS, ownerAnswers: null, outDir }, null, quiet);
  assert.equal(again.report.decision.ships, (JSON.parse(committed.verdict) as { ships: string }).ships);
});

test("EV-1: a missing or stale input stops the evaluation with exit 1 and names what is missing", () => {
  const outDir = scratch("ev1-missing");
  const noAnswers = cli(["--out-dir", outDir, "--answers-dir", scratch("ev1-no-answers")]);
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

/** A copy of the data in which every vector belongs to another game: the index is valid and its matching is noise. */
function scrambledFixture(): { dataDir: string } {
  const dataDir = scratch("ev1-bad-fixture");
  for (const part of ["index", "generation", "catalogue.raw.jsonl", "offerings.jsonl"]) cpSync(join("data", part), join(dataDir, part), { recursive: true });
  const manifestPath = join(dataDir, "index", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const bytesPerVector = manifest.dimensions * 4;
  for (const version of VERSIONS) {
    const name = `vectors.${version}.f32`;
    const original = readFileSync(join(dataDir, "index", name));
    const count = original.length / bytesPerVector;
    const moved = Buffer.alloc(original.length);
    // Game i gets the vector of game (i * 37 + 11) mod n: a fixed permutation with no pattern the plan shares.
    for (let row = 0; row < count; row += 1) original.copy(moved, row * bytesPerVector, (((row * 37 + 11) % count) * bytesPerVector), (((row * 37 + 11) % count) + 1) * bytesPerVector);
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
  for (const question of analysis.questions) writeAnswer(paths.answersDir, question, question.kind === "label" ? { answer: "no", quote: "" } : { answer: "no", in_common: "nothing" });
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
  const precision = spoke.enrichment.model_everywhere.precision;
  if (planted.plan === "unknowable") assert.equal(precision.left_out.unknowable, clean.enrichment.model_everywhere.precision.left_out.unknowable + 1);
  else assert.equal(precision.of, clean.enrichment.model_everywhere.precision.of + 1);

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
    assert.equal(measured.precision.of + measured.precision.left_out.unclear + measured.precision.left_out.unknowable <= asserted, true);
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
  assert.equal(report.control.applies.of, 10);
  assert.equal(report.control.does_not_apply.of, 10);
  const { index, truth } = base.inputs;
  let agreed = 0;
  for (const item of base.control) {
    const record = index.records.find((candidate) => candidate.game_id === item.game_id) as IndexRecord;
    const row = truth.rows.get(record.canonical.source.record_id);
    const inPlan = row?.recoverable[item.field].some((entry) => entry.term === item.label) ?? false;
    const assigned = (truth.games.get(item.game_id)?.[item.field] as string[]).includes(item.label);
    const asserting = LABEL_VERSIONS.filter((version) => record.versions[version][item.field]?.labels.some((label) => label.label === item.label)).length;
    if (item.agreed === "applies") assert.ok(inPlan && asserting === LABEL_VERSIONS.length, `${item.game_id} ${item.label}`);
    else assert.ok(!assigned && asserting === 0, `${item.game_id} ${item.label}`);
    const given = answers.get(item.question_id)?.answer;
    if ((item.agreed === "applies" && given === "yes") || (item.agreed === "does_not_apply" && given === "no")) agreed += 1;
  }
  assert.equal(report.control.agreed, agreed);
  assert.equal(report.control.applies.agreed + report.control.does_not_apply.agreed, agreed);
});

test("EV-6: with no owner's answers the evaluation still reaches its verdict, says the check is outstanding, and withholds the reviewer's answers to his six questions", async () => {
  const answers = await storedAnswers(base);
  const answer = (question: Question): ReviewerAnswer => answers.get(question.id) as ReviewerAnswer;
  const open = finish(base, answer).report;
  assert.equal(open.owner_check.status, "outstanding");
  assert.equal(open.owner_check.of, 6);
  assert.equal(open.owner_check.matched, null);
  assert.match(open.owner_check.note, /^Outstanding: the owner has not answered/);
  assert.equal(open.owner_check.from_disagreements, Math.min(6, open.disagreements.count));
  assert.equal(open.owner_check.from_control, 6 - open.owner_check.from_disagreements);
  if (open.disagreements.count < 6) assert.match(open.owner_check.note, /drawn from the control sample/);
  const six = ownerQuestions(base);
  assert.equal(new Set(six.map((entry) => entry.question.id)).size, 6);
  // Every disagreement is among the six before any control question is.
  for (const entry of open.disagreements.list.slice(0, 6)) assert.ok(six.some((asked) => asked.question.id === entry.question_id));
  // Nowhere in the report is the reviewer's answer to one of the six.
  const text = JSON.stringify(open);
  for (const { question } of six) {
    const given = answers.get(question.id) as ReviewerAnswer;
    if (given.words.length > 12) assert.ok(!text.includes(JSON.stringify(given.words).slice(1, -1)), `the reviewer's quote for ${question.id} is in the report`);
    for (const entry of [...open.disagreements.list, ...open.control.list].filter((item) => item.question_id === question.id)) assert.equal(entry.reviewer, "withheld_until_the_owner_has_answered");
    assert.ok(open.owner_check.questions.every((item) => item.reviewer === null && item.owner === null));
  }

  // Once he has answered, the report counts the matches and the verdict is the same.
  const reviewerSaid = six.map(({ question }) => (answers.get(question.id) as ReviewerAnswer).answer);
  const flipped = reviewerSaid.map((word, position) => (position < 2 ? (word === "yes" ? "no" : "yes") : word));
  const answered = finish(analyse({ ...inputs(), ownerAnswers: ownerFile(base, flipped, "2026-11-19") }), answer).report;
  assert.equal(answered.owner_check.status, "answered");
  assert.equal(answered.owner_check.matched, 4);
  assert.match(answered.owner_check.note, /the reviewer matched the owner on 4 of 6/);
  assert.deepEqual(answered.decision, open.decision);
  assert.deepEqual(answered.measured, open.measured);
  assert.ok(answered.disagreements.list.every((entry) => typeof entry.reviewer !== "string"));

  // Answers to other questions, or to a question whose text has changed, are refused.
  const file = ownerFile(base, reviewerSaid, "2026-11-19");
  const other = { ...file, answers: file.answers.map((entry, position) => (position === 0 ? { ...entry, question_id: "label.nothing.fantasy" } : entry)) };
  assert.throws(() => finish(analyse({ ...inputs(), ownerAnswers: other }), answer), /other questions than the six/);
  const changed = { ...file, answers: file.answers.map((entry, position) => (position === 0 ? { ...entry, question_sha256: "0".repeat(64) } : entry)) };
  assert.throws(() => finish(analyse({ ...inputs(), ownerAnswers: changed }), answer), /text has since changed/);

  // The owner's check needs a person at a terminal, and writes nothing without one.
  const out = join(scratch("ev6"), "owner-check.json");
  const piped = spawnSync(process.execPath, ["eval/owner-check.ts", "--out", out], { encoding: "utf8", input: "y\ny\ny\ny\ny\ny\n", timeout: 60_000 });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /needs a person at a terminal/);
  assert.ok(!existsSync(out));
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

  // The committed answers are within the limit, and every one of them is used by the evaluation.
  const committed = storedSpend(DEFAULT_EVAL_PATHS.answersDir);
  assert.ok(committed.usd > 0 && committed.usd <= REVIEWER_MAX_USD);
  assert.equal(committed.files, base.questions.length);
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
