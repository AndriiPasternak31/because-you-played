/**
 * The evidence behind each answer: true, and out of sight until its button is pressed.
 *
 * Every piece is a plain function from the service's responses to React elements, drawn inside the
 * page's drawer. The page shows one piece at a time, under the name its button carries.
 */
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "@ui-sdk/react/accordion";
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/react/slider";
import { createElement as h, Fragment, type ReactNode } from "react";
import type { TraceAnchor } from "../service/recommend.ts";
import { count, overlap, pct, plural, versionName, words, type Answer, type Evaluation, type Failure, type Loaded, type WhatIf } from "./read.ts";
import { LIMITS, RANKED_RIGHT, absent, bar, label, mono, small, tag, type EvidenceId } from "./view.ts";

const quote = (text: string): ReactNode => h("span", { className: "quote" }, `“${text}”`);
const scroll = (table: ReactNode, name: string): ReactNode => h("div", { className: "scroll", tabIndex: 0, role: "region", "aria-label": name }, table);
const head = (...cells: ReactNode[]): ReactNode => h("thead", null, h("tr", null, ...cells));
const th = (text: ReactNode, numeric = false): ReactNode => h("th", { scope: "col", className: numeric ? "num" : undefined }, text);
type Rate = { count: number; of: number; rate: number | null };
const share = (value: Rate): ReactNode => (value.rate === null ? `none of ${count(value.of)}` : h(Fragment, null, pct(value.rate), small(`${count(value.count)} of ${count(value.of)}`)));
const passLabel = (ok: boolean): ReactNode => (ok ? label("green", "pass") : label("red", "fail"));

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

function Scores({ response }: { response: Answer }): ReactNode {
  const trace = response.trace;
  if (trace === undefined || trace.scores.length === 0) return h("p", null, "No candidate was scored for this request.");
  const floorRow = h("tr", { className: "floor", key: "floor" }, h("td", { colSpan: 4 }, label("neutral", "similarity floor"), " ", h("span", { className: "num" }, trace.floor), " ", small(trace.floor_rule)));
  let drawn = false;
  const rows: ReactNode[] = [];
  for (const entry of trace.scores) {
    const below = entry.score < trace.floor;
    if (below && !drawn) {
      rows.push(floorRow);
      drawn = true;
    }
    rows.push(
      h("tr", { key: entry.game_id, className: below ? "below" : undefined }, h("td", { className: "num" }, entry.rank), h("td", null, entry.title, " ", small(mono(entry.game_id), " · ", entry.provider)), h("td", { className: "num" }, entry.score), h("td", { className: "barcell" }, bar(entry.score, `${entry.title}: score`, { at: trace.floor, ...(below ? { tone: "quiet" as const } : {}) }))),
    );
  }
  if (!drawn) rows.push(floorRow);
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, `Each of the ${plural(trace.scores.length, "candidate", "candidates")} that was scored, with its similarity to the game played. The tick on each bar is the similarity floor: a score under it is never shown to a player.`),
    scroll(h("table", { className: "scores" }, head(th("Rank", true), th("Game"), th("Score", true), th("From 0 to 1")), h("tbody", null, rows)), "Scores of every candidate"),
  );
}

function Provenance({ response }: { response: Answer }): ReactNode {
  const timings = response.trace ? Object.entries(response.trace.timings_ms).map(([stage, ms]) => `${words(stage)} ${ms} ms`) : [];
  return h(
    "dl",
    { className: "raw" },
    h("dt", null, "index"),
    h("dd", null, mono(response.served.index_hash)),
    h("dt", null, "version"),
    h("dd", null, mono(response.served.version)),
    h("dt", null, "game"),
    h("dd", null, mono(response.request.game_id)),
    h("dt", null, "brand"),
    h("dd", null, mono(response.request.brand)),
    response.trace ? h(Fragment, null, h("dt", null, "floor"), h("dd", null, response.trace.floor, " ", small(response.trace.floor_rule))) : null,
    h("dt", null, "timings"),
    h("dd", null, timings.length === 0 ? "none recorded" : timings.join(" · ")),
  );
}

function RawRecord({ anchor }: { anchor: TraceAnchor }): ReactNode {
  const d = anchor.delivered;
  const rows: [string, unknown][] = [["title", d.title], ["provider", d.provider], ["category", d.category], ["description", d.description], ["features", d.features], ["themes", d.themes], ["tags", d.tags], ...Object.entries(d.facts)];
  const status = anchor.status_on_brand === "live" ? label("green", "live on this brand") : label("amber", `${words(anchor.status_on_brand)} on this brand`);
  return h(Fragment, null, h("p", { className: "lede" }, "Source row ", mono(d.source_record_id), ". ", status), h("dl", { className: "raw" }, rows.map(([key, value]) => h(Fragment, { key }, h("dt", null, key), h("dd", null, absent(value))))));
}

type TraceLabel = TraceAnchor["steps"]["table"]["themes"][number];

