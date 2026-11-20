/**
 * The four sections of the page, as plain functions from the service's responses to React elements.
 *
 * Each section states one question on the left and answers it on the right, for the game and brand
 * chosen, with one sentence and one picture. Whatever else is true is named on a button under the
 * answer and drawn only when asked for (evidence.ts); a legend is a hover on the thing it explains. Nothing here fetches, keeps state or touches the document, so the
 * tests render these functions as they are, and the browser gets the same code through the build.
 *
 * Written with `createElement` and no JSX, so that Node runs these files under test with no loader.
 * Text from a response is always a text child, never markup: React escapes it.
 */
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "@ui-sdk/react/accordion";
import { Meter, MeterIndicator, MeterTrack } from "@ui-sdk/react/meter";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { createContext, createElement as h, Fragment, useContext, type ReactNode } from "react";
import type { TraceAnchor } from "../service/recommend.ts";
import {
  GROUPS,
  count,
  estimate,
  failureTab,
  failuresHere,
  heldLabels,
  markText,
  pct,
  plural,
  runsOf,
  sameTag,
  sharedLabels,
  short,
  stepName,
  story,
  versionName,
  words,
  type Evaluation,
  type Failure,
  type Held,
  type Loaded,
  type TabId,
} from "./read.ts";

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

type Tone = "green" | "amber" | "red" | "blue" | "neutral";
/** A status, in words: green kept or passed, amber caution, red failure, blue the model, neutral a plain fact. */
export const label = (tone: Tone, text: string): ReactNode => h("span", { className: `label ${tone}` }, text);
export const mono = (text: unknown): ReactNode => h("code", null, String(text));
/** A theme or a mechanic. Blue when the model asserted it, plain when the synonym table did; a hover says which. */
export const tag = (method: string, term: string, key?: string | number): ReactNode =>
  h("span", { className: `tag ${method === "model" ? "model" : "table"}`, title: method === "model" ? "added by the model" : "read by the lookup table from the supplier's own lists", key }, words(term));
export const ref = (numbers: readonly number[]): ReactNode => (numbers.length === 0 ? null : h("sup", { className: "ref" }, numbers.join(", ")));
export const small = (...children: ReactNode[]): ReactNode => h("span", { className: "small" }, ...children);

/** A bar as long as a number between 0 and 1, with an optional tick for a mark it is read against. */
export function bar(value: number, name: string, options: { tone?: "blue" | "quiet"; at?: number; mark?: string } = {}): ReactNode {
  return h(
    Meter,
    { value: Math.max(0, Math.min(1, value)), min: 0, max: 1, "aria-label": name, className: "bar" },
    h(MeterTrack, { className: "track" }, h(MeterIndicator, { className: `fill${options.tone ? ` ${options.tone}` : ""}` }), options.at === undefined ? null : h("span", { className: "at", style: { left: `${(options.at * 100).toFixed(2)}%` }, title: options.mark ?? "similarity floor" })),
  );
}

/** A number rounded for reading, with the number as the response carries it one hover or one focus away. */
function exact(shown: string, full: string): ReactNode {
  return h(Tooltip, null, h(TooltipTrigger, { className: "exact num" }, shown), h(TooltipContent, { className: "tip" }, full));
}

/** What a section can ask of the page. Outside the page (in a test) the buttons render and do nothing. */
export interface PageActions {
  openEvidence: (id: string, opener: HTMLElement) => void;
  showVersion: (version: string) => void;
}
export const Actions = createContext<PageActions | null>(null);

function EvidenceButton({ id, name }: { id: string; name: string }): ReactNode {
  const page = useContext(Actions);
  return h("button", { type: "button", className: "chip", "data-evidence": id, onClick: (event: { currentTarget: HTMLElement }) => page?.openEvidence(id, event.currentTarget) }, name);
}

