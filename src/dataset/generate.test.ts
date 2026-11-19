// Each test name starts with the invariant it proves (docs/features/dataset.md), so that
// `npm test -- DS-4` runs the proof of one invariant.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addMarkup, degrade, stripMarkup } from "./degrade.ts";
import { MESS_KINDS, type TruthText } from "./model.ts";
import { DEFAULT_SEED, SCENARIO_COUNT, buildPlan, type SlotPlan } from "./plan.ts";
import { assertCoverage, buildLedger, buildMessReport, type MessReport } from "./report.ts";
import {
  expectationFor,
  interpretResponse,
  nameHash,
  readResponseFile,
  readRetired,
  redactNames,
  responseFileName,
  retireSlot,
  validateTruthText,
} from "./truth-writer.ts";

const REPO = join(import.meta.dirname, "..", "..");
const DATA = join(REPO, "data");
/** Everything the generator writes, relative to the data directory. */
const BUILT_FILES = [
  "catalogue.raw.jsonl",
  "offerings.jsonl",
  "generation/truth.games.jsonl",
  "generation/truth.rows.jsonl",
  "generation/mess-report.json",
  "generation/ledger.json",
];

function committedReport(): MessReport & { seed: string; count: number } {
  return JSON.parse(readFileSync(join(DATA, "generation", "mess-report.json"), "utf8"));
}

/** A scratch data directory holding a copy of what the generator reads, and none of what it writes. */
function scratchData(): string {
  const dir = mkdtempSync(join(tmpdir(), "dataset-"));
  for (const input of ["responses", "retired-attempts.jsonl"]) {
    cpSync(join(DATA, "generation", input), join(dir, "generation", input), { recursive: true });
  }
  return dir;
}

/** Runs the generator as `npm run dataset` does, at the committed size, with no key in its environment. */
function rebuild(dataDir: string, ...extraArgs: string[]): { status: number | null; stderr: string } {
  const { seed, count } = committedReport();
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  return spawnSync(
    process.execPath,
    [join(REPO, "src", "dataset", "generate.ts"), "--count", String(count), "--seed", seed, "--data-dir", dataDir, ...extraArgs],
    { cwd: REPO, env, encoding: "utf8" },
  );
}

/** A stand-in for model output that satisfies every rule for the slot. */
function fakeText(slotPlan: SlotPlan, texts: ReadonlyMap<number, TruthText>): TruthText {
  const expectation = expectationFor(slotPlan, texts);
  // Two letters that are unique per slot, so no two stand-in titles share a word.
  const tag = `${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[slotPlan.slot % 26]}${"abcdefghij"[Math.floor(slotPlan.slot / 26)]}`;
  const terms = [...slotPlan.themes, ...slotPlan.mechanics];
  const sentences = terms.map((term) => `This game clearly has the ${term} trait in it.`);
  const filler = Array.from({ length: 8 }, (_, index) => `Filler sentence number ${"abcdefgh"[index]} adds some words.`);
  const german = terms.map((term) => `Dieses Spiel hat eindeutig das Merkmal ${term} in sich.`);
  const germanFiller = Array.from({ length: 6 }, () => "Ein weiterer Satz sorgt hier noch fuer etwas Laenge.");
  return {
    title: expectation.requiredTitle ?? `${slotPlan.titleInitial}${tag.toLowerCase()}walden ${tag}marsh`,
    description: [...sentences, ...filler].join(" "),
    description_de: expectation.germanCopy ? [...german, ...germanFiller].join(" ") : null,
    evidence: terms.map((term) => ({
      term,
      span: `has the ${term} trait`,
      span_de: expectation.germanCopy ? `das Merkmal ${term}` : null,
    })),
    title_theme_terms: slotPlan.titleStyle === "thematic" ? [slotPlan.themes[0] ?? "fantasy"] : [],
  };
}

function fakeCatalogue(count: number) {
  const plan = buildPlan(count, DEFAULT_SEED);
  const texts = new Map<number, TruthText>();
  for (const slotPlan of plan) {
    const text = fakeText(slotPlan, texts);
    validateTruthText(text, slotPlan, expectationFor(slotPlan, texts));
    texts.set(slotPlan.slot, text);
  }
  return { plan, texts, catalogue: degrade(plan, texts, DEFAULT_SEED) };
}

test("DS-1: a smaller plan is a strict prefix of a larger plan", () => {
  assert.deepEqual(buildPlan(60, DEFAULT_SEED).slice(0, SCENARIO_COUNT), buildPlan(SCENARIO_COUNT, DEFAULT_SEED));
});

