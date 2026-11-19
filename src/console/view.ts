/**
 * The four sections of the page, as plain functions from the service's responses to React elements.
 *
 * Each section states one question on the left and answers it on the right, for the game and brand
 * chosen. Whatever is true and not the answer is named on a button under the answer and drawn only
 * when asked for (evidence.ts). Nothing here fetches, keeps state or touches the document, so the
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
  TABS,
  count,
  estimate,
  failureTab,
  failuresHere,
  heldLabels,
  markText,
  overlap,
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
  type Example,
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
/** A theme or a mechanic. Blue when the model asserted it, plain when the synonym table did. */
export const tag = (method: string, term: string, key?: string | number): ReactNode => h("span", { className: `tag ${method === "model" ? "model" : "table"}`, key }, words(term));
export const ref = (numbers: readonly number[]): ReactNode => (numbers.length === 0 ? null : h("sup", { className: "ref" }, numbers.join(", ")));
export const small = (...children: ReactNode[]): ReactNode => h("span", { className: "small" }, ...children);

/** A bar as long as a number between 0 and 1, with an optional tick for a mark it is read against. */
export function bar(value: number, name: string, options: { tone?: "blue" | "quiet"; at?: number } = {}): ReactNode {
  return h(
    Meter,
    { value: Math.max(0, Math.min(1, value)), min: 0, max: 1, "aria-label": name, className: "bar" },
    h(MeterTrack, { className: "track" }, h(MeterIndicator, { className: `fill${options.tone ? ` ${options.tone}` : ""}` }), options.at === undefined ? null : h("span", { className: "at", style: { left: `${(options.at * 100).toFixed(2)}%` }, title: "similarity floor" })),
  );
}

/** A number rounded for reading, with the number as the response carries it one hover or one focus away. */
function exact(shown: string, full: string): ReactNode {
  return h(Tooltip, null, h(TooltipTrigger, { className: "exact num" }, shown), h(TooltipContent, { className: "tip" }, full));
}

/** How the page opens a piece of evidence. Outside the page (in a test) the buttons render and do nothing. */
export const OpenEvidence = createContext<((id: string, opener: HTMLElement) => void) | null>(null);

function EvidenceButton({ id, name }: { id: string; name: string }): ReactNode {
  const open = useContext(OpenEvidence);
  return h("button", { type: "button", className: "chip", "data-evidence": id, onClick: (event: { currentTarget: HTMLElement }) => open?.(id, event.currentTarget) }, name);
}

/** The evidence behind an answer: named, and out of sight until asked for. */
function more(items: readonly (readonly [id: string, name: string] | null)[]): ReactNode {
  const shown = items.filter((item) => item !== null);
  if (shown.length === 0) return null;
  return h("div", { className: "more", "data-more": "" }, h("p", { className: "kicker" }, "The evidence, when you want it"), h("div", { className: "chips" }, shown.map(([id, name]) => h(EvidenceButton, { key: id, id, name }))));
}

/** The names of the evidence each section offers. One name per piece, and the name says what it opens. */
export const EVIDENCE = {
  scores: "Every score against the similarity floor",
  provenance: "Index, version and timings of this request",
  steps: "Step by step: cleaning, lookup table, thin rule, model",
  "raw-record": "The raw record, exactly as the supplier delivered it",
  verdict: "The release gate's verdict and every pass mark",
  "what-if": "What if the pass marks were different?",
  versions: "This request in every version of the index",
  numbers: "Every measured number, and the split by record condition",
  "enrichment-measures": "Is enrichment safe to automate? Label measures, tag conflicts and the reviewer",
  gallery: "Failures: what went wrong, and what was planted on purpose",
} as const;
export type EvidenceId = keyof typeof EVIDENCE;
const offer = (id: EvidenceId): readonly [string, string] => [id, EVIDENCE[id]];

export interface SectionProps {
  data: Loaded;
  evaluation?: Evaluation | undefined;
  /** The example that is open, if the request is one: its line is shown with the question. */
  example?: Example | null | undefined;
  /** A game to point out on the path. */
  focus?: string | null | undefined;
}

/** The left of a section: which question it answers, and why it matters. */
function question(n: number, title: ReactNode, why: string, example: Example | null | undefined, tab: TabId): ReactNode {
  const look =
    example && example.found
      ? h("p", { className: "look", "data-look": "" }, label("neutral", "this example"), " ", h("strong", null, example.name, "."), " ", example.note, example.tab && example.tab !== tab ? ` It is shown under “${TAB_NAMES[example.tab]}”.` : "")
      : null;
  return h("div", { className: "question" }, h("p", { className: "kicker" }, `Question ${n} of 4`), h("h2", { "data-question": "" }, title), h("p", { className: "why" }, why), look);
}
const TAB_NAMES = Object.fromEntries(TABS.map((tab) => [tab.id, tab.name])) as Record<TabId, string>;