function evidenceList(labels: readonly TraceLabel[], caption: string): ReactNode {
  if (labels.length === 0) return h("p", { className: "small" }, `${caption}: nothing.`);
  return h(
    Fragment,
    null,
    h("p", { className: "small" }, caption),
    h(
      "ul",
      { className: "evidence" },
      labels.map((entry, index) => {
        const made = entry as TraceLabel & { model?: string | null; prompt_version?: string | null };
        return h("li", { key: index }, tag(entry.method, entry.label), quote(entry.quote), small("in ", mono(entry.source_field), " · ", entry.method === "model" ? `model ${made.model ?? ""}, prompt ${made.prompt_version ?? ""}` : "synonym table"));
      }),
    ),
  );
}

function conflictNote(conflict: NonNullable<TraceAnchor["steps"]["conflict"]>): ReactNode {
  const handled = conflict.model_reading_used ? "The two model versions carry the model's reading of the description and title instead." : "The model gave no reading from the description or title, so the field stays empty in every version.";
  const withheld = conflict.model_labels_withheld ?? [];
  return h(
    "div",
    { className: "callout amber", "data-conflict": "" },
    h("p", null, label("amber", "conflicting"), " A delivered tag and the description disagree."),
    h(
      "div",
      { className: "versus" },
      h("p", { className: "side" }, h("span", { className: "kicker" }, "The tag"), " ", h("span", null, mono(conflict.tag), " asserts ", h("strong", null, words(conflict.tag_asserts)))),
      h("span", { className: "ne", "aria-hidden": "true" }, "≠"),
      h("p", { className: "side" }, h("span", { className: "kicker" }, "The description"), " ", h("span", null, quote(conflict.description_quote), " states ", h("strong", null, conflict.description_states.map(words).join(", ")))),
    ),
    h("p", null, h("strong", null, "Table."), " A lookup cannot tell which is right, so the table version asserts no mechanic."),
    h("p", null, h("strong", null, "Model."), " ", handled, withheld.length === 0 ? null : h(Fragment, null, " Model labels not used, because they were backed by the disputed tag list: ", withheld.map((entry, index) => h(Fragment, { key: index }, index === 0 ? "" : ", ", words(entry.label), " (", mono(entry.quote), ")")), ".")),
  );
}