test("DS-1: degradation is deterministic", () => {
  assert.equal(JSON.stringify(fakeCatalogue(40).catalogue), JSON.stringify(fakeCatalogue(40).catalogue));
});

test("DS-1: rebuilding from the stored responses reproduces every committed file byte for byte", () => {
  const dir = scratchData();
  const run = rebuild(dir);
  assert.equal(run.status, 0, run.stderr);
  for (const file of BUILT_FILES) {
    assert.ok(readFileSync(join(dir, file)).equals(readFileSync(join(DATA, file))), `${file} differs from the committed file`);
  }
});

test("DS-2: an answer that carries a fact or an availability field is rejected", () => {
  const plan = buildPlan(SCENARIO_COUNT, DEFAULT_SEED);
  const slotPlan = plan[0];
  assert.ok(slotPlan);
  const expectation = expectationFor(slotPlan, new Map());
  const good = fakeText(slotPlan, new Map());
  validateTruthText(good, slotPlan, expectation);
  for (const extra of [{ rtp: "96.2%" }, { facts: { volatility: "high" } }, { offerings: [{ brand: "tavrenmoor", status: "live" }] }]) {
    assert.throws(() => validateTruthText({ ...good, ...extra }, slotPlan, expectation), /shape/);
  }
});

test("DS-2: copy that states a number or a volatility the brief did not supply is rejected", () => {
  const plan = buildPlan(100, DEFAULT_SEED);
  const slotPlan = plan.find((candidate) => candidate.copyMentionsFacts && candidate.relation.kind === "none");
  assert.ok(slotPlan);
  const expectation = expectationFor(slotPlan, new Map());
  const good = fakeText(slotPlan, new Map());
  const { facts } = slotPlan;
  const withSentence = (sentence: string) => ({ ...good, description: `${good.description} ${sentence}` });
  const band = (name: string): string => name.replace("_", " ");

  const maxWin = `${facts.max_win_multiplier.toLocaleString("en-US")}x the bet`;
  validateTruthText(withSentence(`A ${facts.grid} grid, ${band(facts.volatility)} volatility and a maximum win of ${maxWin}.`), slotPlan, expectation);
  assert.throws(
    () => validateTruthText(withSentence(`The maximum win is ${(facts.max_win_multiplier + 1).toLocaleString("en-US")}x the bet.`), slotPlan, expectation),
    /a number the brief did not supply/,
  );
  assert.throws(() => validateTruthText(withSentence("It plays on 9 reels."), slotPlan, expectation), /states 9, a number the brief did not supply/);
  const otherBand = facts.volatility === "low" ? "very_high" : "low";
  assert.throws(
    () => validateTruthText(withSentence(`Volatility is ${band(otherBand)}.`), slotPlan, expectation),
    new RegExp(`states the volatility as ${otherBand}, but the brief says ${facts.volatility}`),
  );
});

test("DS-2: facts and offerings stay the same when the text changes", () => {
  const { plan, texts, catalogue } = fakeCatalogue(100);
  const rewritten = new Map(
    [...texts].map(([slot, text]) => [slot, { ...text, description: text.description.replaceAll("Filler sentence", "Padding line") }]),
  );
  const other = degrade(plan, rewritten, DEFAULT_SEED);
  assert.notDeepEqual(other.truthGames.map((game) => game.description), catalogue.truthGames.map((game) => game.description));

  const factsOfRecord = ({ payload }: (typeof catalogue.rawRecords)[number]) => {
    const { name: _name, description: _description, features: _features, themes: _themes, tags: _tags, ...facts } = payload;
    return facts;
  };
  assert.deepEqual(other.offerings, catalogue.offerings);
  assert.deepEqual(other.truthGames.map((game) => game.facts), catalogue.truthGames.map((game) => game.facts));
  assert.deepEqual(other.rawRecords.map(factsOfRecord), catalogue.rawRecords.map(factsOfRecord));
  assert.ok(catalogue.rawRecords.some((record) => record.payload.rtp !== undefined));
});

test("DS-3: the scenario slots cover every required case", () => {
  assertCoverage(buildMessReport(fakeCatalogue(SCENARIO_COUNT).catalogue));
});

test("DS-3: a catalogue that lacks a required case is refused, and the case is named", () => {
  const report = buildMessReport(fakeCatalogue(100).catalogue);
  assertCoverage(report);
  assert.throws(() => assertCoverage({ ...report, rows_by_mess: { ...report.rows_by_mess, description_markup: 0 } }), /description_markup/);
  assert.throws(() => assertCoverage({ ...report, clean_control_rows: 4 }), /five clean controls \(found 4\)/);
  assert.throws(() => assertCoverage({ ...report, clean_control_rows: 11 }), /ten clean controls \(found 11\)/);
  assert.throws(
    () => assertCoverage({ ...report, description_missing_forms: { ...report.description_missing_forms, empty_string: 0 } }),
    /missing description as empty_string/,
  );
});