/** The evidence behind an answer: at most three buttons, each named for what it opens, and out of sight until pressed. */
function more(...ids: (EvidenceId | null)[]): ReactNode {
  const shown = ids.filter((id) => id !== null);
  return shown.length === 0 ? null : h("div", { className: "chips", "data-more": "" }, shown.map((id) => h(EvidenceButton, { key: id, id, name: EVIDENCE[id] })));
}

/** The names of the evidence the sections offer. One name per piece, and the name says what it opens. */
export const EVIDENCE = {
  scores: "Every score against the similarity floor",
  provenance: "Index, version and timings of this request",
  steps: "Step by step: cleaning, lookup table, thin rule, model",
  "raw-record": "The raw record, exactly as the supplier delivered it",
  gate: "The release gate: its verdict, every pass mark, and what if they moved",
  versions: "This request in every version of the index",
  measures: "Every measured number, the failures found, and what the numbers cannot show",
} as const;
export type EvidenceId = keyof typeof EVIDENCE;

export interface SectionProps {
  data: Loaded;
  evaluation?: Evaluation | undefined;
  /** A game to point out on the path. */
  focus?: string | null | undefined;
}

/** A section: its question and one short line on the left, its answer on the right. */
const section = (id: TabId, title: ReactNode, line: string, ...right: ReactNode[]): ReactNode =>
  h("section", { className: "qa", "data-section": id }, h("div", { className: "question" }, h("h2", { "data-question": "" }, title), h("p", { className: "why" }, line)), h("div", { className: "answer" }, ...right));

function failureNote(entry: Failure, key: number): ReactNode {
  // The evaluation's own sentence, and the label it is about when it names one.
  const named = (entry.detail as { label?: unknown }).label;
  return h("p", { className: "callout amber", "data-failure": "", key }, h("span", null, label("amber", "a failure the evaluation found"), " ", entry.what, typeof named === "string" ? h(Fragment, null, " The label: ", mono(words(named)), ".") : null));
}

/** A version other than the served one is on screen: said wherever it is shown, with the way back. */
function Inspection({ data }: { data: Loaded }): ReactNode {
  const page = useContext(Actions);
  const { response } = data;
  if (!response.inspection || response.inspection.is_served_version) return null;
  const servedVersion = response.inspection.served_version;
  return h(
    "p",
    { className: "callout blue", "data-inspection": "" },
    h("span", null, label("neutral", "inspection"), ` This is ${versionName(response.served.version)}, shown for comparison. Players are served ${versionName(servedVersion)}. `, h("button", { type: "button", className: "link", onClick: () => page?.showVersion(servedVersion) }, "Back to the served version")),
  );
}

// ---------------------------------------------------------------------------
// 1 · Shown
// ---------------------------------------------------------------------------