/** Every step of enrichment for this record, with the model and prompt behind each of the model's labels. */
function Steps({ anchor, version }: { anchor: TraceAnchor; version: string }): ReactNode {
  const { table, model, conflict, cleaned } = anchor.steps;
  const step = (kind: string, number: number, name: string, who: ReactNode, ...body: ReactNode[]): ReactNode => h("li", { className: kind, key: number }, h("div", { className: "sh" }, h("span", { className: "n" }, `Step ${number}`), h("h4", null, name), who), ...body);
  const fieldLine = (name: string, field: NonNullable<TraceAnchor["fields"]>["themes"]): ReactNode => {
    if (field.status === "asserted") return h("li", null, h("strong", null, name), " ", field.labels.map((entry, index) => h(Fragment, { key: index }, tag(entry.method, entry.label), " ")));
    const why = field.status === "conflict" ? `conflicting: ${words(field.conflict_reason ?? "")}. No label is asserted.` : "abstained: nothing in the record supports a label.";
    return h("li", null, h("strong", null, name), " ", label("amber", field.status === "conflict" ? "conflicting" : "abstained"), " ", small(why));
  };
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, "Who did what to this record, with the model and the prompt behind each of the model's labels."),
    h(
      "ol",
      { className: "steps" },
      step("code", 1, "Cleaning", label("neutral", "code only"), h("p", { className: "small" }, `Title: ${cleaned.title}. Description: ${cleaned.description === null ? "none delivered" : "kept word for word, with any markup removed"}.`)),
      step(
        "code",
        2,
        "Synonym table",
        label("neutral", "a lookup, no model"),
        evidenceList([...table.themes, ...table.mechanics], "Labels the table found in the delivered tags"),
        table.dropped.length === 0 ? null : h("p", { className: "small" }, "Dropped as not an attribute of the game: ", table.dropped.map((entry, index) => h(Fragment, { key: index }, index === 0 ? "" : ", ", mono(entry.tag), ` (${words(entry.reason)})`)), "."),
        table.unknown.length === 0 ? null : h("p", { className: "small" }, "Unknown to the table, and not guessed: ", table.unknown.map((entry, index) => h(Fragment, { key: index }, index === 0 ? "" : ", ", mono(entry.tag))), "."),
        conflict === null ? null : conflictNote(conflict),
      ),
      step("code", 3, "Thin rule", label("neutral", "a rule"), h("p", null, anchor.thin ? h(Fragment, null, label("amber", "thin"), " The table left this record without a usable label for its themes or its mechanics.") : "The table found labels for both fields, so the record is not thin.")),
      step(
        "model",
        4,
        "Model",
        label("blue", "asked offline"),
        h("p", null, model.used ? label("blue", "used in this version") : label("neutral", "not used in this version"), " ", small("The model was asked once for this record, offline, and its answer is stored. No model is called when a request arrives.")),
        evidenceList([...model.themes, ...model.mechanics], "Labels the model asserted, each with the words it copied from the record"),
        model.stripped.length === 0 ? null : h("p", { className: "small" }, "Stripped from the model's answer: ", model.stripped.map((entry) => `${entry.label} (${words(entry.reason)})`).join(", "), "."),
      ),
      h(
        "li",
        { className: "holds", key: "holds" },
        h("div", { className: "sh" }, h("h4", null, `What ${versionName(version)} holds for this record`)),
        anchor.fields === null ? h("p", null, label("neutral", "no labels"), ` ${versionName(version)} embeds the delivered text as it is and asserts no label.`) : h("ul", { className: "fields" }, fieldLine("Themes", anchor.fields.themes), fieldLine("Mechanics", anchor.fields.mechanics)),
        h("p", { className: "small" }, "The text that was embedded:"),
        h("pre", null, anchor.text),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The same request in every version
// ---------------------------------------------------------------------------

export interface CompareProps {
  /** Every version's answer to the request on screen. */
  versions: Record<string, Answer>;
  /** The version the service serves. */
  served: string;
  /** The version the page is showing, whose list the others are counted against. */
  shown: string;
  evaluation?: Evaluation | undefined;
  /** The control that puts another version on the page, supplied by the page. */
  picker?: ReactNode;
}

export function Compare({ versions: responses, served, shown, evaluation, picker }: CompareProps): ReactNode {
  const versions = Object.keys(responses);
  const of = (version: string): Answer => responses[version] as Answer;
  // How each other version's list compares with the list the page shows, counted from the service's answers.
  const mine = (responses[shown]?.results ?? []).map((entry) => entry.game_id);
  const lines = versions
    .filter((version) => version !== shown)
    .map((version) => {
      const calls = (evaluation?.report.matching as Record<string, { cost: { model_calls: number } } | undefined> | undefined)?.[version]?.cost.model_calls;
      return h("li", { key: version }, h("span", null, versionName(version), " ", calls === undefined ? null : small(calls === 0 ? "no model" : "model")), h("span", { className: "num" }, overlap(mine, of(version))));
    });
  const games = new Map<string, Answer["results"][number]>();
  for (const version of versions) for (const entry of of(version).results) if (!games.has(entry.game_id)) games.set(entry.game_id, entry);
  const matrix =
    games.size === 0
      ? h("p", null, label("amber", "no results"), " No version would return anything for this game on this brand.")
      : h(
          Fragment,
          null,
          h("h3", null, "Which version returns which game"),
          h("p", { className: "small" }, "One row per game any version would return. The number is the rank that version gives it."),
          scroll(
            h(
              "table",
              { className: "matrix" },
              head(th("Game"), ...versions.map((version) => h("th", { scope: "col", key: version }, versionName(version), of(version).outcome === "declined" ? h(Fragment, null, h("br"), label("amber", "declined")) : version === served ? h(Fragment, null, h("br"), label("green", "served")) : null))),
              h(
                "tbody",
                null,
                [...games.values()].map((entry) =>
                  h(
                    "tr",
                    { className: "game", key: entry.game_id },
                    h("th", { scope: "row" }, entry.title),
                    versions.map((version) => {
                      const hit = of(version).results.find((result) => result.game_id === entry.game_id);
                      return hit
                        ? h("td", { className: "hit", key: version }, h("b", { className: "num" }, h("span", { className: "sr" }, "rank "), hit.rank), h("span", { className: "num small" }, hit.score))
                        : h("td", { className: "miss", key: version }, h("span", { "aria-hidden": "true" }, "–"), h("span", { className: "sr" }, "not returned"));
                    }),
                  ),
                ),
              ),
            ),
            "Which version returns which game",
          ),
        );
  const cell = (response: Answer, row: "outcome" | "themes" | "mechanics" | "results"): ReactNode => {
    const anchor = response.trace?.anchor;
    if (row === "outcome") return response.outcome === "declined" ? h(Fragment, null, label("amber", "declined"), " ", mono(response.decline?.reason)) : label("green", plural(response.results.length, "result", "results"));
    if (row === "results") return response.results.length === 0 ? h("span", { className: "absent" }, "none") : h("ol", null, response.results.map((entry) => h("li", { key: entry.game_id }, entry.title, " ", h("span", { className: "num small" }, entry.score))));
    if (!anchor) return h("span", { className: "absent" }, "-");
    if (anchor.fields === null) return h("span", { className: "absent" }, "no labels in this version");
    const field = anchor.fields[row];
    if (field.status !== "asserted") return label("amber", field.status === "conflict" ? "conflicting" : "abstained");
    return field.labels.map((entry, index) => h("div", { key: index }, tag(entry.method, entry.label), " ", h("span", { className: "quote small" }, `“${entry.quote}”`)));
  };
  const rows = (["outcome", "themes", "mechanics", "results"] as const).map((row) => h("tr", { key: row, "data-row": row }, h("th", { scope: "row" }, row[0]?.toUpperCase(), row.slice(1)), versions.map((version) => h("td", { key: version }, cell(of(version), row)))));
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, "What each version would return for the chosen game on the chosen brand, and the labels it holds. Only the served version answers players."),
    picker ? h("div", { className: "version-picker" }, picker) : null,
    h("h3", null, `Against the list of ${versionName(shown)}`),
    h("ul", { className: "others", "data-others": "" }, lines),
    h("p", { className: "small" }, "A different list is not a better list. Whether a version's lists are better is what the evaluation measures, over every game."),
    matrix,
    h("h3", null, "What each version holds, and returns"),
    h("p", { className: "small" }, "Each label keeps the words it was read from. ", tag("model", "blue"), " came from the model, ", tag("table", "plain"), " from the synonym table."),
    scroll(h("table", { className: "compare" }, head(h("th", null), ...versions.map((version) => h("th", { scope: "col", key: version }, versionName(version), version === served ? h(Fragment, null, " ", label("green", "served")) : null, small(`floor ${of(version).trace?.floor ?? ""}`)))), h("tbody", null, rows)), "What each version holds, and returns"),
  );
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

const versionHeads = (list: readonly string[], served: string | null): ReactNode[] => list.map((version) => h("th", { scope: "col", className: "num", key: version }, versionName(version), version === served ? h(Fragment, null, h("br"), label("green", "served")) : null));

/** The gate's verdict in its own words, and every pass mark as pass or fail for every version. */
function Verdict({ evaluation }: { evaluation: Evaluation }): ReactNode {
  const { report, verdict } = evaluation;
  const versions = Object.keys(report.matching) as (keyof typeof report.matching)[];
  const served = verdict.ships;
  const thresholds = evaluation.thresholds as unknown as Record<string, Record<string, number | undefined> | undefined>;
  const markRows = evaluation.marks.map((mark) =>
    h(
      "tr",
      { key: mark.id },
      h("th", { scope: "row" }, mark.label, small(`${mark.direction === "min" ? "at least" : "at most"} ${thresholds[mark.group]?.[mark.key] ?? ""}`)),
      versions.map((version) => {
        const result = report.decision.versions[version].marks.find((entry) => entry.mark === mark.id);
        if (result === undefined) return h("td", { className: "num", key: version }, "–");
        if (!result.applies) return h("td", { className: "num", key: version }, label("neutral", "does not apply"));
        return h("td", { className: "num", key: version }, passLabel(result.pass), small(`measured ${result.measured === null ? "nothing" : result.measured}`));
      }),
    ),
  );
  return h(
    Fragment,
    null,
    h(
      "div",
      { className: `verdict${served === null ? " failed" : ""}` },
      h("p", { className: "ships" }, h("span", { className: "big" }, served === null ? "Nothing is served" : versionName(served)), " ", served === null ? label("red", "not serving") : label("green", "served")),
      h("p", { className: "small" }, "In the release gate's own words: ", verdict.reason),
      h("p", { className: "small" }, label(report.owner_check.status === "answered" ? "green" : "amber", `owner's check ${report.owner_check.status}`), " ", report.owner_check.note),
    ),
    h("h3", null, "The pass marks, version by version"),
    h("p", { className: "small" }, "The marks the release gate applies, as committed in ", mono(evaluation.thresholds_file), evaluation.thresholds.decided_on ? ` (decided ${evaluation.thresholds.decided_on})` : "", ", and what each version measured."),
    scroll(h("table", { className: "measures", id: "pass-marks" }, head(th("Pass mark"), ...versionHeads(versions, served)), h("tbody", null, markRows)), "The pass marks, version by version"),
  );
}

/** Every measured number, and pairwise accuracy by the condition of the record that was asked about. */
function Numbers({ evaluation }: { evaluation: Evaluation }): ReactNode {
  const { report, verdict } = evaluation;
  const versions = Object.keys(report.matching) as (keyof typeof report.matching)[];
  const detailRows = versions.map((version) => {
    const row = report.matching[version];
    return h(
      "tr",
      { key: version },
      h("th", { scope: "row" }, versionName(version)),
      h("td", { className: "num" }, share(row.pairwise.pooled)),
      h("td", { className: "num" }, pct(row.pairwise.per_game.mean), small(`${count(row.pairwise.per_game.games)} games`)),
      h("td", { className: "num" }, count(row.wrongly_shown.count), small(`of ${count(row.wrongly_shown.results_judged)} judged`)),
      h("td", { className: "num" }, count(row.cost.model_calls)),
      h("td", { className: "num" }, `$${row.cost.estimated_usd}`),
      h("td", { className: "num" }, `${row.cost.seconds.toFixed(1)} s`),
    );
  });
  const conditions = [["by_condition", "description", "Has a description"], ["by_condition", "tags_only", "Tags only"], ["by_condition", "none", "Nearly empty"], ["by_thin", "thin", "Thin"], ["by_thin", "not_thin", "Not thin"]] as const;
  const splitRows = conditions.map(([group, key, name]) =>
    h(
      "tr",
      { key },
      h("th", { scope: "row" }, name),
      versions.map((version) => {
        const cell = (report.matching[version][group] as Record<string, { per_game: { mean: number | null; games: number } }>)[key]?.per_game;
        return h("td", { className: "num", key: version }, pct(cell?.mean), cell?.mean === null || cell?.mean === undefined ? null : bar(cell.mean, `${versionName(version)}, ${name}`), small(`${count(cell?.games ?? 0)} games`));
      }),
    ),
  );
  // Which versions call the model for only some records: on the other rows a gap is not the model reading those records.
  const partial = versions.filter((version) => report.matching[version].cost.model_calls > 0 && report.matching[version].cost.model_calls < report.games);
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, "Counts beside every rate. Verdict for index ", mono(verdict.index_hash.slice(0, 12)), "."),
    scroll(h("table", null, head(th("Version"), th("Pairs in the right order", true), th("Mean per game", true), th("Wrongly shown", true), th("Model calls", true), th("Estimated cost, USD", true), th("Call time", true)), h("tbody", null, detailRows)), "Every measured number"),
    h("p", { className: "small" }, RANKED_RIGHT, " It shows direction, not how real players would judge a list."),
    h("p", { className: "small" }, `Check games on ${report.check_games.brand}: `, report.check_games.games.map((game, index) => h(Fragment, { key: game }, index === 0 ? "" : " ", mono(game))), ". A result is wrongly shown when the rule calls it unrelated and the reviewer also says no. A cost is an estimate from the calls a build made, not a bill."),
    h("h3", null, "Ranked right, by the condition of the record that was asked about"),
    h("p", { className: "small" }, "Pairwise accuracy, mean per game, split by what the record that was asked about had to offer."),
    scroll(h("table", { className: "by-condition" }, head(th("Record"), ...versionHeads(versions, verdict.ships)), h("tbody", null, splitRows)), "Ranked right, by record condition"),
    h(
      "p",
      { className: "callout", "data-attribution": "" },
      h(
        "span",
        null,
        label("neutral", "how not to read this"),
        " ",
        partial.map((version) => `${versionName(version)} called the model for ${count(report.matching[version].cost.model_calls)} of the ${count(report.games)} records. `).join(""),
        "A row is the kind of record that was asked about, and its rank depends on the text of every game it is compared with. So a version can differ on a row whose records the model never read, and a gap on a row is not evidence that the model read those records well.",
      ),
    ),
  );
}