test("DS-3: the committed catalogue holds every required case, with the counts the data README states", () => {
  const report = committedReport();
  assertCoverage(report);
  assert.ok(report.games >= 90 && report.games <= 110, `about 100 games expected, found ${report.games}`);

  const readme = readFileSync(join(DATA, "README.md"), "utf8");
  const stated = new Map([...readme.matchAll(/^\| `?([a-z_ ]+?)`? \| (\d+) \|/gm)].map(([, kind, rows]) => [kind, Number(rows)]));
  const actual = new Map<string | undefined, number>([...Object.entries(report.rows_by_mess), ["clean control", report.clean_control_rows]]);
  assert.deepEqual([...stated.keys()].sort(), [...MESS_KINDS, "clean control"].sort());
  assert.deepEqual(stated, actual);
});

test("DS-3: a true duplicate shares the supplier id; a same-name pair does not", () => {
  const { catalogue } = fakeCatalogue(SCENARIO_COUNT);
  const duplicate = catalogue.truthRows.find((row) => row.duplicate_of !== null);
  assert.ok(duplicate);
  const pair = catalogue.rawRecords.filter((record) => record.payload.game_code === duplicate.game_id);
  assert.equal(pair.length, 2);
  assert.notEqual(pair[0]?.source_record_id, pair[1]?.source_record_id);

  const second = catalogue.truthGames.find((game) => game.same_name_as !== null);
  assert.ok(second);
  const first = catalogue.truthGames.find((game) => game.game_id === second.same_name_as);
  assert.ok(first);
  assert.equal(first.title, second.title);
  assert.notEqual(first.studio, second.studio);
  assert.notEqual(first.game_id, second.game_id);
});

test("DS-3: a near-empty row supports nothing and a clean control supports everything", () => {
  const { catalogue } = fakeCatalogue(SCENARIO_COUNT);
  const nearEmpty = catalogue.truthRows.find((row) => row.mess.includes("near_empty"));
  assert.ok(nearEmpty);
  assert.deepEqual(nearEmpty.expected_abstain, { themes: true, mechanics: true });
  const control = catalogue.truthRows.find((row) => row.clean_control);
  assert.ok(control);
  assert.deepEqual(control.unknowable, { themes: [], mechanics: [] });
});

test("DS-3: the injected instruction is in the raw description and labelled only in the truth", () => {
  const { catalogue } = fakeCatalogue(SCENARIO_COUNT);
  const labelled = catalogue.truthRows.filter((row) => row.injected_instruction);
  assert.equal(labelled.length, 1);
  const raw = catalogue.rawRecords.find((record) => record.source_record_id === labelled[0]?.source_record_id);
  assert.match(raw?.payload.description ?? "", /ignore all previous instructions/);
  assert.doesNotMatch(JSON.stringify({ ...raw, payload: { ...raw?.payload, description: "" } }), /inject/i);
});

test("DS-3: markup can be removed exactly", () => {
  const text = `Tom & Jerry's "quoted" line. A second sentence follows! And a third?`;
  assert.notEqual(addMarkup(text), text);
  assert.equal(stripMarkup(addMarkup(text)), text);
});

test("DS-4: model output that breaks a rule is rejected with its reason", () => {
  const plan = buildPlan(SCENARIO_COUNT, DEFAULT_SEED);
  const slotPlan = plan[0];
  assert.ok(slotPlan);
  const expectation = expectationFor(slotPlan, new Map());
  const good = fakeText(slotPlan, new Map());
  const firstEvidence = good.evidence[0];
  assert.ok(firstEvidence);
  const rejects = (candidate: unknown, reason: RegExp): void => {
    assert.throws(() => validateTruthText(candidate, slotPlan, expectation), reason);
  };

  validateTruthText(good, slotPlan, expectation);
  rejects({ ...good, description: undefined }, /shape/);
  rejects({ ...good, extra: true }, /shape/);
  rejects({ ...good, evidence: [{ ...firstEvidence, term: "not_a_term" }, ...good.evidence.slice(1)] }, /shape/);
  rejects({ ...good, evidence: [{ ...firstEvidence, span: "words that are not there" }, ...good.evidence.slice(1)] }, /not a verbatim quote/);
  rejects({ ...good, evidence: good.evidence.slice(1) }, /do not match the plan/);
  rejects({ ...good, description: `${good.description} It also has a progressive jackpot.` }, /unplanned mechanic "progressive_jackpot"/);
  rejects({ ...good, description: "Too short." }, /words, expected/);
  rejects({ ...good, title: "Sample Title 9" }, /not two to four plain words/);
  rejects({ ...good, title_theme_terms: ["sci_fi"] }, /unplanned themes/);
  rejects({ ...good, description_de: "Unverlangter deutscher Text." }, /not requested/);
});

