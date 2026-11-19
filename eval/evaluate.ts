/**
 * The evaluation, as two pure steps around the reviewer's answers:
 *
 *   analyse(inputs)          everything the answer key decides alone, and the questions it cannot decide
 *   finish(analysis, answer) the report, the gate's decision and the verdict
 *
 * Neither step reads a file or calls a model. `run.ts` loads the inputs, fetches the stored
 * answers and writes the results. Every definition is the one in eval/refs/evaluation-plan.md;
 * the choices made where that file leaves a detail open are listed in docs/features/service.md.
 */
import { seededRng } from "../src/dataset/rng.ts";
import type { Term } from "../src/dataset/vocabulary.ts";
import { isTheme } from "../src/dataset/vocabulary.ts";
import type { Index, IndexRecord } from "../src/pipeline/index-store.ts";
import { sha256 } from "../src/pipeline/io.ts";
import { VERSIONS, type Version } from "../src/pipeline/versions.ts";
import { largestBrand, type Offerings } from "../src/service/offerings.ts";
import { FLOOR_RULE, buildState, recommend, type Recommendation } from "../src/service/recommend.ts";
import { VERDICT_FORMAT, type Verdict } from "../src/service/verdict.ts";
import { decide, type Decision, type Measured, type Thresholds } from "./gate.ts";
import {
  ALL_TERMS,
  FIELDS,
  LABEL_VERSIONS,
  countEnrichment,
  gateAccuracy,
  pairwiseByGame,
  planSays,
  rate,
  summarisePairwise,
  truthRowOf,
  type Disagreement,
  type EnrichmentCounts,
  type FieldName,
  type LabelVersion,
  type Miss,
  type Pairwise,
  type PairwiseGame,
  type Rate,
} from "./measures.ts";
import { REVIEWER_MODEL, labelQuestion, recommendationQuestion, type Question, type QuestionTemplates, type ReviewerAnswer } from "./reviewer.ts";
import { grade, shared, type Grade, type Truth } from "./truth.ts";

/** One seed for every draw. Fixed before the first run; changing it changes which questions are asked. */
export const SEED = "evaluation-v1";
export const CONTROL_SIZE = 20;
export const OWNER_QUESTIONS = 6;
export const CHECK_GAMES = 6;

export interface OwnerAnswers {
  answers: { question_id: string; question_sha256: string; answer: "yes" | "no" | "unclear" }[];
}

export interface EvalInputs {
  index: Index;
  truth: Truth;
  offerings: Offerings;
  thresholds: Thresholds;
  thresholdsSha256: string;
  templates: QuestionTemplates;
  /** Null until the owner has committed his answers. */
  ownerAnswers: OwnerAnswers | null;
  /** Questions whose reviewer answer the owner was told before he answered: his answer to them is not blind. */
  disclosedToOwner: readonly string[];
}

function shuffled<T>(items: readonly T[], ...stream: string[]): T[] {
  const rng = seededRng(SEED, ...stream);
  const out = [...items];
  for (let position = out.length - 1; position > 0; position -= 1) {
    const other = rng.int(position + 1);
    [out[position], out[other]] = [out[other] as T, out[position] as T];
  }
  return out;
}

interface ControlItem {
  game_id: string;
  field: FieldName;
  label: Term;
  /** What the plan and every label-asserting version agree on. */
  agreed: "applies" | "does_not_apply";
  question_id: string;
}

interface ShownResult {
  game_id: string;
  title: string;
  rank: number;
  score: number;
  grade: Grade;
  shared_in_plan: string;
  /** Set when the rule calls the pair unrelated: the reviewer is then asked. */
  question_id: string | null;
}

interface CheckOutcome {
  anchor: string;
  title: string;
  outcome: Recommendation["outcome"];
  decline_reason: string | null;
  results: ShownResult[];
}

export interface Analysis {
  inputs: EvalInputs;
  enrichment: Record<LabelVersion, EnrichmentCounts>;
  disagreements: Disagreement[];
  control: ControlItem[];
  pairwise: Record<Version, PairwiseGame[]>;
  floors: Record<Version, number>;
  checkBrand: string;
  checkGames: string[];
  checks: Record<Version, CheckOutcome[]>;
  /** Every question for the reviewer, in the seeded shuffled order in which it is asked. */
  questions: Question[];
  ownerQuestions: { question_id: string; source: "disagreement" | "control" }[];
  /**
   * The owner's six while he has not answered, empty once he has. The reviewer's answers to these are
   * not read, not asked for and not stored in the tree, and nothing the evaluation writes depends on them.
   */
  heldBack: ReadonlySet<string>;
}

/** The questions whose answers this run needs: every question but the ones held back for the owner's check. */
export const questionsToAnswer = (analysis: Analysis): Question[] => analysis.questions.filter((question) => !analysis.heldBack.has(question.id));