type Shown = Evaluation["report"]["disagreements"]["list"][number]["reviewer"];

function reviewerSays(reviewer: Shown | null | undefined): ReactNode {
  if (reviewer === null || reviewer === undefined) return null;
  if (typeof reviewer === "string") return small(words(reviewer));
  const said = reviewer as { answer: string; said?: string | null; note?: string | null; words?: string | null };
  return h(Fragment, null, "reviewer: ", label("neutral", said.answer), said.note ? h(Fragment, null, " ", small(`(${words(said.note)}: it said ${said.said})`)) : null, said.words ? h(Fragment, null, " ", h("span", { className: "quote small" }, `“${said.words}”`)) : null);
}

/** What the owner's check came to once he has answered, and how little it can carry. Every number is the report's. */
export function ownerCheckReading(check: Evaluation["report"]["owner_check"]): string {
  const apart =
    check.not_blind.of === 0
      ? ""
      : ` Counted apart, because he had been told the reviewer's answer before he answered: ${check.not_blind.of}, of which the reviewer matched ${check.not_blind.matched}.`;
  const fromControl = check.from_control === 0 ? "" : `, ${check.from_control} of them from the control sample, where the answer key and the pipeline already agreed`;
  return (
    `Of the ${check.blind.of} answers the owner gave blind, the reviewer matched ${check.blind.matched}.${apart} ` +
    `This is thin evidence: ${check.of} questions${fromControl}. It could have caught a reviewer that misreads plain cases; it cannot show that the reviewer is right where a label is disputed. ` +
    "Until he answered, the reviewer's answers to these questions were kept out of the working tree but stayed in the repository's history, so that his answers were blind rests on his not having looked."
  );
}