test("DS-4: a title that must be exact or unused is enforced", () => {
  const { plan, texts } = fakeCatalogue(SCENARIO_COUNT);
  const sequel = plan.find((slotPlan) => slotPlan.relation.kind === "variant_of");
  assert.ok(sequel);
  const sequelText = texts.get(sequel.slot);
  assert.ok(sequelText);
  assert.throws(
    () => validateTruthText({ ...sequelText, title: "Something Else" }, sequel, expectationFor(sequel, texts)),
    /title must be exactly/,
  );

  const fresh = plan[1];
  const taken = texts.get(0);
  assert.ok(fresh && taken);
  assert.throws(
    () => validateTruthText({ ...fakeText(fresh, texts), title: `${fresh.titleInitial}ox ${taken.title}` }, fresh, expectationFor(fresh, texts)),
    /is too close to the existing title/,
  );
});

test("DS-4: refused, incomplete and malformed responses are told apart", () => {
  const plan = buildPlan(SCENARIO_COUNT, DEFAULT_SEED);
  const slotPlan = plan[0];
  assert.ok(slotPlan);
  const expectation = expectationFor(slotPlan, new Map());
  const message = (content: unknown[]) => ({ status: "completed", output: [{ type: "message", content }] });
  const outcomeOf = (body: unknown): string => interpretResponse(body, slotPlan, expectation).outcome;

  assert.equal(outcomeOf(message([{ type: "output_text", text: JSON.stringify(fakeText(slotPlan, new Map())) }])), "ok");
  assert.equal(outcomeOf(message([{ type: "refusal", refusal: "no" }])), "refusal");
  assert.equal(outcomeOf({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), "incomplete");
  assert.equal(outcomeOf(message([{ type: "output_text", text: "{not json" }])), "invalid_output");
  assert.equal(outcomeOf(message([{ type: "output_text", text: "{}" }])), "invalid_output");
  assert.equal(outcomeOf({ unexpected: true }), "invalid_output");
});

test("DS-6: a blocked name is rejected, and never reaches what is stored", () => {
  const plan = buildPlan(SCENARIO_COUNT, DEFAULT_SEED);
  const slotPlan = plan[0];
  assert.ok(slotPlan);
  // A stand-in for a name that a search found to exist; the real list is kept as hashes.
  const expectation = { ...expectationFor(slotPlan, new Map()), blockedNameHashes: new Set([nameHash("Exampleton")]) };
  const good = fakeText(slotPlan, new Map());
  const body = {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ ...good, title: "EXAMPLETON's Marsh" }) }] }],
  };

  const interpreted = interpretResponse(body, slotPlan, expectation);
  if (interpreted.outcome !== "invalid_output") assert.fail(`expected a rejection, got ${interpreted.outcome}`);
  assert.match(interpreted.reason, /already exists outside this catalogue/);
  assert.deepEqual(interpreted.withheld, ["EXAMPLETON"]);

  const stored = JSON.stringify(redactNames(body, interpreted.withheld));
  assert.doesNotMatch(stored, /exampleton/i);
  assert.match(stored, /\[name withheld\]'s Marsh/);
});

test("DS-4: retiring a slot removes its responses and keeps what they cost", () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-"));
  const retiredPath = join(dir, "retired-attempts.jsonl");
  const usage = { input_tokens: 1000, output_tokens: 200 };
  const attempt = { seconds: 4.2, http_status: 200, usage, body_redacted: false };
  writeFileSync(
    join(dir, responseFileName(3)),
    JSON.stringify({
      slot: 3,
      model: "m",
      prompt_version: "p",
      request_sha256: "x",
      attempts: [
        { ...attempt, outcome: "invalid_output", reason: "some reason", body: { secret: "text" } },
        { ...attempt, outcome: "ok", reason: null, body: {} },
      ],
    }),
  );

  assert.equal(retireSlot(dir, retiredPath, 3, "name_replacement"), 2);
  assert.equal(retireSlot(dir, retiredPath, 3, "name_replacement"), null);
  assert.equal(existsSync(join(dir, responseFileName(3))), false);
  const [line] = readRetired(retiredPath);
  assert.ok(line);
  assert.equal(line.reason, "name_replacement");
  assert.deepEqual(line.attempts.map((entry) => entry.outcome), ["invalid_output", "ok"]);
  assert.equal(line.attempts[0]?.usage?.input_tokens, 1000);
  assert.doesNotMatch(JSON.stringify(line), /some reason|secret/);
});