export function Shown({ data, evaluation }: SectionProps): ReactNode {
  const { response, neighbours } = data;
  const anchor = response.trace?.anchor ?? null;
  const title = anchor ? anchor.title : response.request.game_id;
  const { brand } = response.request;
  const failures = failuresHere(evaluation, response).filter((entry) => failureTab(entry) === "shown").map(failureNote);
  const ask = h(Fragment, null, "A player has just played ", h("em", null, title), ` on ${brand}. What should they be shown next?`);
  const line = "Only games that can be opened on this brand, or nothing rather than a guess.";
  if (response.outcome === "declined" && response.decline) {
    return section(
      "shown",
      ask,
      line,
      h(Inspection, { data }),
      h(
        "div",
        { className: "callout amber decline", "data-first": "" },
        h("p", { "data-decline": "", "data-answer": "" }, label("amber", "declined"), " ", h("strong", null, `Given ${title} on ${brand}, the service recommends nothing, and says why.`)),
        h("p", { className: "reason" }, response.decline.detail),
        h("p", null, "A player would see nothing. ", small("Reason code ", mono(response.decline.reason))),
      ),
      failures,
      more(response.trace && response.trace.scores.length > 0 ? "scores" : null, "provenance"),
    );
  }
  const floor = response.trace?.floor;
  const rows = response.results.map((entry, index) => {
    const shared = sharedLabels(anchor, neighbours[entry.game_id]);
    let common: ReactNode;
    if (anchor?.fields === null) common = h("p", { className: "why small" }, "No labels in this version: only the two texts are alike.");
    else if (shared.length === 0) common = h("p", { className: "why small" }, "No label in common: only the two texts are alike.");
    else common = h("p", { className: "why", "data-shared": "" }, small("in common"), " ", shared.map((held, at) => h(Fragment, { key: at }, tag(held.method, held.label), " ")));
    // The exact score, and how to read the row, are one hover or one focus away.
    const reading = `Similarity ${entry.score}${floor === undefined ? "" : `, against a floor of ${floor}`}. The order is a similarity between two texts and cannot be traced to single labels: what the two games have in common is shown to help read the list, not as the cause of its score.`;
    return h("li", { key: entry.game_id, ...(index === 0 ? { "data-first": "" } : {}) }, h("span", { className: "rank num" }, entry.rank), h("div", { className: "who" }, h("strong", null, entry.title), " ", small(entry.provider)), common, h("span", { className: "score" }, exact(short(entry.score), reading)));
  });
  return section(
    "shown",
    ask,
    line,
    h(Inspection, { data }),
    h(
      "p",
      { className: "lede", "data-answer": "" },
      label("green", "result"),
      " Given ",
      h("strong", null, title),
      " on ",
      h("strong", null, brand),
      `, the service returns ${plural(response.results.length, "game that scored above the similarity floor and is", "games that scored above the similarity floor and are")} live there, closest first.`,
    ),
    h("ol", { className: "results", "data-results": "" }, rows),
    failures,
    more("scores", "provenance"),
  );
}

// ---------------------------------------------------------------------------
// 2 · Added
// ---------------------------------------------------------------------------