const section = (id: TabId, left: ReactNode, ...right: ReactNode[]): ReactNode => h("section", { className: "qa", "data-section": id }, left, h("div", { className: "answer" }, ...right));

function failureNote(entry: Failure, key: number): ReactNode {
  const about = [typeof entry.detail["label"] === "string" ? `label ${words(entry.detail["label"])}` : "", entry.version ? `in ${versionName(entry.version)}` : ""].filter(Boolean).join(", ");
  return h("p", { className: "callout amber", "data-failure": "", key }, h("span", null, label("amber", "a failure the evaluation found"), " ", entry.what, about ? h(Fragment, null, " ", small(about)) : null));
}

function inspection(data: Loaded): ReactNode {
  const { response } = data;
  if (!response.inspection || response.inspection.is_served_version) return null;
  return h("p", { className: "callout blue", "data-inspection": "" }, h("span", null, label("neutral", "inspection"), ` This is ${versionName(response.served.version)}, shown for comparison. Players are served ${versionName(response.inspection.served_version)}.`));
}

// ---------------------------------------------------------------------------
// 1 · Shown
// ---------------------------------------------------------------------------

export function Shown({ data, evaluation, example }: SectionProps): ReactNode {
  const { response, neighbours } = data;
  const anchor = response.trace?.anchor ?? null;
  const title = anchor ? anchor.title : response.request.game_id;
  const { brand } = response.request;
  const failures = failuresHere(evaluation, response).filter((entry) => failureTab(entry) === "shown").map(failureNote);
  const left = question(
    1,
    h(Fragment, null, "A player has just played ", h("em", null, title), ` on ${brand}. What should they be shown next?`),
    "A row of suggestions earns its place only if every game on it can be opened on this brand, and if it shows nothing rather than a guess.",
    example,
    "shown",
  );
  if (response.outcome === "declined" && response.decline) {
    return section(
      "shown",
      left,
      inspection(data),
      h(
        "div",
        { className: "callout amber decline", "data-first": "" },
        h("p", { "data-decline": "", "data-answer": "" }, label("amber", "declined"), " ", h("strong", null, `Given ${title} on ${brand}, the service recommends nothing, and says why.`)),
        h("p", { className: "reason" }, response.decline.detail),
        h("p", null, "A player would see nothing. ", small("Reason code ", mono(response.decline.reason))),
      ),
      failures,
      more([response.trace && response.trace.scores.length > 0 ? offer("scores") : null, offer("provenance")]),
    );
  }
  const floor = response.trace?.floor;
  const rows = response.results.map((entry, index) => {
    const shared = sharedLabels(anchor, neighbours[entry.game_id]);
    let common: ReactNode;
    if (anchor?.fields === null) common = h("p", { className: "why small" }, "No labels in this version: only the two texts are alike.");
    else if (shared.length === 0) common = h("p", { className: "why small" }, "No label in common: only the two texts are alike.");
    else common = h("p", { className: "why", "data-shared": "" }, small("in common"), " ", shared.map((held, at) => h(Fragment, { key: at }, tag(held.method, held.label), " ")));
    return h(
      "li",
      { key: entry.game_id, style: { "--i": index } as Record<string, number>, ...(index === 0 ? { "data-first": "" } : {}) },
      h("span", { className: "rank num" }, entry.rank),
      h("div", null, h("strong", null, entry.title), " ", small(entry.provider), common),
      h("span", { className: "score" }, small("score"), " ", exact(short(entry.score), `Similarity ${entry.score}${floor === undefined ? "" : `, against a floor of ${floor}`} · ${entry.game_id}`)),
    );
  });
  return section(
    "shown",
    left,
    inspection(data),
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
    h("p", { className: "small" }, "In common is what both records hold in this version. The order is a similarity between two texts and cannot be traced to single labels, so what is in common is shown to help read the list, not as the cause of its score. ", tag("model", "blue"), " was added by the model, ", tag("table", "plain"), " came from the supplier's tags."),
    more([offer("scores"), offer("provenance")]),
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
      const why = field.status === "conflict" ? "The supplier's tag and the description disagree, so nothing is asserted." : "Nothing in the record supports a label, so none is asserted.";
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
      ? h("p", null, label("neutral", "no labels"), " This version indexes the supplier's text as it is.")
      : h(
          Fragment,
          null,
          h("ul", { className: "fields" }, fieldLine("Themes", anchor.fields.themes), fieldLine("Mechanics", anchor.fields.mechanics)),
          h("p", { className: "small" }, tag("model", "blue"), " was added by the model, ", tag("table", "plain"), " by the lookup table. A number joins a label to the words it was read from."),
        );
  return h(
    Fragment,
    null,
    h("div", { className: "pair" }, h("div", { className: "card", "data-first": "" }, h("h3", null, "The supplier sent"), fields), h("div", { className: "card holds" }, h("h3", null, `${versionName(version)} holds`), holds)),
    h("div", { className: "card" }, h("h3", null, "The supplier's text, with the words each label was read from"), prose),
  );
}

export function Added({ data, evaluation, example }: SectionProps): ReactNode {
  const { response } = data;
  const anchor = response.trace?.anchor ?? null;
  const version = response.served.version;
  const left = question(
    2,
    "Suppliers send thin, messy records. Can a model fill in what is missing without inventing anything?",
    "A label nobody can check is a liability. Here a label is kept only if it quotes the record's own words, and the model is asked offline, never while a player waits.",
    example,
    "added",
  );
  if (anchor === null) return section("added", left, inspection(data), h("p", { className: "lede", "data-answer": "", "data-first": "" }, label("amber", "no record"), ` The index holds no record for ${response.request.game_id}, so there is nothing a model could have added.`));
  const failures = failuresHere(evaluation, response).filter((entry) => failureTab(entry) === "added").map(failureNote);
  const measured = (evaluation?.report.enrichment as Record<string, Evaluation["report"]["enrichment"]["table"]> | undefined)?.[version];
  return section(
    "added",
    left,
    inspection(data),
    h("p", { className: "lede", "data-answer": "", "data-story": "" }, h("strong", null, anchor.title, "."), " ", story(anchor, version).join(" ")),
    failures,
    recordCards(anchor, version),
    measured === undefined
      ? null
      : h("p", { className: "small", "data-invented": "" }, `Across the whole catalogue, ${plural(measured.invalid_quotes.count, "label", "labels")} of the ${count(measured.invalid_quotes.of)} that ${versionName(version)} holds ${measured.invalid_quotes.count === 1 ? "quotes" : "quote"} words that are not in the record. Whether a label is right is measured separately, under “Worth it”.`),
    more([offer("steps"), offer("raw-record")]),
  );
}

// ---------------------------------------------------------------------------
// 3 · Removed
// ---------------------------------------------------------------------------

/**
 * Why these games and not others: the steps the trace gives, in its order, set out as the three
 * different things they decide. Eligibility is rules, the floor is a point in the spread of scores,
 * and the limit is a number: none of them is evidence that a player would find the result relevant.
 */
export function Removed({ data, example, focus }: SectionProps): ReactNode {
  const { response } = data;
  const trace = response.trace;
  const filters = trace?.filters ?? [];
  const first = filters[0];
  const start = first === undefined ? null : first.removed.length + first.remaining;
  const shown = response.results.length;
  const left = question(
    3,
    start === null ? "Out of the whole catalogue, why these games? What was removed, and in what order?" : `Out of ${count(start)} games, why ${shown === 0 ? "none" : `these ${count(shown)}`}? What was removed, and in what order?`,
    "A game that cannot be opened on this brand must never be suggested, so availability is settled before any score exists. Similarity decides next, and a limit keeps the list short.",
    example,
    "removed",
  );
  if (trace === undefined || first === undefined || start === null) {
    return section("removed", left, inspection(data), h("p", { className: "lede", "data-answer": "", "data-first": "" }, label("amber", "no steps"), " The request was declined before any filter ran: no game was removed and none was scored."), more([offer("provenance")]));
  }
  const runs = runsOf(filters);
  const length = (remaining: number): number => (start === 0 ? 0 : remaining / start);
  let found: ReactNode = null;
  let open: string[] = [];
  const says = (run: (typeof runs)[number]): ReactNode => {
    if (run.group === "eligible") return "Rules, not scores. A game that is not live on the brand is removed before anything is scored.";
    if (run.group === "similar") return `The floor is ${trace.floor}. ${trace.floor_rule} It is a point in the spread of scores: it says a game is closer than most pairs are, not that a player would find it relevant.`;
    if (run.group !== "limit") return null;
    const cut = run.steps.flatMap(({ step }) => step.removed);
    if (cut.length === 0) return "Every game that cleared the floor is shown.";
    if (cut.length > 3) return `${plural(cut.length, "game", "games")} cleared the floor and are not shown. Open a step to see them.`;
    return h(Fragment, null, "Cleared the floor and not shown: ", cut.map((entry, index) => h(Fragment, { key: entry.game_id }, index === 0 ? "" : ", ", h("strong", null, entry.title), ` (${words(entry.why)})`)), ".");
  };
  const stages = runs.map((run, at) => {
    const nodes = run.steps.map(({ step, index }) => {
      const name = stepName(step.filter);
      const hit = focus ? step.removed.find((entry) => entry.game_id === focus) : undefined;
      if (hit) {
        open = [`step-${index}`];
        found = h("p", { className: "callout amber", "data-focus": "" }, h("span", null, label("amber", "removed"), " ", h("strong", null, hit.title), ` was taken out at the step “${name}”: ${words(hit.why)}.`));
      }
      const removed =
        step.removed.length === 0
          ? h("p", { className: "small" }, "This step removed nothing.")
          : h("ul", { className: "removed" }, step.removed.map((entry) => h("li", { key: entry.game_id, className: entry.game_id === focus ? "focus" : undefined }, h("span", null, entry.title, " ", small(entry.provider)), h("span", { className: "why" }, words(entry.why)))));
      return h(
        AccordionItem,
        { key: index, value: `step-${index}`, className: "step-item" },
        h(
          AccordionHeader,
          { render: h("h4", index === 0 ? { "data-first": "" } : null) },
          h(AccordionTrigger, { className: `node step${step.removed.length === 0 ? " quiet" : ""}`, title: step.filter }, h("span", { className: "n num" }, count(step.remaining)), h("span", { className: "name" }, name), h("span", { className: "cut num" }, step.removed.length === 0 ? "none removed" : `${count(step.removed.length)} removed`), bar(length(step.remaining), `${name}: games left`)),
        ),
        h(AccordionPanel, { className: "step-panel" }, h("p", null, h("strong", null, `${name}.`), " ", step.rule), removed),
      );
    });
    const begin = at === 0 ? h("div", { className: "node start" }, h("span", { className: "n num" }, count(start)), h("span", { className: "name" }, "In the catalogue"), h("span", { className: "cut" }, " "), bar(length(start), "In the catalogue")) : null;
    const end = at === runs.length - 1 ? h("div", { className: `node end${shown === 0 ? " none" : ""}` }, h("span", { className: "n num" }, count(shown)), h("span", { className: "name" }, "Shown"), h("span", { className: "cut" }, " "), bar(length(shown), "Shown")) : null;
    return h("div", { className: `stage ${run.group}`, key: at }, h("h3", null, h("span", { className: "num" }, at + 1), " ", GROUPS[run.group]), h("div", { className: "path" }, begin, nodes, end), h("p", { className: "small" }, says(run)));
  });
  if (focus && found === null) {
    const result = response.results.find((entry) => entry.game_id === focus);
    if (result) found = h("p", { className: "callout green", "data-focus": "" }, h("span", null, label("green", "shown"), " ", h("strong", null, result.title), ` passes every step here and is shown at rank ${result.rank}.`));
  }
  const before = runs[0]?.group === "eligible" ? runs[0].steps.reduce((sum, { step }) => sum + step.removed.length, 0) : null;
  return section(
    "removed",
    left,
    inspection(data),
    h("p", { className: "lede", "data-answer": "" }, `Of the ${plural(start, "game", "games")} in the catalogue, ${shown === 0 ? "none is shown" : `${count(shown)} ${shown === 1 ? "is" : "are"} shown`}.`, before === null ? "" : ` ${plural(before, "was", "were")} removed by rules before anything was scored.`, " Open a step to see what it removed."),
    found,
    // One step is open at a time. A game an address points at opens the step that removed it.
    h(Accordion, { className: "stages", defaultValue: open, collapsible: true, key: `${response.request.game_id} ${response.request.brand} ${response.served.version} ${focus ?? ""}`, "aria-label": "The steps from the catalogue to the result" }, stages),
    more([trace.scores.length > 0 ? offer("scores") : null, offer("provenance")]),
  );
}

// ---------------------------------------------------------------------------
// 4 · Worth it
// ---------------------------------------------------------------------------

/** The limits of the evaluation, as its plan states them. */
export const LIMITS =
  "The catalogue is fictional and easier than real supplier data. Its answer key is the generator's own plan, its text was written by the same model that does the enrichment, and the reviewer of disputed cases is a model from the same vendor, so the three can share blind spots. These numbers show direction and the absence of glaring failure, not production accuracy.";

export function Worth({ data, evaluation, example }: SectionProps): ReactNode {
  const { response, versions } = data;
  const left = question(
    4,
    "The model costs money. Does it rank related games better than plain code, and by how much?",
    "The model is paid for on every rebuild. So every version of the index is measured against the same answer key, and the simplest one that is good enough is the one served.",
    example,
    "worth",
  );
  if (evaluation === undefined) return section("worth", left, h("p", { "data-answer": "", "data-first": "" }, "Loading"));
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
    let against: ReactNode = null;
    if (other !== undefined && otherRow !== undefined && typeof mine === "number" && typeof theirs === "number") {
      const points = Math.abs((mine - theirs) * 100).toFixed(1);
      const gap = mine === theirs ? "the same" : `${points} points ${mine > theirs ? "fewer" : "more"}`;
      against = h(Fragment, null, ` The best version built ${usesModel ? "without" : "with"} the model, `, h("strong", null, versionName(other)), `, ranks ${pct(theirs)}: ${gap}. Estimated cost of a build: ${estimate(servedRow.cost.estimated_usd)} against ${estimate(otherRow.cost.estimated_usd)}.`);
    }
    sentence = h(Fragment, null, label("green", "served"), " ", h("strong", null, versionName(served)), `, built ${usesModel ? `with ${plural(servedRow.cost.model_calls, "model call", "model calls")}` : "without the model"}, ranks ${pct(mine)} of the test pairs in the right order.`, against);
  }
  const dearest = Math.max(...names.map((version) => report.matching[version].cost.estimated_usd));
  const rows = names.map((version, index) => {
    const entry = report.matching[version];
    const failed = report.decision.versions[version]?.passed === false;
    return h(
      "tr",
      { key: version, className: version === served ? "served" : undefined, ...(index === 0 ? { "data-first": "" } : {}) },
      h("th", { scope: "row" }, versionName(version), " ", version === served ? label("green", "served") : null, " ", entry.cost.model_calls === 0 ? label("neutral", "no model") : label("blue", "model"), failed ? h(Fragment, null, " ", label("red", "fails a pass mark")) : null),
      h("td", { className: "num" }, pct(entry.pairwise.pooled.rate), bar(entry.pairwise.pooled.rate ?? 0, `${versionName(version)}: ranked right`)),
      h("td", { className: "num" }, estimate(entry.cost.estimated_usd), bar(dearest > 0 ? entry.cost.estimated_usd / dearest : 0, `${versionName(version)}: estimated cost`, { tone: "blue" })),
    );
  });
  const mine = response.results.map((entry) => entry.game_id);
  const lines = Object.keys(versions)
    .filter((version) => version !== response.served.version)
    .map((version) => {
      const other = versions[version];
      if (other === undefined) return null;
      const calls = row(version)?.cost.model_calls;
      return h("li", { key: version }, h("span", null, versionName(version), " ", calls === undefined ? null : calls === 0 ? label("neutral", "no model") : label("blue", "model")), h("span", { className: "num" }, overlap(mine, other)));
    });
  const title = response.trace?.anchor?.title ?? response.request.game_id;
  return section(
    "worth",
    left,
    h("p", { className: "lede", "data-answer": "" }, sentence),
    h(
      "table",
      { className: "mini-race", "data-measured": "" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Version of the index"), h("th", { scope: "col", className: "num" }, "Ranked right"), h("th", { scope: "col", className: "num" }, "Estimated cost to build"))),
      h("tbody", null, rows),
    ),
    h("p", { className: "small" }, "Ranked right: how often a game the answer key calls related scores above one it calls unrelated, over every game of this fictional catalogue. It shows direction, not how real players would judge a list. Costs are estimates from the calls each build made."),
    h("h3", null, "For ", h("em", null, title), ` on ${response.request.brand}, against ${versionName(response.served.version)}`),
    h("ul", { className: "others", "data-others": "" }, lines),
    h("p", { className: "small" }, "A different list is not a better list. Whether a version's lists are better is what the numbers above measure, over every game."),
    h("p", { className: "callout", "data-limits": "" }, h("span", null, label("neutral", "what this does not show"), " ", LIMITS)),
    more([offer("verdict"), offer("what-if"), offer("versions"), offer("numbers"), offer("enrichment-measures"), offer("gallery")]),
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