function Measures({ evaluation }: { evaluation: Evaluation }): ReactNode {
  const { report, verdict } = evaluation;
  const labelled = Object.keys(report.enrichment) as (keyof typeof report.enrichment)[];
  type Row = (typeof report.enrichment)[keyof typeof report.enrichment];
  const of = (value: { count: number; of: number }): ReactNode => h(Fragment, null, count(value.count), " ", small(`of ${count(value.of)}`));
  const precision = (row: Row): ReactNode => {
    const { held_back: held, unclear, unknowable } = row.precision.left_out;
    // Every asserted label is accounted for: the ones precision leaves out are said beside it.
    const leftOut = [unclear === 0 ? null : `${unclear} the reviewer left unclear`, unknowable === 0 ? null : `${unknowable} the answer key calls unknowable`].filter((part) => part !== null);
    return h(
      Fragment,
      null,
      share(row.precision),
      leftOut.length === 0 ? null : small(`left out: ${leftOut.join(", ")}`),
      held === 0 ? null : small(`${held} held back; counted as wrong for the pass mark: ${row.precision.gate.count} of ${row.precision.gate.of}`),
    );
  };
  const measures: [string, string, (row: Row) => ReactNode][] = [
    ["Precision", "Of the labels asserted, the share that are correct", precision],
    ["Recovery", "Of the labels the record's own words support, the share asserted", (row) => share(row.recovery)],
    ["Recovery without tags", "The same, where the evidence is only in the description or the title", (row) => share(row.recovery_without_tags)],
    ["Missed abstentions", "Fields where nothing should be asserted and something was", (row) => of(row.missed_abstentions)],
    ["Invalid quotes", "Labels whose quote is not in the record word for word", (row) => of(row.invalid_quotes)],
    ["Recoverable labels not asserted", "Labels the record supports that the version left out", (row) => h(Fragment, null, count(row.missed.not_asserted), " ", small(`+ ${count(row.missed.conflict_rule)} on a field left empty by a tag conflict`))],
  ];
  const control = report.control;
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, "Counts beside every rate. Raw text asserts no labels, so these measures do not apply to it."),
    scroll(
      h("table", { className: "measures" }, head(th("Measure"), ...versionHeads(labelled, verdict.ships)), h("tbody", null, measures.map(([name, means, value]) => h("tr", { key: name }, h("th", { scope: "row" }, name, small(means)), labelled.map((version) => h("td", { className: "num", key: version }, value(report.enrichment[version]))))))),
      "Label measures",
    ),
    h("h3", null, `Where a tag contradicts the description: ${plural(report.conflict_games.games.length, "game", "games")}`),
    h("p", { className: "small" }, report.conflict_games.note),
    scroll(
      h(
        "table",
        null,
        head(th("Game"), th("The tag says"), th("The description says"), ...labelled.map((version) => h("th", { scope: "col", key: version }, versionName(version)))),
        h(
          "tbody",
          null,
          report.conflict_games.games.map((entry) =>
            h(
              "tr",
              { key: entry.game_id },
              h("td", null, entry.title),
              h("td", null, mono(entry.tag)),
              h("td", null, entry.description_states.map(words).join(", ")),
              labelled.map((version) => {
                const field = entry.mechanics[version];
                return h("td", { key: version }, field.status === "asserted" ? field.labels.map((term, index) => h(Fragment, { key: index }, tag(version === "table" ? "synonym_table" : "model", term), " ")) : label("amber", field.status === "conflict" ? "conflicting" : field.status));
              }),
            ),
          ),
        ),
      ),
      "Games where a tag contradicts the description",
    ),
    h("h3", null, `Disagreements with the plan: ${report.disagreements.count}`),
    h(
      "ul",
      { className: "plain" },
      report.disagreements.list.map((entry, index) => {
        const item = entry as unknown as { title: string; label: string; plan: string; asserted_by: { version: string; quote: string }[]; reviewer: Shown };
        return h("li", { key: index }, item.title, ": ", tag("model", item.label), ` is ${words(item.plan)} in the plan; asserted by ${item.asserted_by.map((by) => versionName(by.version)).join(", ")} from `, quote(item.asserted_by[0]?.quote ?? ""), ". ", reviewerSays(item.reviewer));
      }),
    ),
    h("h3", null, "The reviewer, ", mono(report.reviewer.model)),
    h(
      "p",
      null,
      `Control: it agreed with the plan on ${control.agreed} of ${control.reported} labels where the plan and the pipeline agree (${control.applies.agreed} of ${control.applies.of} where the label applies, ${control.does_not_apply.agreed} of ${control.does_not_apply.of} where it does not). Of ${report.reviewer.answered} answers: ${report.reviewer.answers.yes} yes, ${report.reviewer.answers.no} no, ${report.reviewer.answers.unclear} unclear.`,
    ),
    report.reviewer.held_back === 0
      ? null
      : h(
          "p",
          { "data-held-back": "" },
          label("amber", "held back"),
          ` ${report.reviewer.held_back} of the reviewer's ${report.reviewer.questions} answers are to the owner's check questions (${control.held_back} of the ${control.size} control labels among them). Until the owner has answered, they are kept out of the working tree and out of every count on this page, and the page shows none of them. They are not out of reach: the repository's history still holds them, so the check rests on the owner not looking before he answers.`,
        ),
    report.owner_check.questions.length === 0
      ? null
      : scroll(
          h(
            "table",
            null,
            h("caption", null, "The owner's check"),
            head(th("Question"), th("From"), th("Owner"), th("Reviewer"), th("Match"), th("Answered blind")),
            h("tbody", null, report.owner_check.questions.map((entry) => h("tr", { key: entry.question_id }, h("td", null, mono(entry.question_id)), h("td", null, entry.source), h("td", null, entry.owner), h("td", null, entry.reviewer), h("td", null, entry.matched ? label("green", "match") : label("amber", "differs")), h("td", null, entry.blind ? "yes" : label("amber", "no: told the reviewer's answer first"))))),
          ),
          "The owner's check",
        ),
    report.owner_check.questions.length === 0 ? null : h("p", { className: "small", "data-owner-check": "" }, ownerCheckReading(report.owner_check)),
    report.reviewer.unclear.length === 0 ? null : h("p", { className: "small" }, "Recorded as unclear: ", report.reviewer.unclear.map((entry, index) => h(Fragment, { key: index }, index === 0 ? "" : ", ", mono(entry.question_id), ` (${words(entry.note ?? "it said unclear")})`)), "."),
  );
}

