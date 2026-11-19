import assert from "node:assert/strict";
import { test } from "node:test";
import { addMarkup, degrade, stripMarkup } from "./degrade.ts";
import type { TruthText } from "./model.ts";
import { DEFAULT_SEED, SCENARIO_COUNT, buildPlan, type SlotPlan } from "./plan.ts";
import { assertCoverage, buildMessReport } from "./report.ts";
import { expectationFor, interpretResponse, validateTruthText } from "./truth-writer.ts";

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
    title: expectation.requiredTitle ?? `${tag}walden ${tag}marsh`,
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

test("the pilot plan is a strict prefix of a larger plan", () => {
  assert.deepEqual(buildPlan(60, DEFAULT_SEED).slice(0, SCENARIO_COUNT), buildPlan(SCENARIO_COUNT, DEFAULT_SEED));
});

test("degradation is deterministic", () => {
  assert.equal(JSON.stringify(fakeCatalogue(40).catalogue), JSON.stringify(fakeCatalogue(40).catalogue));
});

test("the scenario slots cover every required case", () => {
  assertCoverage(buildMessReport(fakeCatalogue(SCENARIO_COUNT).catalogue));
});

test("a true duplicate shares the supplier id; a same-name pair does not", () => {
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

test("a near-empty row supports nothing and a clean control supports everything", () => {
  const { catalogue } = fakeCatalogue(SCENARIO_COUNT);
  const nearEmpty = catalogue.truthRows.find((row) => row.mess.includes("near_empty"));
  assert.ok(nearEmpty);
  assert.deepEqual(nearEmpty.expected_abstain, { themes: true, mechanics: true });
  const control = catalogue.truthRows.find((row) => row.clean_control);
  assert.ok(control);
  assert.deepEqual(control.unknowable, { themes: [], mechanics: [] });
});

test("the injected instruction is in the raw description and labelled only in the truth", () => {
  const { catalogue } = fakeCatalogue(SCENARIO_COUNT);
  const labelled = catalogue.truthRows.filter((row) => row.injected_instruction);
  assert.equal(labelled.length, 1);
  const raw = catalogue.rawRecords.find((record) => record.source_record_id === labelled[0]?.source_record_id);
  assert.match(raw?.payload.description ?? "", /ignore all previous instructions/);
  assert.doesNotMatch(JSON.stringify({ ...raw, payload: { ...raw?.payload, description: "" } }), /inject/i);
});

test("markup can be removed exactly", () => {
  const text = `Tom & Jerry's "quoted" line. A second sentence follows! And a third?`;
  assert.notEqual(addMarkup(text), text);
  assert.equal(stripMarkup(addMarkup(text)), text);
});

test("model output that breaks a rule is rejected with its reason", () => {
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

test("a title that must be exact or unused is enforced", () => {
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
    () => validateTruthText({ ...fakeText(fresh, texts), title: `${taken.title} Again` }, fresh, expectationFor(fresh, texts)),
    /is too close to the existing title/,
  );
});

test("refused, incomplete and malformed responses are told apart", () => {
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