test("DS-3: at full size the plan gives 5 to 10 clean controls and every missing-description form", () => {
  const report = buildMessReport(fakeCatalogue(100).catalogue);
  assert.ok(report.clean_control_rows >= 5 && report.clean_control_rows <= 10, `clean controls: ${report.clean_control_rows}`);
  assert.ok(report.description_missing_forms.absent_key > 0);
  assert.ok(report.description_missing_forms.null > 0);
  assert.ok(report.description_missing_forms.empty_string > 0);
  assertCoverage(report);
});

test("DS-4: every stored attempt is counted in the ledger under its outcome", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const attempt = { seconds: 1, http_status: 200, usage: { input_tokens: 1000, output_tokens: 200 }, body_redacted: false, body: {} };
  writeFileSync(
    join(dir, responseFileName(0)),
    JSON.stringify({
      slot: 0,
      model: "m",
      prompt_version: "p",
      request_sha256: "x",
      attempts: [
        { ...attempt, outcome: "invalid_output", reason: "quote is not verbatim" },
        { ...attempt, outcome: "refusal", reason: "refused" },
        { ...attempt, outcome: "incomplete", reason: "max_output_tokens" },
        { ...attempt, outcome: "api_error", reason: "status 500", http_status: 500, usage: null, body: null },
        { ...attempt, outcome: "ok", reason: null },
      ],
    }),
  );

  const ledger = buildLedger(dir, join(dir, "retired-attempts.jsonl"), buildPlan(1, DEFAULT_SEED));
  assert.deepEqual(ledger.attempts_by_outcome, { ok: 1, invalid_output: 1, refusal: 1, incomplete: 1, api_error: 1 });
  assert.equal(ledger.attempts, 5);
  assert.equal(ledger.retries, 4);
  assert.deepEqual(ledger.records_by_result, { succeeded_first_try: 0, succeeded_after_retry: 1, no_accepted_response: 0 });
});

/** Rebuilds a scratch copy after `tamper` has changed one stored response, and expects a loud stop. */
function assertRebuildStops(tamper: (responsePath: string) => void, cause: RegExp, ...extraArgs: string[]): void {
  const dir = scratchData();
  tamper(join(dir, "generation", "responses", responseFileName(5)));
  const run = rebuild(dir, ...extraArgs);
  assert.equal(run.status, 1, "the build should have stopped");
  assert.match(run.stderr, cause);
  for (const file of BUILT_FILES) assert.equal(existsSync(join(dir, file)), false, `${file} was written by a build that failed`);
}

test("DS-5: a stored response that no longer matches its request stops the build", () => {
  assertRebuildStops((path) => {
    writeFileSync(path, JSON.stringify({ ...readResponseFile(path), request_sha256: "0".repeat(64) }));
  }, /slot 5 .*was produced by a different request/);
});

test("DS-5: a stored response that no longer passes validation stops the build", () => {
  assertRebuildStops((path) => {
    const file = readResponseFile(path);
    const emptyAnswer = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] };
    writeFileSync(path, JSON.stringify({ ...file, attempts: file.attempts.map((attempt) => ({ ...attempt, body: emptyAnswer })) }));
  }, /slot 5 .*the committed response no longer passes validation/);
});

test("DS-5: a missing stored response stops a build that has no key", () => {
  assertRebuildStops((path) => rmSync(path), /slot 5 .*no accepted response/);
  assertRebuildStops(() => {}, /--live needs OPENAI_API_KEY in the environment/, "--live");
});

test("DS-6: no word in any committed data file is on the blocked list", () => {
  const plan = buildPlan(1, DEFAULT_SEED);
  assert.ok(plan[0]);
  const blocked = expectationFor(plan[0], new Map()).blockedNameHashes;
  assert.ok(blocked.size > 0);
  const files = readdirSync(DATA, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  assert.ok(files.length > committedReport().count, `only ${files.length} files found under data/`);

  const words = new Set<string>();
  for (const file of files) {
    for (const word of readFileSync(join(file.parentPath, file.name), "utf8").match(/\p{L}+/gu) ?? []) words.add(word.toLowerCase());
  }
  assert.ok(words.size > 1000, `only ${words.size} distinct words found under data/`);
  assert.deepEqual([...words].filter((word) => blocked.has(nameHash(word))).length, 0);
});