function galleryList(entries: readonly Failure[]): ReactNode {
  return entries.map((entry, index) =>
    h(
      "details",
      { key: index },
      h("summary", null, mono(entry.kind), " · ", entry.title, entry.version ? h(Fragment, null, " ", small(`in ${versionName(entry.version)}`)) : null),
      h("p", null, entry.what),
      h("dl", { className: "detail" }, Object.entries(entry.detail).map(([key, value]) => h(Fragment, { key }, h("dt", null, words(key)), h("dd", null, key === "reviewer" ? reviewerSays(value as Shown) : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value))))),
    ),
  );
}

function Gallery({ evaluation }: { evaluation: Evaluation }): ReactNode {
  const { gallery } = evaluation.report;
  return h(
    Fragment,
    null,
    h("p", { className: "lede" }, "Real failures the evaluation found in the system's own output, and, listed apart, the mess that was planted in the catalogue on purpose."),
    h("div", { className: "gallery" }, h("h3", null, `Real failures: ${gallery.real.length}`), galleryList(gallery.real)),
    h("div", { className: "gallery" }, h("h3", null, `Planted on purpose: ${gallery.injected.length}`), galleryList(gallery.injected)),
  );
}

// ---------------------------------------------------------------------------
// What-if: other pass marks against the measured numbers
// ---------------------------------------------------------------------------