/** A field of the record as delivered, with an empty one said in words. */
export function absent(value: unknown): ReactNode {
  if (value === null || value === undefined) return h("span", { className: "absent" }, "(none delivered)");
  if (Array.isArray(value)) return value.length === 0 ? h("span", { className: "absent" }, "(empty list)") : value.map((item, index) => h(Fragment, { key: index }, mono(item), " "));
  if (value === "") return h("span", { className: "absent" }, "(empty)");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

type Numbered = Held & { n: number };

/** What the supplier's structured fields held, what the version holds now, and the supplier's text with every quoted phrase marked in place. */
export function recordCards(anchor: TraceAnchor, version: string): ReactNode {
  const d = anchor.delivered;
  const { cleaned, table, conflict } = anchor.steps;
  const held: Numbered[] = heldLabels(anchor).map((entry, index) => ({ ...entry, n: index + 1 }));
  const placed = new Set<number>();
  const text = (field: "title" | "description"): ReactNode => {
    const value = cleaned[field];
    if (typeof value !== "string") return absent(value);
    const marked = markText(value, held.filter((entry) => entry.source_field === field));
    for (const number of marked.placed) placed.add(number);
    return h("p", { className: "copy" }, marked.pieces.map((piece, index) => (piece.numbers === undefined ? h(Fragment, { key: index }, piece.text) : h(Fragment, { key: index }, h("mark", null, piece.text), ref(piece.numbers)))));
  };
  const tags = (field: "features" | "themes" | "tags"): ReactNode => {
    const delivered = d[field];
    if (!Array.isArray(delivered) || delivered.length === 0) return absent(delivered);
    return delivered.map((sent, index) => {
      const numbers = held.filter((entry) => entry.source_field === field && sameTag(entry.quote, sent)).map((entry) => entry.n);
      for (const number of numbers) placed.add(number);
      let body: ReactNode;
      const dropped = table.dropped.find((entry) => sameTag(entry.tag, sent));
      if (conflict !== null && sameTag(conflict.tag, sent)) body = h(Fragment, null, h("span", { className: "tag contradicted" }, sent), " ", small("contradicted by the description"));
      else if (dropped) body = h(Fragment, null, h("span", { className: "tag dropped" }, sent), " ", small(`not about the game (${words(dropped.reason)})`));
      else if (table.unknown.some((entry) => sameTag(entry.tag, sent))) body = h(Fragment, null, h("span", { className: "tag unknown" }, sent), " ", small("unknown to the table, not guessed"));
      else body = h(Fragment, null, h("span", { className: "tag table" }, sent), ref(numbers));
      return h("span", { className: "sent", key: index }, body, " ");
    });
  };
  // The order matters: the fields are drawn first, so that every label knows whether its words were found.
  const fields = h("dl", { className: "kv" }, h("dt", null, "features"), h("dd", null, tags("features")), h("dt", null, "themes"), h("dd", null, tags("themes")), h("dt", null, "tags"), h("dd", null, tags("tags")));
  const prose = h("dl", { className: "kv" }, h("dt", null, "title"), h("dd", null, text("title")), h("dt", null, "description"), h("dd", null, text("description")));

  const fieldLine = (name: "Themes" | "Mechanics", field: NonNullable<TraceAnchor["fields"]>["themes"]): ReactNode => {
    if (field.status !== "asserted") {
      const why = field.status === "conflict" ? "An entry the supplier sent and the description disagree, so nothing is asserted." : "Nothing in the record supports a label, so none is asserted.";
      return h("li", { key: name }, h("strong", null, name), h("span", null, label("amber", field.status === "conflict" ? "conflicting" : "abstained"), " ", small(why)));
    }
    const chips = held
      .filter((entry) => entry.field === name.toLowerCase())
      .map((entry) => {
        const textual = entry.source_field === "title" || entry.source_field === "description";
        return h("span", { className: "sent", key: entry.n }, tag(entry.method, entry.label), placed.has(entry.n) ? ref([entry.n]) : null, textual && !placed.has(entry.n) ? h(Fragment, null, " ", label("amber", "words not found in the record")) : null, " ");
      });
    return h("li", { key: name }, h("strong", null, name), h("span", null, chips));
  };
  const holds =
    anchor.fields === null
      ? h("p", { className: "small" }, "No labels: this version indexes the supplier's text as it is.")
      : h("ul", { className: "fields" }, fieldLine("Themes", anchor.fields.themes), fieldLine("Mechanics", anchor.fields.mechanics));
  return h(
    Fragment,
    null,
    h("div", { className: "pair" }, h("div", { className: "card", "data-first": "" }, h("h3", null, "The supplier sent"), fields), h("div", { className: "card holds" }, h("h3", null, `${versionName(version)} holds`), holds)),
    h("div", { className: "card text" }, h("h3", null, "The supplier's text, with the words each label was read from", h("span", { className: "small" }, " · a number joins a label to its words")), prose),
  );
}

export function Added({ data, evaluation }: SectionProps): ReactNode {
  const { response } = data;
  const anchor = response.trace?.anchor ?? null;
  const version = response.served.version;
  const ask = "Suppliers send thin, messy records. Can a model fill in what is missing without inventing anything?";
  const line = "A label is kept only if it quotes the record's own words.";
  if (anchor === null) return section("added", ask, line, h(Inspection, { data }), h("p", { className: "lede", "data-answer": "", "data-first": "" }, `The index holds no record for ${response.request.game_id}, so there is nothing a model could have added.`));
  const failures = failuresHere(evaluation, response).filter((entry) => failureTab(entry) === "added").map(failureNote);
  return section("added", ask, line, h(Inspection, { data }), h("p", { className: "lede", "data-answer": "", "data-story": "" }, story(anchor, version)), failures, recordCards(anchor, version), more("steps", "raw-record"));
}

// ---------------------------------------------------------------------------
// 3 · Removed
// ---------------------------------------------------------------------------

/**
 * Why these games and not others: the steps the trace gives, in its order, as one flow with the number
 * left after each. Every step says which of three different things it decides: a rule, a score or a
 * limit. None of them is evidence that a player would find the result relevant, and the step that
 * applies the floor says so when it is opened.
 */
export function Removed({ data, focus }: SectionProps): ReactNode {
  const { response } = data;
  const trace = response.trace;
  const filters = trace?.filters ?? [];
  const first = filters[0];
  const start = first === undefined ? null : first.removed.length + first.remaining;
  const shown = response.results.length;
  const ask = start === null ? "Out of the whole catalogue, why these games? What was removed, and in what order?" : `Out of ${count(start)} games, why ${shown === 0 ? "none" : `these ${count(shown)}`}? What was removed, and in what order?`;
  const line = "Availability is settled before any score exists.";
  if (trace === undefined || first === undefined || start === null) {
    return section("removed", ask, line, h(Inspection, { data }), h("p", { className: "lede", "data-answer": "", "data-first": "" }, "The request was declined before any filter ran: no game was removed and none was scored."), more("provenance"));
  }
  const runs = runsOf(filters);
  let found: ReactNode = null;
  let open: string[] = [];
  /** What is true of every step that decides this kind of thing. Said when a step is opened. */
  const says = (run: (typeof runs)[number]): ReactNode => {
    if (run.group === "eligible") return "A rule, not a score. A game that is not live on the brand is removed before anything is scored.";
    if (run.group === "similar") return `The floor is ${trace.floor}. ${trace.floor_rule} It is a point in the spread of scores: it says a game is closer than most pairs are, not that a player would find it relevant.`;
    if (run.group !== "limit") return null;
    const cut = run.steps.flatMap(({ step }) => step.removed);
    if (cut.length === 0) return "A limit, not a score. Every game that cleared the floor is shown.";
    return h(Fragment, null, "A limit, not a score. Cleared the floor and not shown: ", cut.map((entry, index) => h(Fragment, { key: entry.game_id }, index === 0 ? "" : ", ", h("strong", null, entry.title), ` (${words(entry.why)})`)), ".");
  };
  const steps = runs.flatMap((run) =>
    run.steps.map(({ step, index }) => {
      const name = stepName(step.filter);
      const hit = focus ? step.removed.find((entry) => entry.game_id === focus) : undefined;
      if (hit) {
        open = [`step-${index}`];
        found = h("p", { className: "callout amber", "data-focus": "" }, h("span", null, label("amber", "removed"), " ", h("strong", null, hit.title), ` was taken out at the step “${name}”: ${words(hit.why)}.`));
      }
      // The game a link points at comes first in its list, so it is in view when the step opens.
      const removed =
        step.removed.length === 0
          ? h("p", { className: "small" }, "This step removed nothing.")
          : h("ul", { className: "removed" }, [...step.removed].sort((a, b) => Number(b.game_id === focus) - Number(a.game_id === focus)).map((entry) => h("li", { key: entry.game_id, className: entry.game_id === focus ? "focus" : undefined }, h("span", null, entry.title, " ", small(entry.provider)), h("span", { className: "why" }, words(entry.why)))));
      return h(
        AccordionItem,
        { key: index, value: `step-${index}`, className: "step-item" },
        h(
          AccordionHeader,
          { render: h("h3", index === 0 ? { "data-first": "" } : null) },
          h(
            AccordionTrigger,
            { className: `node step${step.removed.length === 0 ? " quiet" : ""}`, title: `${name}: ${step.rule}`, ...{ "data-group": run.group } },
            h("span", { className: "kind" }, GROUPS[run.group]),
            h("span", { className: "n num" }, count(step.remaining)),
            h("span", { className: "name" }, name),
            h("span", { className: "cut num" }, step.removed.length === 0 ? "none removed" : `−${count(step.removed.length)}`),
          ),
        ),
        h(AccordionPanel, { className: "step-panel" }, h("p", null, h("strong", null, `${name}.`), " ", step.rule), h("p", { className: "small" }, says(run)), removed),
      );
    }),
  );
  if (focus && found === null) {
    const result = response.results.find((entry) => entry.game_id === focus);
    if (result) found = h("p", { className: "callout green", "data-focus": "" }, h("span", null, label("green", "shown"), " ", h("strong", null, result.title), ` passes every step here and is shown at rank ${result.rank}.`));
  }
  const before = runs[0]?.group === "eligible" ? runs[0].steps.reduce((sum, { step }) => sum + step.removed.length, 0) : null;
  return section(
    "removed",
    ask,
    line,
    h(Inspection, { data }),
    h("p", { className: "lede", "data-answer": "" }, `Of the ${plural(start, "game", "games")} in the catalogue, ${shown === 0 ? "none is shown" : `${count(shown)} ${shown === 1 ? "is" : "are"} shown`}.`, before === null ? "" : ` ${plural(before, "was", "were")} removed by rules before anything was scored.`, " Open a step to see what it removed."),
    found,
    // One flow, read from left to right. One step is open at a time; a game an address points at opens the step that removed it.
    h(
      Accordion,
      { className: "flow", style: { "--steps": filters.length + 2 } as Record<string, number>, defaultValue: open, collapsible: true, key: `${response.request.game_id} ${response.request.brand} ${response.served.version} ${focus ?? ""}`, "aria-label": "The steps from the catalogue to the result" },
      h("div", { className: "node start" }, h("span", { className: "kind" }, "start"), h("span", { className: "n num" }, count(start)), h("span", { className: "name" }, "In the catalogue"), h("span", { className: "cut" }, " ")),
      steps,
      h("div", { className: `node end${shown === 0 ? " none" : ""}` }, h("span", { className: "kind" }, "result"), h("span", { className: "n num" }, count(shown)), h("span", { className: "name" }, "Shown"), h("span", { className: "cut" }, " ")),
    ),
    more(trace.scores.length > 0 ? "scores" : null, "provenance"),
  );
}

// ---------------------------------------------------------------------------
// 4 · Worth it
// ---------------------------------------------------------------------------

/** The limits of the evaluation, as its plan states them. */
export const LIMITS =
  "The catalogue is fictional and easier than real supplier data. Its answer key is the generator's own plan, its text was written by the same model that does the enrichment, and the reviewer of disputed cases is a model from the same vendor, so the three can share blind spots. These numbers show direction and the absence of glaring failure, not production accuracy.";

/** What "ranked right" measures. A hover on the column's heading, and written out with the numbers. */
export const RANKED_RIGHT = "Ranked right: how often a game the answer key calls related scores above one it calls unrelated, over every game of this fictional catalogue.";

export function Worth({ evaluation }: SectionProps): ReactNode {
  const ask = "The model costs money. Does it rank related games better than plain code, and by how much?";
  const line = "Every version is measured against one answer key; the simplest that is good enough is served.";
  if (evaluation === undefined) return section("worth", ask, line, h("p", { "data-answer": "", "data-first": "" }, "Loading"));
  const { report, verdict } = evaluation;
  const names = Object.keys(report.matching) as (keyof typeof report.matching)[];
  const row = (version: string) => (report.matching as Record<string, (typeof report.matching)["raw"] | undefined>)[version];
  const served = verdict.ships;
  const servedRow = served === null ? undefined : row(served);
  const rate = (version: string): number => row(version)?.pairwise.pooled.rate ?? 0;
  const best = (withModel: boolean): string | undefined => names.filter((version) => (report.matching[version].cost.model_calls > 0) === withModel).sort((a, b) => rate(b) - rate(a))[0];
  let sentence: ReactNode;
  if (served === null || servedRow === undefined) sentence = h(Fragment, null, label("red", "not serving"), " No version passes its pass marks, so nothing is served.");
  else {
    const usesModel = servedRow.cost.model_calls > 0;
    const other = best(!usesModel);
    const otherRow = other === undefined ? undefined : row(other);
    const mine = servedRow.pairwise.pooled.rate;
    const theirs = otherRow?.pairwise.pooled.rate;
    let against: ReactNode = ".";
    if (other !== undefined && otherRow !== undefined && typeof mine === "number" && typeof theirs === "number") {
      const points = Math.abs((mine - theirs) * 100).toFixed(1);
      const gap = mine === theirs ? "the same" : `${points} points ${mine > theirs ? "more" : "fewer"}`;
      against = h(Fragment, null, `, against ${pct(theirs)} for `, h("strong", null, versionName(other)), `, the best version built ${usesModel ? "without" : "with"} the model: ${gap}, for an estimated ${estimate(servedRow.cost.estimated_usd).replace("about ", "")} a build against ${estimate(otherRow.cost.estimated_usd)}.`);
    }
    sentence = h(Fragment, null, h("strong", null, versionName(served)), ` is served. It ranks ${pct(mine)} of the test pairs in the right order`, against);
  }
  const passMark = evaluation.thresholds.matching.min_pairwise_accuracy;
  const rows = names.map((version, index) => {
    const entry = report.matching[version];
    const failed = report.decision.versions[version]?.passed === false;
    return h(
      "tr",
      { key: version, className: version === served ? "served" : undefined, ...(index === 0 ? { "data-first": "" } : {}) },
      h("th", { scope: "row" }, h("span", { className: "name" }, versionName(version), version === served ? h(Fragment, null, " ", label("green", "served")) : null), small(entry.cost.model_calls === 0 ? "no model" : plural(entry.cost.model_calls, "model call", "model calls"), failed ? h("span", { className: "fails" }, " · fails a pass mark") : null)),
      h("td", null, h("div", { className: "rate" }, h("span", { className: "big num" }, pct(entry.pairwise.pooled.rate)), bar(entry.pairwise.pooled.rate ?? 0, `${versionName(version)}: ranked right`, { at: passMark, mark: `pass mark ${passMark}` }))),
      h("td", { className: "num cost" }, estimate(entry.cost.estimated_usd)),
    );
  });
  return section(
    "worth",
    ask,
    line,
    h("p", { className: "lede", "data-answer": "" }, sentence),
    h(
      "table",
      { className: "race", "data-measured": "" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Version of the index"), h("th", { scope: "col", title: `${RANKED_RIGHT} The tick is the pass mark.` }, "Ranked right"), h("th", { scope: "col", className: "num", title: "An estimate from the model calls each build made, not a bill." }, "Estimated cost of a build"))),
      h("tbody", null, rows),
    ),
    h("p", { className: "small", "data-limits": "" }, "A fictional catalogue, scored against its generator's own answer key: these numbers show direction, not how real players would judge a list."),
    more("gate", "versions", "measures"),
  );
}

export const SECTIONS: Record<TabId, (props: SectionProps) => ReactNode> = { shown: Shown, added: Added, removed: Removed, worth: Worth };

// ---------------------------------------------------------------------------
// States that are not an answer
// ---------------------------------------------------------------------------

export const Loading = (): ReactNode => h("p", { className: "state", "data-state": "loading" }, "Loading");
export const Empty = (): ReactNode => h("p", { className: "state lede", "data-state": "empty" }, "Choose a game and a brand above, or open an example. The page will show what the service returns for it, and why.");
export const BadInput = ({ message }: { message: string }): ReactNode => h("p", { className: "state", "data-state": "bad-request" }, label("amber", "bad request"), " ", message);
export const Failed = ({ message }: { message: string }): ReactNode => h("p", { className: "state", "data-state": "failed" }, label("red", "failed"), " ", message, " Nothing is shown because nothing was received.");

/** What is wrong with the page's address, each problem in a sentence. */
export function AddressProblems({ problems }: { problems: readonly string[] }): ReactNode {
  if (problems.length === 0) return null;
  return h("div", { className: "callout amber", "data-address-problem": "", role: "alert" }, problems.map((problem, index) => h("p", { key: index }, index === 0 ? h(Fragment, null, label("amber", "check the address"), " ") : null, problem)));
}