const byId = (index: Index): Map<string, IndexRecord> => new Map(index.records.map((record) => [record.game_id, record]));

export function analyse(inputs: EvalInputs): Analysis {
  const { index, truth, offerings, templates } = inputs;
  const records = byId(index);
  const record = (gameId: string): IndexRecord => {
    const found = records.get(gameId);
    if (found === undefined) throw new Error(`the index has no game ${gameId}`);
    return found;
  };
  const questions = new Map<string, Question>();
  const ask = (question: Question): string => {
    questions.set(question.id, question);
    return question.id;
  };

  // Enrichment, and the labels the plan does not back.
  const disagreementMap = new Map<string, Disagreement>();
  const enrichment = Object.fromEntries(LABEL_VERSIONS.map((version) => [version, countEnrichment(index, truth, version, disagreementMap)])) as Record<
    LabelVersion,
    EnrichmentCounts
  >;
  const disagreements = [...disagreementMap.values()].sort((a, b) => (`${a.game_id}|${a.label}` < `${b.game_id}|${b.label}` ? -1 : 1));
  for (const entry of disagreements) ask(labelQuestion(templates, record(entry.game_id), entry.label));

  // Control: labels on which the plan and every label-asserting version agree, half each way.
  const applies: Omit<ControlItem, "question_id">[] = [];
  const doesNotApply: Omit<ControlItem, "question_id">[] = [];
  for (const candidate of index.records) {
    const row = truthRowOf(candidate, truth);
    for (const label of ALL_TERMS) {
      const field: FieldName = isTheme(label) ? "themes" : "mechanics";
      const says = planSays(row, field, label);
      const assertedBy = LABEL_VERSIONS.filter((version) => candidate.versions[version][field]?.labels.some((entry) => entry.label === label));
      if (says === "recoverable" && assertedBy.length === LABEL_VERSIONS.length) applies.push({ game_id: candidate.game_id, field, label, agreed: "applies" });
      if (says === "not_assigned" && assertedBy.length === 0) doesNotApply.push({ game_id: candidate.game_id, field, label, agreed: "does_not_apply" });
    }
  }
  const half = CONTROL_SIZE / 2;
  const drawnApplies = shuffled(applies, "control", "applies");
  const drawnNot = shuffled(doesNotApply, "control", "does-not-apply");
  const control = [...drawnApplies.slice(0, half), ...drawnNot.slice(0, half)];
  // If one side is short, the other fills the sample.
  control.push(...[...drawnApplies.slice(half), ...drawnNot.slice(half)].slice(0, CONTROL_SIZE - control.length));
  const controlItems = control.map((item) => ({ ...item, question_id: ask(labelQuestion(templates, record(item.game_id), item.label)) }));

  // Matching.
  const pairwise = Object.fromEntries(VERSIONS.map((version) => [version, pairwiseByGame(index, truth, version)])) as Record<Version, PairwiseGame[]>;

  // The check games: what the service core returns for six games on the largest brand, in each version.
  const checkBrand = largestBrand(offerings);
  const statuses = offerings.statusByBrand.get(checkBrand);
  const population = index.records
    .filter((candidate) => statuses?.get(candidate.game_id) === "live" && candidate.evidence !== "none")
    .map((candidate) => candidate.game_id)
    .sort();
  const checkGames = shuffled(population, "check-games").slice(0, CHECK_GAMES);
  const floors = {} as Record<Version, number>;
  const checks = {} as Record<Version, CheckOutcome[]>;
  for (const version of VERSIONS) {
    const state = buildState(index, offerings, version);
    floors[version] = state.floor;
    checks[version] = checkGames.map((anchorId) => {
      const response = recommend(state, { gameId: anchorId, brand: checkBrand });
      const anchorTruth = truth.games.get(anchorId);
      if (anchorTruth === undefined) throw new Error(`the answer key has no game ${anchorId}`);
      return {
        anchor: anchorId,
        title: record(anchorId).canonical.title,
        outcome: response.outcome,
        decline_reason: response.decline?.reason ?? null,
        results: response.results.map((result) => {
          const otherTruth = truth.games.get(result.game_id);
          if (otherTruth === undefined) throw new Error(`the answer key has no game ${result.game_id}`);
          const pairGrade = grade(anchorTruth, otherTruth);
          return {
            game_id: result.game_id,
            title: result.title,
            rank: result.rank,
            score: result.score,
            grade: pairGrade,
            shared_in_plan: shared(anchorTruth, otherTruth),
            question_id: pairGrade === "unrelated" ? ask(recommendationQuestion(templates, record(anchorId), record(result.game_id))) : null,
          };
        }),
      };
    });
  }

  // The owner's six: every disagreement first, then the control sample, each drawn by seed.
  const ownerQuestions = [
    ...shuffled(disagreements, "owner", "disagreements").map((entry) => ({ question_id: `label.${entry.game_id}.${entry.label}`, source: "disagreement" as const })),
    ...shuffled(controlItems, "owner", "control").map((item) => ({ question_id: item.question_id, source: "control" as const })),
  ]
    .filter((entry, position, all) => all.findIndex((other) => other.question_id === entry.question_id) === position)
    .slice(0, OWNER_QUESTIONS);

  const ordered = shuffled([...questions.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), "question-order");
  const heldBack = new Set(inputs.ownerAnswers === null ? ownerQuestions.map((entry) => entry.question_id) : []);
  return { inputs, enrichment, disagreements, control: controlItems, pairwise, floors, checkBrand, checkGames, checks, questions: ordered, ownerQuestions, heldBack };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const HELD_BACK = "held_back_until_the_owner_has_answered";
type Shown = { answer: string; said: string | null; words: string; note: string | null } | typeof HELD_BACK;

interface GalleryEntry {
  kind: string;
  what: string;
  game_id: string;
  title: string;
  version: Version | null;
  detail: Record<string, unknown>;
}

export interface Report {
  format_version: 1;
  index_hash: string;
  prompt_version: string;
  thresholds_sha256: string;
  seed: string;
  models: { enrichment: string; embedding: string; reviewer: string };
  games: number;
  decision: Decision;
  measured: Record<Version, Measured>;
  enrichment: Record<
    LabelVersion,
    {
      labels_asserted: number;
      /**
       * Over the labels the plan or the reviewer has decided. `held_back` counts asserted labels whose reviewer
       * answer is held back for the owner's check; `gate` is the figure the pass mark reads, which counts each
       * of those as wrong, so that the verdict is the same whatever the held-back answers are.
       */
      precision: Rate & { left_out: { unclear: number; unknowable: number; held_back: number }; gate: Rate };
      recovery: Rate;
      recovery_without_tags: Rate;
      missed_abstentions: { count: number; of: number; list: EnrichmentCounts["missed_abstentions"] };
      invalid_quotes: { count: number; of: number; list: EnrichmentCounts["invalid_quotes"] };
      /** Recoverable labels not asserted, by cause. `conflict_rule`: the field is empty because a tag contradicts the description and nothing resolved it. */
      missed: { not_asserted: number; conflict_rule: number; list: Miss[] };
    }
  >;
  conflict_games: {
    note: string;
    games: {
      game_id: string;
      title: string;
      tag: string;
      tag_asserts: string;
      description_states: string[];
      model_reading_used: boolean;
      model_labels_withheld: string[];
      mechanics: Record<LabelVersion, { status: string; labels: string[] }>;
    }[];
  };
  disagreements: { count: number; list: (Disagreement & { title: string; question_id: string; reviewer: Shown })[] };
  control: {
    /** Labels drawn. */
    size: number;
    /** Of those, the ones that are among the owner's questions while he has not answered: not reported here. */
    held_back: number;
    /** The rest: `agreed`, the two sides and `list` cover these only. */
    reported: number;
    agreed: number;
    applies: { agreed: number; of: number };
    does_not_apply: { agreed: number; of: number };
    list: (ControlItem & { reviewer: Shown; agrees: boolean })[];
  };
  owner_check: {
    status: "outstanding" | "answered";
    note: string;
    of: number;
    from_disagreements: number;
    from_control: number;
    matched: number | null;
    /** Answers the owner gave without having been told the reviewer's, and how many of those the reviewer matched. */
    blind: { of: number; matched: number | null };
    /** Questions whose reviewer answer the owner had been told before he answered. Reported apart: not a blind check. */
    not_blind: { of: number; matched: number | null; question_ids: string[] };
    /** Empty while the check is outstanding: nothing about the six is reported until he has answered. */
    questions: { question_id: string; source: "disagreement" | "control"; blind: boolean; owner: string; reviewer: string; matched: boolean }[];
  };
  matching: Record<
    Version,
    {
      pairwise: Pairwise;
      gate_accuracy: number | null;
      by_condition: Record<IndexRecord["evidence"], Pairwise & { games_in_condition: number }>;
      by_thin: Record<"thin" | "not_thin", Pairwise & { games_in_condition: number }>;
      wrongly_shown: { count: number; results_judged: number; by_grade: Record<Grade, number>; declined: number };
      floor: number;
      cost: { estimated_usd: number; model_calls: number; seconds: number };
    }
  >;
  check_games: {
    brand: string;
    games: string[];
    results: Record<Version, (Omit<CheckOutcome, "results"> & { results: (ShownResult & { reviewer: Shown | null; wrongly_shown: boolean })[] })[]>;
  };
  per_game: Record<Version, [game_id: string, wins: number, pairs: number][]>;
  reviewer: {
    model: string;
    /** Every question drawn. */
    questions: number;
    /** Of those, the owner's questions while he has not answered. The counts below leave them out. */
    held_back: number;
    answered: number;
    by_kind: { label: number; recommendation: number };
    answers: { yes: number; no: number; unclear: number };
    unclear: { question_id: string; said: string | null; note: string | null }[];
  };
  gallery: { real: GalleryEntry[]; injected: GalleryEntry[] };
}

function conditionSplit<K extends string>(games: readonly PairwiseGame[], keys: readonly K[], keyOf: (gameId: string) => K): Record<K, Pairwise & { games_in_condition: number }> {
  return Object.fromEntries(
    keys.map((key) => {
      const inCondition = games.filter((game) => keyOf(game.game_id) === key);
      return [key, { ...summarisePairwise(inCondition), games_in_condition: inCondition.length }];
    }),
  ) as Record<K, Pairwise & { games_in_condition: number }>;
}

export function finish(analysis: Analysis, answerOf: (question: Question) => ReviewerAnswer): { report: Report; verdictFor: (reportPath: string, reportSha256: string) => Verdict } {
  const { inputs } = analysis;
  const { index, thresholds } = inputs;
  const records = byId(index);
  const record = (gameId: string): IndexRecord => records.get(gameId) as IndexRecord;
  // A held-back question is never put to `answerOf`, so nothing below can depend on its answer.
  const { heldBack } = analysis;
  const answers = new Map(questionsToAnswer(analysis).map((question) => [question.id, answerOf(question)]));
  const answer = (questionId: string): ReviewerAnswer => {
    if (heldBack.has(questionId)) throw new Error(`the reviewer's answer to ${questionId} is held back for the owner's check and must not be read`);
    const found = answers.get(questionId);
    if (found === undefined) throw new Error(`missing input: the reviewer has no answer for ${questionId}`);
    return found;
  };

  // The owner's check. Until he has answered, nothing about the reviewer's answers to his six questions is computed.
  const questionById = new Map(analysis.questions.map((question) => [question.id, question]));
  const owner = inputs.ownerAnswers;
  if (owner !== null) {
    const wanted = analysis.ownerQuestions.map((entry) => entry.question_id).sort();
    const given = owner.answers.map((entry) => entry.question_id).sort();
    if (wanted.join("\n") !== given.join("\n")) {
      throw new Error(`the owner's answers are for other questions than the six this evaluation draws (${wanted.join(", ")}). Answer them again with "npm run owner-check".`);
    }
    for (const entry of owner.answers) {
      if (sha256(questionById.get(entry.question_id)?.text ?? "") !== entry.question_sha256) {
        throw new Error(`the owner's answer to ${entry.question_id} was given to a question whose text has since changed. Answer it again with "npm run owner-check".`);
      }
    }
  }
  const show = (questionId: string): Shown => (heldBack.has(questionId) ? HELD_BACK : { ...answer(questionId) });

  // Enrichment.
  const enrichment = {} as Report["enrichment"];
  const measured = {} as Record<Version, Measured>;
  for (const version of LABEL_VERSIONS) {
    const counts = analysis.enrichment[version];
    let confirmed = 0;
    let rejected = 0;
    let unclear = 0;
    let held = 0;
    for (const entry of analysis.disagreements) {
      if (entry.plan !== "not_assigned" || !entry.asserted_by.some((by) => by.version === version)) continue;
      if (heldBack.has(`label.${entry.game_id}.${entry.label}`)) {
        held += 1;
        continue;
      }
      const decided = answer(`label.${entry.game_id}.${entry.label}`).answer;
      if (decided === "yes") confirmed += 1;
      else if (decided === "no") rejected += 1;
      else unclear += 1;
    }
    const correct = counts.asserted_recoverable + confirmed;
    enrichment[version] = {
      labels_asserted: counts.asserted,
      precision: {
        ...rate(correct, correct + rejected),
        left_out: { unclear, unknowable: counts.asserted_unknowable, held_back: held },
        gate: rate(correct, correct + rejected + held),
      },
      recovery: rate(counts.recovered, counts.recoverable),
      recovery_without_tags: rate(counts.recovered_without_tags, counts.recoverable_without_tags),
      missed_abstentions: { count: counts.missed_abstentions.length, of: counts.expected_abstentions, list: counts.missed_abstentions },
      invalid_quotes: { count: counts.invalid_quotes.length, of: counts.asserted, list: counts.invalid_quotes },
      missed: {
        not_asserted: counts.misses.filter((miss) => miss.cause === "not_asserted").length,
        conflict_rule: counts.misses.filter((miss) => miss.cause === "conflict_rule").length,
        list: counts.misses,
      },
    };
  }

  // Matching.
  const matching = {} as Report["matching"];
  const checkResults = {} as Report["check_games"]["results"];
  for (const version of VERSIONS) {
    const games = analysis.pairwise[version];
    const pairwise = summarisePairwise(games);
    const outcomes = analysis.checks[version].map((outcome) => ({
      ...outcome,
      results: outcome.results.map((result) => {
        const reviewer = result.question_id === null ? null : show(result.question_id);
        return { ...result, reviewer, wrongly_shown: result.question_id !== null && answer(result.question_id).answer === "no" };
      }),
    }));
    checkResults[version] = outcomes;
    const shown = outcomes.flatMap((outcome) => outcome.results);
    const ledger = index.ledger.versions[version];
    matching[version] = {
      pairwise,
      gate_accuracy: gateAccuracy(pairwise),
      by_condition: conditionSplit(games, ["description", "tags_only", "none"] as const, (gameId) => record(gameId).evidence),
      by_thin: conditionSplit(games, ["thin", "not_thin"] as const, (gameId) => (record(gameId).thin ? "thin" : "not_thin")),
      wrongly_shown: {
        count: shown.filter((result) => result.wrongly_shown).length,
        results_judged: shown.length,
        by_grade: Object.fromEntries((["strong", "related", "weak", "unrelated"] as const).map((key) => [key, shown.filter((result) => result.grade === key).length])) as Record<Grade, number>,
        declined: outcomes.filter((outcome) => outcome.outcome === "declined").length,
      },
      floor: analysis.floors[version],
      cost: { estimated_usd: ledger.estimated_usd, model_calls: ledger.enrichment.calls, seconds: ledger.seconds },
    };
    const labelled = version === "raw" ? null : enrichment[version];
    measured[version] = {
      enrichment:
        labelled === null
          ? null
          : {
              precision: labelled.precision.gate.rate,
              recovery: labelled.recovery.rate,
              recovery_without_tags: labelled.recovery_without_tags.rate,
              missed_abstentions: labelled.missed_abstentions.count,
              invalid_quotes: labelled.invalid_quotes.count,
            },
      matching: { pairwise_accuracy: matching[version].gate_accuracy, wrongly_shown: matching[version].wrongly_shown.count },
    };
  }
  const decision = decide(measured, thresholds);

  // Control: only the labels that are not among the owner's questions while he has not answered.
  const controlList = analysis.control
    .filter((item) => !heldBack.has(item.question_id))
    .map((item) => {
      const given = answer(item.question_id).answer;
      return { ...item, reviewer: show(item.question_id), agrees: item.agreed === "applies" ? given === "yes" : given === "no" };
    });
  const agreedOf = (side: ControlItem["agreed"]) => {
    const items = controlList.filter((item) => item.agreed === side);
    return { agreed: items.filter((item) => item.agrees).length, of: items.length };
  };

  // Owner's check. One question may have been disclosed to him before he answered: it is reported apart.
  const disclosed = new Set(inputs.disclosedToOwner);
  const notBlindIds = analysis.ownerQuestions.map((entry) => entry.question_id).filter((id) => disclosed.has(id));
  const ownerList =
    owner === null
      ? []
      : analysis.ownerQuestions.map((entry) => {
          const ownerAnswer = owner.answers.find((given) => given.question_id === entry.question_id)?.answer as string;
          const reviewerAnswer = answer(entry.question_id).answer;
          return { ...entry, blind: !disclosed.has(entry.question_id), owner: ownerAnswer, reviewer: reviewerAnswer, matched: ownerAnswer === reviewerAnswer };
        });
  const fromDisagreements = analysis.ownerQuestions.filter((entry) => entry.source === "disagreement").length;
  const blindOf = analysis.ownerQuestions.length - notBlindIds.length;
  const matchedBlind = owner === null ? null : ownerList.filter((entry) => entry.blind && entry.matched).length;
  const matchedNotBlind = owner === null ? null : ownerList.filter((entry) => !entry.blind && entry.matched).length;
  const ownerNote =
    (owner === null
      ? `Outstanding: the owner has not answered his ${analysis.ownerQuestions.length} questions. Run "npm run owner-check". ` +
        "Until he has, the reviewer's answers to them are held back: they are not in the tree, not read by this evaluation, and not in any count here. " +
        "The control is reported over the other labels, and precision's pass mark counts a held-back label as wrong, so the verdict does not depend on them."
      : `Answered: on the ${blindOf} questions he answered blind, the reviewer matched the owner on ${String(matchedBlind)}.`) +
    (notBlindIds.length === 0
      ? ""
      : ` Not blind: before answering ${notBlindIds.join(", ")} the owner had been told the reviewer's answer to it, so that answer is not a blind check` +
        (owner === null ? "." : ` (the reviewer ${matchedNotBlind === notBlindIds.length ? "matched" : "did not match"} it); it is counted apart.`)) +
    (fromDisagreements < OWNER_QUESTIONS
      ? ` Only ${analysis.disagreements.length} disagreement(s) exist, so ${analysis.ownerQuestions.length - fromDisagreements} of the questions are drawn from the control sample.`
      : "");

  // Reviewer totals.
  const all = questionsToAnswer(analysis).map((question) => ({ question, given: answer(question.id) }));

  const report: Report = {
    format_version: 1,
    index_hash: index.manifest.index_hash,
    prompt_version: index.manifest.prompt_version,
    thresholds_sha256: inputs.thresholdsSha256,
    seed: SEED,
    models: { ...index.manifest.models, reviewer: REVIEWER_MODEL },
    games: index.records.length,
    decision,
    measured,
    enrichment,
    conflict_games: {
      note:
        "On these games a delivered tag contradicts the description. The table cannot tell which side is right, so the table version asserts no mechanic for them; " +
        "their missed mechanics there are counted under missed.conflict_rule. The two model versions carry the model's reading instead, each label quoted from the description or the title; " +
        "a model label backed only by the disputed tag list is withheld.",
      games: index.records.flatMap((candidate) =>
        candidate.conflict === null
          ? []
          : [
              {
                game_id: candidate.game_id,
                title: candidate.canonical.title,
                tag: candidate.conflict.tag,
                tag_asserts: candidate.conflict.tag_asserts,
                description_states: candidate.conflict.description_states,
                model_reading_used: candidate.conflict.model_reading_used,
                model_labels_withheld: candidate.conflict.model_labels_withheld.map((label) => label.label),
                mechanics: Object.fromEntries(
                  LABEL_VERSIONS.map((version) => [version, { status: candidate.versions[version].mechanics?.status ?? "none", labels: candidate.versions[version].mechanics?.labels.map((label) => label.label) ?? [] }]),
                ) as Record<LabelVersion, { status: string; labels: string[] }>,
              },
            ],
      ),
    },
    disagreements: {
      count: analysis.disagreements.length,
      list: analysis.disagreements.map((entry) => {
        const questionId = `label.${entry.game_id}.${entry.label}`;
        return { ...entry, title: record(entry.game_id).canonical.title, question_id: questionId, reviewer: show(questionId) };
      }),
    },
    control: {
      size: analysis.control.length,
      held_back: analysis.control.length - controlList.length,
      reported: controlList.length,
      agreed: controlList.filter((item) => item.agrees).length,
      applies: agreedOf("applies"),
      does_not_apply: agreedOf("does_not_apply"),
      list: controlList,
    },
    owner_check: {
      status: owner === null ? "outstanding" : "answered",
      note: ownerNote,
      of: analysis.ownerQuestions.length,
      from_disagreements: fromDisagreements,
      from_control: analysis.ownerQuestions.length - fromDisagreements,
      matched: owner === null ? null : ownerList.filter((entry) => entry.matched).length,
      blind: { of: blindOf, matched: matchedBlind },
      not_blind: { of: notBlindIds.length, matched: matchedNotBlind, question_ids: notBlindIds },
      questions: ownerList,
    },
    matching,
    check_games: { brand: analysis.checkBrand, games: analysis.checkGames, results: checkResults },
    per_game: Object.fromEntries(VERSIONS.map((version) => [version, analysis.pairwise[version].map((game) => [game.game_id, game.wins, game.pairs])])) as Report["per_game"],
    reviewer: {
      model: REVIEWER_MODEL,
      questions: analysis.questions.length,
      held_back: heldBack.size,
      answered: all.length,
      by_kind: { label: all.filter(({ question }) => question.kind === "label").length, recommendation: all.filter(({ question }) => question.kind === "recommendation").length },
      answers: {
        yes: all.filter(({ given }) => given.answer === "yes").length,
        no: all.filter(({ given }) => given.answer === "no").length,
        unclear: all.filter(({ given }) => given.answer === "unclear").length,
      },
      unclear: all.filter(({ given }) => given.answer === "unclear").map(({ question, given }) => ({ question_id: question.id, said: given.said, note: given.note })),
    },
    gallery: { real: [], injected: [] },
  };
  report.gallery = gallery(analysis, report);

  const verdictFor = (reportPath: string, reportSha256: string): Verdict => ({
    format_version: VERDICT_FORMAT,
    index_hash: report.index_hash,
    thresholds_sha256: inputs.thresholdsSha256,
    prompt_version: report.prompt_version,
    report: { path: reportPath, sha256: reportSha256 },
    serving: { floor_rule: FLOOR_RULE.id, floors: analysis.floors },
    passed: decision.passed,
    ships: decision.ships,
    reason: decision.reason,
    versions: Object.fromEntries(VERSIONS.map((version) => [version, { passed: decision.versions[version].passed, failed_marks: decision.versions[version].failed_marks }])) as Verdict["versions"],
  });
  return { report, verdictFor };
}

// ---------------------------------------------------------------------------
// The gallery: real failures the evaluation found, apart from the mess that was planted on purpose
// ---------------------------------------------------------------------------

function gallery(analysis: Analysis, report: Report): Report["gallery"] {
  const { index, truth, offerings } = analysis.inputs;
  const records = byId(index);
  const title = (gameId: string): string => records.get(gameId)?.canonical.title ?? gameId;
  /** The failures shown are those of the version that ships, or of the top of the ladder when nothing ships. */
  const version: Version = report.decision.ships ?? "model_everywhere";
  const real: GalleryEntry[] = [];

  const disagreement = report.disagreements.list[0];
  if (disagreement !== undefined) {
    real.push({
      kind: "label_outside_the_plan",
      what: "A label was asserted that the plan never gave this game. The reviewer was asked whether the text supports it.",
      game_id: disagreement.game_id,
      title: disagreement.title,
      version: disagreement.asserted_by[0]?.version ?? null,
      detail: { label: disagreement.label, asserted_by: disagreement.asserted_by, reviewer: disagreement.reviewer },
    });
  }

  if (version !== "raw") {
    const miss = report.enrichment[version].missed.list.find((entry) => entry.cause === "not_asserted" && entry.via.some((via) => via !== "source_tags"));
    if (miss !== undefined) {
      const evidence = truth.games.get(miss.game_id)?.evidence.find((entry) => entry.term === miss.label);
      real.push({
        kind: "label_missed",
        what: "The plan says this label can be recovered from the record's own words, and this version did not assert it.",
        game_id: miss.game_id,
        title: title(miss.game_id),
        version,
        detail: {
          label: miss.label,
          recoverable_via: miss.via,
          plan_evidence: evidence?.span ?? null,
          // Whether the model was asked for this record in this version, and whether its stored answer holds the label.
          model_used_for_this_record: version === "model_everywhere" || (version === "model_where_thin" && (records.get(miss.game_id)?.thin ?? false)),
          model_answer_holds_the_label: [...(records.get(miss.game_id)?.model.themes ?? []), ...(records.get(miss.game_id)?.model.mechanics ?? [])].some((label) => label.label === miss.label),
          description: records.get(miss.game_id)?.canonical.description ?? null,
        },
      });
    }
  }

  const worst = [...analysis.pairwise[version]].filter((game) => game.pairs > 0).sort((a, b) => a.wins / a.pairs - b.wins / b.pairs || (a.game_id < b.game_id ? -1 : 1))[0];
  const worstTruth = worst === undefined ? undefined : truth.games.get(worst.game_id);
  if (worst !== undefined && worstTruth !== undefined && worst.wins < worst.pairs) {
    const state = buildState(index, offerings, version);
    const anchorRow = state.rowById.get(worst.game_id) as number;
    const scored = index.records
      .map((candidate, row) => {
        let score = 0;
        for (let column = 0; column < state.dimensions; column += 1) score += (state.vectors[anchorRow * state.dimensions + column] as number) * (state.vectors[row * state.dimensions + column] as number);
        return { candidate, score: Math.round(score * 1e6) / 1e6, pairGrade: grade(worstTruth, truth.games.get(candidate.game_id) ?? worstTruth) };
      })
      .filter(({ candidate }) => candidate.game_id !== worst.game_id);
    const topUnrelated = scored.filter((entry) => entry.pairGrade === "unrelated").sort((a, b) => b.score - a.score)[0];
    const outranked = scored.filter((entry) => (entry.pairGrade === "strong" || entry.pairGrade === "related") && topUnrelated !== undefined && entry.score < topUnrelated.score);
    real.push({
      kind: "unrelated_ranked_above_related",
      what: "The game with the lowest pairwise accuracy in this version: an unrelated game scores above games the plan calls related.",
      game_id: worst.game_id,
      title: title(worst.game_id),
      version,
      detail: {
        pairwise_accuracy: rate(worst.wins, worst.pairs),
        record_condition: records.get(worst.game_id)?.evidence ?? null,
        top_unrelated: topUnrelated === undefined ? null : { game_id: topUnrelated.candidate.game_id, title: topUnrelated.candidate.canonical.title, score: topUnrelated.score },
        related_games_it_outranks: outranked.length,
        example_outranked: outranked[0] === undefined ? null : { game_id: outranked[0].candidate.game_id, title: outranked[0].candidate.canonical.title, score: outranked[0].score },
      },
    });
  }

  // A result the service showed on a check game that the rule calls unrelated: first in the shipped version, else in any.
  for (const candidateVersion of [version, ...VERSIONS.filter((other) => other !== version)]) {
    const hit = report.check_games.results[candidateVersion].flatMap((outcome) => outcome.results.filter((result) => result.grade === "unrelated").map((result) => ({ outcome, result })))[0];
    if (hit === undefined) continue;
    real.push({
      kind: "unrelated_result_shown",
      what: "On a check game the service returned a result that shares nothing the rule counts. The reviewer was asked whether it is still a reasonable suggestion.",
      game_id: hit.outcome.anchor,
      title: hit.outcome.title,
      version: candidateVersion,
      detail: { result: { game_id: hit.result.game_id, title: hit.result.title, rank: hit.result.rank, score: hit.result.score }, reviewer: hit.result.reviewer, wrongly_shown: hit.result.wrongly_shown },
    });
    break;
  }

  // A decline although a strong match was live: the floor's cost.
  const state = buildState(index, offerings, version);
  const statuses = offerings.statusByBrand.get(analysis.checkBrand);
  for (const candidate of index.records) {
    const response = recommend(state, { gameId: candidate.game_id, brand: analysis.checkBrand });
    if (response.decline?.reason !== "nothing_above_floor") continue;
    const anchorTruth = truth.games.get(candidate.game_id);
    if (anchorTruth === undefined) continue;
    const strongLive = index.records.filter((other) => {
      const otherTruth = truth.games.get(other.game_id);
      return other.game_id !== candidate.game_id && otherTruth !== undefined && statuses?.get(other.game_id) === "live" && grade(anchorTruth, otherTruth) === "strong";
    });
    if (strongLive.length === 0) continue;
    real.push({
      kind: "declined_although_a_strong_match_was_live",
      what: "The service declined because nothing cleared the similarity floor, while the plan holds a strongly related game that is live on the brand.",
      game_id: candidate.game_id,
      title: candidate.canonical.title,
      version,
      detail: { brand: analysis.checkBrand, floor: state.floor, record_condition: candidate.evidence, strong_matches_live: strongLive.map((other) => ({ game_id: other.game_id, title: other.canonical.title })) },
    });
    break;
  }

  // Planted on purpose by the catalogue's generator, and what the pipeline did with each.
  const injected: GalleryEntry[] = [];
  const labelsOf = (candidate: IndexRecord): Record<string, string[]> =>
    Object.fromEntries(LABEL_VERSIONS.map((labelVersion) => [labelVersion, FIELDS.flatMap((field) => candidate.versions[labelVersion][field]?.labels.map((label) => label.label) ?? [])]));
  for (const candidate of index.records) {
    const row = truthRowOf(candidate, truth);
    if (row.injected_instruction) {
      const outside = report.disagreements.list.filter((entry) => entry.game_id === candidate.game_id).map((entry) => entry.label);
      injected.push({
        kind: "instruction_planted_in_the_description",
        what: "The description carries an instruction addressed to whoever reads it. It is data: the labels below are what was asserted for this record.",
        game_id: candidate.game_id,
        title: candidate.canonical.title,
        version: null,
        detail: { description: candidate.canonical.description, labels: labelsOf(candidate), labels_outside_the_plan: outside },
      });
    }
    for (const conflicting of row.conflicting_tags) {
      injected.push({
        kind: "tag_planted_to_contradict_the_description",
        what: "A delivered tag asserts one win system and the description states another. The table asserts no mechanic for the record; the two model versions carry the model's reading of the text.",
        game_id: candidate.game_id,
        title: candidate.canonical.title,
        version: null,
        detail: {
          tag: conflicting.tag,
          tag_asserts: conflicting.asserts,
          description_states: conflicting.contradicts,
          planted_label_asserted_by: LABEL_VERSIONS.filter((labelVersion) => candidate.versions[labelVersion].mechanics?.labels.some((label) => label.label === conflicting.asserts)),
          model_reading_used: candidate.conflict?.model_reading_used ?? null,
          mechanics: Object.fromEntries(
            LABEL_VERSIONS.map((labelVersion) => [
              labelVersion,
              candidate.versions[labelVersion].mechanics?.status === "asserted"
                ? (candidate.versions[labelVersion].mechanics?.labels.map((label) => label.label) ?? [])
                : (candidate.versions[labelVersion].mechanics?.status ?? null),
            ]),
          ),
        },
      });
    }
    if (row.mess.includes("near_empty")) {
      injected.push({
        kind: "record_planted_nearly_empty",
        what: "Everything but the title was removed. The right output is to assert nothing that the title does not state, and the service declines to recommend from it.",
        game_id: candidate.game_id,
        title: candidate.canonical.title,
        version: null,
        detail: { evidence: candidate.evidence, labels: labelsOf(candidate) },
      });
    }
  }
  return { real, injected };
}