const RANGES = { rate: { min: 0, max: 1, step: 0.01 }, count: { min: 0, max: 10, step: 1 }, margin: { min: 0, max: 0.2, step: 0.005 } };

export interface WhatIfProps {
  evaluation: Evaluation;
  whatIf: WhatIf;
  /** Called with a mark's key (or "margin") and its new value when a slider comes to rest. */
  onMove?: (key: string, value: number) => void;
  onReset?: () => void;
  /** Counts the returns to the committed marks: the sliders are put back when it changes. */
  round?: number;
}

/** The sliders. `whatIf.marks` are the marks now set, `whatIf.committed` the marks in the owner's file, `whatIf.decision` the gate's answer for the marks now set. */
export function WhatIfView({ evaluation, whatIf, onMove, onReset, round = 0 }: WhatIfProps): ReactNode {
  const { committed, marks: set, decision } = whatIf;
  const versions = Object.keys(decision.versions) as (keyof typeof decision.versions)[];
  const perVersion = (cell: (version: keyof typeof decision.versions) => ReactNode): ReactNode => h("ul", { className: "per-version" }, versions.map((version) => h("li", { key: version }, small(versionName(version)), cell(version))));
  const markRow = (id: string, bound: string, name: string, range: { min: number; max: number; step: number }, value: number, committedValue: number, results: ReactNode): ReactNode => {
    const at = (committedValue - range.min) / (range.max - range.min);
    const moved = value !== committedValue;
    return h(
      "div",
      { className: `mark${moved ? " moved" : ""}`, key: id, "data-mark": id },
      h(
        "div",
        null,
        h("div", { className: "mh" }, h("span", { className: "name", id: `mark-${id}-name` }, name), small(bound, " ", h("output", null, value), moved ? h(Fragment, null, " ", label("amber", "moved")) : null)),
        h(
          "div",
          { className: "slider" },
          // The slider keeps its own position, and so its focus, while the panel is drawn again from the service's answer.
          h(
            Slider,
            { key: `${id} ${round}`, defaultValue: value, min: range.min, max: range.max, step: range.step, name: id, onValueCommit: (next: number | number[]) => onMove?.(id, Array.isArray(next) ? (next[0] ?? value) : next) },
            h(SliderControl, { className: "control" }, h(SliderTrack, { className: "rail" }, h(SliderIndicator, { className: "range" }), h(SliderThumb, { className: "thumb", "aria-labelledby": `mark-${id}-name` }))),
          ),
          h("span", { className: "tick", style: { "--at": at.toFixed(4) } as Record<string, string>, title: "committed mark" }),
          h("div", { className: "small" }, `committed: ${committedValue}`),
        ),
      ),
      results,
    );
  };
  const rows = evaluation.marks.map((mark) => {
    const results = perVersion((version) => {
      const result = decision.versions[version].marks.find((entry) => entry.mark === mark.id);
      if (result === undefined) return "–";
      if (!result.applies) return label("neutral", "does not apply");
      return h(Fragment, null, passLabel(result.pass), " ", h("span", { className: "num small" }, `measured ${result.measured === null ? "nothing" : result.measured}`));
    });
    const group = mark.group === "enrichment" ? [set.enrichment, committed.enrichment] : [set.matching, committed.matching];
    const [now, was] = group.map((marks) => (marks as Record<string, number>)[mark.key] as number);
    return markRow(mark.key, mark.direction === "min" ? "at least" : "at most", mark.label, RANGES[mark.direction === "max" ? "count" : "rate"], now as number, was as number, results);
  });
  const marginRow = markRow("margin", "within", "Margin of the best", RANGES.margin, set.ship_rule.margin, committed.ship_rule.margin, perVersion((version) => h("span", { className: "num small" }, `accuracy ${decision.versions[version].pairwise_accuracy ?? "nothing"}`)));
  return h(
    "div",
    { className: "what-if", "data-what-if": "" },
    h("p", { className: "callout amber" }, h("span", null, label("amber", "exploration only"), " ", h("strong", null, "The release gate reads only the committed file ", mono(evaluation.thresholds_file), "."), " Moving a slider changes no file and nothing that is served; the tick on each slider is the committed mark.")),
    h("div", { className: "now" }, h("p", { "aria-live": "polite" }, "With these marks: ", decision.ships === null ? label("red", "nothing would ship") : label("neutral", `would ship: ${versionName(decision.ships)}`), " ", small(decision.reason)), perVersion((version) => h(Fragment, null, passLabel(decision.versions[version].passed), small("all marks")))),
    h("div", { className: "marks" }, rows, marginRow),
    h("p", null, h("button", { type: "button", id: "what-if-reset", className: "chip", onClick: () => onReset?.() }, "Back to the committed marks")),
  );
}

// ---------------------------------------------------------------------------
// One piece of evidence, by its name
// ---------------------------------------------------------------------------

/** The parts of the two pieces of evidence that hold more than one thing. Each part has its own name, and one is open at a time. */
export const PARTS = {
  gate: { verdict: "The verdict and every pass mark", "what-if": "What if the pass marks were different?" },
  measures: {
    numbers: "Every measured number, and the split by the condition of the record",
    enrichment: "Is enrichment safe to automate? Label measures, tag conflicts and the reviewer",
    gallery: "Failures: what went wrong, and what was planted on purpose",
    limits: "What these numbers cannot show",
  },
} as const;
export type PartId = keyof (typeof PARTS)["gate"] | keyof (typeof PARTS)["measures"];

export interface EvidenceProps {
  id: EvidenceId;
  data: Loaded | null;
  evaluation: Evaluation | undefined;
  /** The what-if panel keeps state and asks the service, so the page supplies it. */
  whatIf?: ReactNode;
  /** The control that puts another version on the page, supplied by the page. */
  versionPicker?: ReactNode;
}

/** One part of the evaluation's evidence. */
export function Part({ id, evaluation, whatIf }: { id: PartId; evaluation: Evaluation; whatIf?: ReactNode }): ReactNode {
  switch (id) {
    case "verdict":
      return h(Verdict, { evaluation });
    case "what-if":
      return whatIf ?? h("p", null, "The what-if panel needs the page.");
    case "numbers":
      return h(Numbers, { evaluation });
    case "enrichment":
      return h(Measures, { evaluation });
    case "gallery":
      return h(Gallery, { evaluation });
    case "limits":
      return h("p", { "data-limits": "" }, LIMITS);
  }
}

export function Evidence({ id, data, evaluation, whatIf, versionPicker }: EvidenceProps): ReactNode {
  const none = (what: string): ReactNode => h("p", null, what);
  const anchor = data?.response.trace?.anchor ?? null;
  switch (id) {
    case "scores":
      return data ? h(Scores, { response: data.response }) : none("No request is on screen.");
    case "provenance":
      return data ? h(Provenance, { response: data.response }) : none("No request is on screen.");
    case "steps":
      return data && anchor ? h(Steps, { anchor, version: data.response.served.version }) : none("The index holds no record for this game.");
    case "raw-record":
      return anchor ? h(RawRecord, { anchor }) : none("The index holds no record for this game.");
    case "versions":
      return data ? h(Compare, { versions: data.versions, served: evaluation?.verdict.ships ?? "", shown: data.response.served.version, evaluation, picker: versionPicker }) : none("No request is on screen.");
    case "gate":
    case "measures": {
      if (evaluation === undefined) return none("The evaluation has not loaded.");
      const parts = Object.entries(PARTS[id]) as [PartId, string][];
      return h(
        Accordion,
        { className: "parts", defaultValue: [parts[0]?.[0] ?? ""], collapsible: true },
        parts.map(([part, name]) => h(AccordionItem, { key: part, value: part, className: "part" }, h(AccordionHeader, { render: h("h3", null) }, h(AccordionTrigger, { className: "part-name", ...{ "data-part": part } }, name)), h(AccordionPanel, { className: "part-body", ...{ "data-part-body": part } }, h(Part, { id: part, evaluation, whatIf })))),
      );
    }
  }
}
