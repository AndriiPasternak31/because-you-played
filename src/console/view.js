// The console's views: plain functions from the service's responses to HTML text.
//
// Nothing here computes a score, a label or a verdict. Every value shown is read from a
// response of this service, fetched through the `get` function a view is given, and every
// piece of text from a response is escaped before it reaches the page: catalogue text is data.
// What a view does add is drawing: a bar as long as a number the response carries, a count of a
// list it carries, a quote marked where it sits in the text it was copied from.
// The same file runs in the browser and under the tests, which is why it touches no DOM.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** A status, in words: green kept or passed, amber caution, red failure, blue the model, neutral a plain fact. */
const label = (tone, text) => `<span class="label ${tone}">${esc(text)}</span>`;
const mono = (text) => `<code>${esc(text)}</code>`;
const words = (term) => String(term).replaceAll("_", " ");
/** A theme or a mechanic. Blue when the model asserted it, plain when the synonym table did. */
const tag = (method, term) => `<span class="tag ${method === "model" ? "model" : "table"}">${esc(words(term))}</span>`;
const game = (entry) => `${esc(entry.title)} <span class="small">${mono(entry.game_id)} · ${esc(entry.provider)}</span>`;
const count = (value) => esc(typeof value === "number" ? value.toLocaleString("en-US") : value);
const plural = (number, one, many) => `${count(number)} ${number === 1 ? one : many}`;
/** A share of a track, for a value between 0 and 1. */
const width = (value) => `${(Math.max(0, Math.min(1, Number(value))) * 100).toFixed(2)}%`;

function section(id, kicker, heading, lede, body) {
  return `<section id="${id}" class="section"><p class="kicker">${esc(kicker)}</p><h3>${esc(heading)}</h3><p class="lede">${lede}</p>${body}</section>`;
}

/** One of the five steps of a trace. `state` is done, skipped (the step never ran) or declined. */
function stage(number, id, kicker, heading, lede, body, state = "done") {
  return (
    `<section id="${id}" class="stage ${state}"><span class="node" aria-hidden="true">${number}</span>` +
    `<p class="kicker"><span class="sr">Step ${number}: </span>${esc(kicker)}</p><h3>${esc(heading)}</h3><p class="lede">${lede}</p>${body}</section>`
  );
}

const VERSION_NAMES = { raw: "Raw text", table: "Synonym table", model_where_thin: "Model where thin", model_everywhere: "Model everywhere" };
export const versionName = (version) => VERSION_NAMES[version] ?? version;

// ---------------------------------------------------------------------------
// Trace: one request, top to bottom
// ---------------------------------------------------------------------------

const STEPS = [
  ["raw-record", "Record"],
  ["enrichment", "Labels"],
  ["removals", "Removed"],
  ["scores", "Scored"],
  ["outcome", "Outcome"],
];

/** The five steps at a glance. `facts` gives each step its one fact and whether it ran; with none, the steps are only named. */
function flow(facts) {
  const items = STEPS.map(([id, name], index) => {
    const fact = facts?.[index];
    const classes = [fact?.state ?? (facts ? "" : "off"), facts?.[index + 1]?.state === "off" ? "before-off" : ""].filter(Boolean).join(" ");
    const inner = `<span class="kicker">${name}</span>${fact ? `<span class="v num">${fact.text}</span>` : ""}`;
    return `<li style="--i:${index}"${classes ? ` class="${classes}"` : ""}>${facts ? `<a href="#${id}">${inner}</a>` : `<span class="step">${inner}</span>`}</li>`;
  });
  return `<ol class="flow" aria-label="The five steps of a request">${items.join("")}</ol>`;
}

function traceFlow(response) {
  const { trace } = response;
  const anchor = trace.anchor;
  const held = anchor.fields === null ? null : anchor.fields.themes.labels.length + anchor.fields.mechanics.labels.length;
  const removed = trace.filters.reduce((sum, step) => sum + step.removed.length, 0);
  const declined = response.outcome === "declined";
  return flow([
    { text: anchor.evidence === "none" ? "nearly empty" : anchor.thin ? "thin" : "not thin" },
    { text: held === null ? "none in this version" : plural(held, "label", "labels") },
    trace.filters.length === 0 ? { text: "not run", state: "off" } : { text: `${count(removed)} removed` },
    trace.scores.length === 0 ? { text: "nothing", state: "off" } : { text: `${count(trace.scores.length)} scored` },
    declined ? { text: "declined", state: "amber" } : { text: plural(response.results.length, "result", "results") },
  ]);
}

function absent(value) {
  if (value === null || value === undefined) return '<span class="absent">(none delivered)</span>';
  if (Array.isArray(value)) return value.length === 0 ? '<span class="absent">(empty list)</span>' : value.map((item) => mono(item)).join(" ");
  if (value === "") return '<span class="absent">(empty)</span>';
  return esc(typeof value === "object" ? JSON.stringify(value) : value);
}

function rawRecord(anchor) {
  const d = anchor.delivered;
  const rows = [
    ["title", d.title],
    ["provider", d.provider],
    ["category", d.category],
    ["description", d.description],
    ["features", d.features],
    ["themes", d.themes],
    ["tags", d.tags],
    ...Object.entries(d.facts),
  ];
  const status = anchor.status_on_brand === "live" ? label("green", "live on this brand") : label("amber", `${words(anchor.status_on_brand)} on this brand`);
  return stage(
    1,
    "raw-record",
    "What went in",
    "Raw record",
    `The record as the source delivered it, source row ${mono(d.source_record_id)}. ${status}`,
    `<dl class="raw">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${absent(value)}</dd>`).join("")}</dl>`,
  );
}

function evidenceRow(entry) {
  const method = entry.method === "model" ? `model ${esc(entry.model ?? "")}, prompt ${esc(entry.prompt_version ?? "")}` : "synonym table";
  return `<li>${tag(entry.method, entry.label)}<span class="quote">“${esc(entry.quote)}”</span><span class="small">in ${mono(entry.source_field)} · ${method}</span></li>`;
}

function evidenceList(labels, caption) {
  if (labels.length === 0) return `<p class="small">${esc(caption)}: nothing.</p>`;
  return `<p class="small">${esc(caption)}</p><ul class="evidence">${labels.map(evidenceRow).join("")}</ul>`;
}

/**
 * A text of the record with each quote marked where it sits, so the reader sees the words in place.
 * A quote that cannot be found in the text is counted and said, not dropped.
 */
function quotedInContext(text, quotes, caption) {
  const spans = [];
  let missing = 0;
  for (const quote of quotes) {
    const start = quote === "" ? -1 : text.indexOf(quote);
    if (start === -1) missing += 1;
    else spans.push([start, start + quote.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let html = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    html += `${esc(text.slice(cursor, start))}<mark>${esc(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += esc(text.slice(cursor));
  const unplaced = missing === 0 ? "" : ` ${label("amber", `${missing} not found in this text`)}`;
  return `<figure class="context"><figcaption class="small">${esc(caption)}${unplaced}</figcaption><p class="copy">${html}</p></figure>`;
}

function fieldLine(name, field) {
  if (field.status === "asserted") return `<li><strong>${esc(name)}</strong> ${field.labels.map((entry) => tag(entry.method, entry.label)).join(" ")}</li>`;
  const why = field.status === "conflict" ? `conflicting: ${words(field.conflict_reason ?? "")}. No label is asserted.` : "abstained: nothing in the record supports a label.";
  return `<li><strong>${esc(name)}</strong> ${label("amber", field.status === "conflict" ? "conflicting" : "abstained")} <span class="small">${esc(why)}</span></li>`;
}

function conflictNote(conflict) {
  const handled = conflict.model_reading_used
    ? "The two model versions carry the model's reading of the description and title instead."
    : "The model gave no reading from the description or title, so the field stays empty in every version.";
  const withheld =
    (conflict.model_labels_withheld ?? []).length === 0
      ? ""
      : ` Model labels not used, because they were backed by the disputed tag list: ${conflict.model_labels_withheld.map((entry) => `${esc(words(entry.label))} (${mono(entry.quote)})`).join(", ")}.`;
  return (
    `<div class="callout amber" data-conflict><p>${label("amber", "conflicting")} A delivered tag and the description disagree.</p>` +
    `<div class="versus"><p class="side"><span class="kicker">The tag</span> <span>${mono(conflict.tag)} asserts <strong>${esc(words(conflict.tag_asserts))}</strong></span></p>` +
    `<span class="ne" aria-hidden="true">≠</span>` +
    `<p class="side"><span class="kicker">The description</span> <span><span class="quote">“${esc(conflict.description_quote)}”</span> states <strong>${esc(conflict.description_states.map(words).join(", "))}</strong></span></p></div>` +
    `<p><strong>Table.</strong> A lookup cannot tell which is right, so the table version asserts no mechanic.</p>` +
    `<p><strong>Model.</strong> ${handled}${withheld}</p></div>`
  );
}

function enrichment(anchor, version, state) {
  const { table, model, conflict, cleaned } = anchor.steps;
  const step = (kind, number, name, who, body) => `<li class="${kind}"><div class="sh"><span class="n">Step ${number}</span><h4>${name}</h4>${who}</div>${body}</li>`;
  const steps = [];

  steps.push(
    step("code", 1, "Cleaning", label("neutral", "code only"), `<p class="small">Title: ${esc(cleaned.title)}. Description: ${cleaned.description === null ? "none delivered" : "kept word for word, with any markup removed"}.</p>`),
  );

  let tableBody = evidenceList([...table.themes, ...table.mechanics], "Labels the table found in the delivered tags");
  if (table.dropped.length > 0) tableBody += `<p class="small">Dropped as not an attribute of the game: ${table.dropped.map((entry) => `${mono(entry.tag)} (${esc(words(entry.reason))})`).join(", ")}.</p>`;
  if (table.unknown.length > 0) tableBody += `<p class="small">Unknown to the table, and not guessed: ${table.unknown.map((entry) => mono(entry.tag)).join(", ")}.</p>`;
  if (conflict !== null) tableBody += conflictNote(conflict);
  steps.push(step("code", 2, "Synonym table", label("neutral", "a lookup, no model"), tableBody));

  const thin = anchor.thin ? `${label("amber", "thin")} The table left this record without a usable label for its themes or its mechanics.` : "The table found labels for both fields, so the record is not thin.";
  steps.push(step("code", 3, "Thin rule", label("neutral", "a rule"), `<p>${thin}</p>`));

  const modelLabels = [...model.themes, ...model.mechanics];
  const used = model.used ? label("blue", "used in this version") : label("neutral", "not used in this version");
  let modelBody = `<p>${used} <span class="small">The model was asked once for this record, offline, and its answer is stored. No model is called when a request arrives.</span></p>${evidenceList(modelLabels, "Labels the model asserted, each with the words it copied from the record")}`;
  for (const field of ["title", "description"]) {
    const quotes = modelLabels.filter((entry) => entry.source_field === field).map((entry) => entry.quote);
    if (quotes.length > 0 && typeof cleaned[field] === "string") modelBody += quotedInContext(cleaned[field], quotes, `Those words, where they sit in the cleaned ${field}`);
  }
  if (model.stripped.length > 0) modelBody += `<p class="small">Stripped from the model's answer: ${model.stripped.map((entry) => `${esc(entry.label)} (${esc(words(entry.reason))})`).join(", ")}.</p>`;
  steps.push(step("model", 4, "Model", label("blue", "asked offline"), modelBody));

  const fields =
    anchor.fields === null
      ? `<p>${label("neutral", "no labels")} ${esc(versionName(version))} embeds the delivered text as it is and asserts no label.</p>`
      : `<ul class="fields">${fieldLine("Themes", anchor.fields.themes)}${fieldLine("Mechanics", anchor.fields.mechanics)}</ul>`;
  const holds = `<li class="holds"><div class="sh"><h4>What ${esc(versionName(version))} holds for this record</h4></div>${fields}<details><summary>The text that was embedded</summary><pre>${esc(anchor.text)}</pre></details></li>`;

  return stage(
    2,
    "enrichment",
    "What each step added",
    "Enrichment",
    `Every label sits beside the words it was read from. ${tag("model", "blue")} came from the model, ${tag("table", "plain")} from the synonym table.`,
    `<ol class="steps">${steps.join("")}${holds}</ol>`,
    state,
  );
}

/** How many removed games a filter lists in the open, before the list folds away. */
const SHORT_LIST = 5;

function removals(trace) {
  if (trace.filters.length === 0) return stage(3, "removals", "What was removed", "Removals", "The request was declined before any filter ran.", "", "skipped");
  const first = trace.filters[0];
  const start = first.removed.length + first.remaining;
  const rows = trace.filters
    .map((step) => {
      const list =
        step.removed.length === 0
          ? ""
          : `<details${step.removed.length <= SHORT_LIST ? " open" : ""}><summary>${step.removed.length === 1 ? "The one removed" : `The ${count(step.removed.length)} removed`}</summary><ul class="removed">${step.removed
              .map((entry) => `<li><span>${game(entry)}</span><span class="why">${esc(words(entry.why))}</span></li>`)
              .join("")}</ul></details>`;
      const removed = step.removed.length === 0 ? "removed 0" : `<b>removed ${count(step.removed.length)}</b>`;
      return (
        `<li><div class="fh"><span class="fname" title="${esc(step.filter)}">${esc(words(step.filter))}</span><span class="counts num">${removed} · <i>${count(step.remaining)} left</i></span></div>` +
        `<span class="track"><span class="fill" style="width:${width(start === 0 ? 0 : step.remaining / start)}"></span></span><p class="small">${esc(step.rule)}</p>${list}</li>`
      );
    })
    .join("");
  return stage(
    3,
    "removals",
    "What was removed",
    "Removals",
    `The filters in the order they ran, and how much of the catalogue's ${count(start)} games each left. Availability comes first: a game that is not live on the brand is removed before anything is scored.`,
    `<ol class="funnel">${rows}</ol>`,
  );
}

function scores(trace) {
  if (trace.scores.length === 0) return stage(4, "scores", "What was scored", "Scores", "Nothing was scored for this request.", "", "skipped");
  let floorDrawn = false;
  const floorRow = `<tr class="floor"><td colspan="4">${label("neutral", "similarity floor")} <span class="num">${esc(trace.floor)}</span> <span class="small">${esc(trace.floor_rule)}</span></td></tr>`;
  const rows = trace.scores
    .map((entry) => {
      const below = entry.score < trace.floor;
      const line = below && !floorDrawn ? floorRow : "";
      if (below) floorDrawn = true;
      const bar = `<span class="track"><span class="fill${below ? " quiet" : ""}" style="width:${width(entry.score)}"></span><span class="at" style="left:${width(trace.floor)}" title="similarity floor"></span></span>`;
      return `${line}<tr${below ? ' class="below"' : ""}><td class="num">${esc(entry.rank)}</td><td>${game(entry)}</td><td class="num">${esc(entry.score)}</td><td class="barcell">${bar}</td></tr>`;
    })
    .join("");
  return stage(
    4,
    "scores",
    "What was scored",
    "Scores",
    `${plural(trace.scores.length, "candidate was", "candidates were")} scored against the game that was asked about. The tick on each bar is the similarity floor: a score under it is never shown to a player.`,
    `<div class="scroll tall" tabindex="0" role="region" aria-label="Scores of every candidate"><table class="scores"><thead><tr><th class="num">Rank</th><th>Game</th><th class="num">Score</th><th>From 0 to 1</th></tr></thead><tbody>${rows}${floorDrawn ? "" : floorRow}</tbody></table></div>` +
      `<p class="small">All ${count(trace.scores.length)} are in the list above, best first; it scrolls.</p>`,
  );
}

function outcome(response) {
  if (response.outcome === "declined") {
    return stage(
      5,
      "outcome",
      "What came out",
      "Outcome",
      "The service declined. This is an answer, not an error.",
      `<div class="callout amber"><p data-decline>${label("amber", "declined")} ${mono(response.decline.reason)}</p><p>${esc(response.decline.detail)}</p><p><strong>A player would see nothing.</strong></p></div>`,
      "declined",
    );
  }
  const items = response.results
    .map((entry, index) => `<li style="--i:${index}"><span class="rank num">${esc(entry.rank)}</span><span>${game(entry)}</span><span class="score num">score ${esc(entry.score)}</span></li>`)
    .join("");
  return stage(5, "outcome", "What came out", "Outcome", `${label("green", "result")} ${plural(response.results.length, "related game", "related games")}, best first.`, `<ol class="results" data-results>${items}</ol>`);
}

function provenance(response) {
  const timings = response.trace ? Object.entries(response.trace.timings_ms).map(([step, ms]) => `${esc(words(step))} ${esc(ms)} ms`).join(" · ") : "";
  return `<p class="provenance">Index ${mono(response.served.index_hash.slice(0, 12))} · version ${mono(response.served.version)} · ${timings}.</p>`;
}

/** The trace for one response of /api/recommendations or /api/inspect. */
export function renderTrace(response) {
  const trace = response.trace;
  const inspection =
    response.inspection && !response.inspection.is_served_version
      ? `<p class="callout blue"><span>${label("neutral", "inspection")} This is ${esc(versionName(response.served.version))}, shown for comparison. Players are served ${esc(versionName(response.inspection.served_version))}.</span></p>`
      : "";
  const head = `<h2 class="trace-title">${esc(trace?.anchor ? trace.anchor.title : response.request.game_id)} <span class="small">on ${esc(response.request.brand)}</span></h2>${inspection}`;
  if (!trace || trace.anchor === null) return `${head}<div class="rail solo">${outcome(response)}</div>${provenance(response)}`;
  const leadsToSkipped = trace.filters.length === 0 ? "done before-skipped" : "done";
  return `${head}${traceFlow(response)}<div class="rail">${rawRecord(trace.anchor)}${enrichment(trace.anchor, response.served.version, leadsToSkipped)}${removals(trace)}${scores(trace)}${outcome(response)}</div>${provenance(response)}`;
}

const url = (path, params) => `${path}?${new URLSearchParams(params).toString()}`;

/** Fetches and renders the trace. `get` is the only way a view reaches data. */
export async function traceView(get, request) {
  const params = { game: request.game, brand: request.brand };
  const response =
    request.version === undefined || request.version === request.served
      ? await get(url("/api/recommendations", { ...params, trace: "1" }))
      : await get(url("/api/inspect", { ...params, version: request.version }));
  return renderTrace(response);
}

// ---------------------------------------------------------------------------
// Side by side: the same request against each version of the index
// ---------------------------------------------------------------------------

/** Every game any version would recommend, and the rank each version gives it. */
function resultMatrix(responses, versions, served) {
  const games = new Map();
  for (const version of versions) for (const entry of responses[version].results) if (!games.has(entry.game_id)) games.set(entry.game_id, entry);
  if (games.size === 0) return `<p>${label("amber", "no results")} No version would recommend anything for this game on this brand.</p>`;
  const header = versions
    .map((version) => {
      const state = responses[version].outcome === "declined" ? label("amber", "declined") : version === served ? label("green", "served") : "";
      return `<th scope="col">${esc(versionName(version))}${state ? `<br>${state}` : ""}</th>`;
    })
    .join("");
  const rows = [...games.values()]
    .map((entry) => {
      const cells = versions
        .map((version) => {
          const hit = responses[version].results.find((result) => result.game_id === entry.game_id);
          return hit ? `<td class="hit"><b class="num"><span class="sr">rank </span>${esc(hit.rank)}</b><span class="num small">${esc(hit.score)}</span></td>` : '<td class="miss"><span aria-hidden="true">–</span><span class="sr">not recommended</span></td>';
        })
        .join("");
      return `<tr class="game"><th scope="row">${esc(entry.title)} <span class="small">${mono(entry.game_id)}</span></th>${cells}</tr>`;
    })
    .join("");
  return `<h3>Who would recommend what</h3><p class="small">One row per game any version would return. The number is the rank that version gives it.</p><table class="matrix"><thead><tr class="head"><th scope="col">Game</th>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderCompare(responses, served) {
  const versions = Object.keys(responses);
  const cell = (response, row) => {
    const anchor = response.trace?.anchor;
    if (row === "outcome") return response.outcome === "declined" ? `${label("amber", "declined")} ${mono(response.decline.reason)}` : label("green", plural(response.results.length, "result", "results"));
    if (row === "results") return response.results.length === 0 ? '<span class="absent">none</span>' : `<ol>${response.results.map((entry) => `<li>${esc(entry.title)} <span class="num small">${esc(entry.score)}</span></li>`).join("")}</ol>`;
    if (!anchor) return '<span class="absent">-</span>';
    if (anchor.fields === null) return '<span class="absent">no labels in this version</span>';
    const field = anchor.fields[row];
    if (field.status !== "asserted") return label("amber", field.status === "conflict" ? "conflicting" : "abstained");
    return field.labels.map((entry) => `<div>${tag(entry.method, entry.label)} <span class="quote small">“${esc(entry.quote)}”</span></div>`).join("");
  };
  const header = versions.map((version) => `<th scope="col">${esc(versionName(version))}${version === served ? ` ${label("green", "served")}` : ""}<span class="small">floor ${esc(responses[version].trace?.floor ?? "")}</span></th>`).join("");
  const rows = [
    ["outcome", "Outcome"],
    ["themes", "Themes"],
    ["mechanics", "Mechanics"],
    ["results", "Results"],
  ]
    .map(([row, name]) => `<tr><th scope="row">${name}</th>${versions.map((version) => `<td>${cell(responses[version], row)}</td>`).join("")}</tr>`)
    .join("");
  return (
    resultMatrix(responses, versions, served) +
    `<h3>What each version holds, and returns</h3><p class="small">Each label keeps the words it was read from. ${tag("model", "blue")} came from the model, ${tag("table", "plain")} from the synonym table.</p>` +
    `<div class="scroll"><table class="compare"><thead><tr class="head"><th></th>${header}</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

export async function compareView(get, request) {
  const responses = {};
  for (const version of request.versions) responses[version] = await get(url("/api/inspect", { game: request.game, brand: request.brand, version }));
  return renderCompare(responses, request.served);
}

// ---------------------------------------------------------------------------
// Evaluation: the race, where it helps, the checks behind the verdict, the gallery
// ---------------------------------------------------------------------------

const pct = (value) => (value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`);
const share = (value) => (value.rate === null ? `none of ${count(value.of)}` : `${pct(value.rate)} <span class="small">${count(value.count)} of ${count(value.of)}</span>`);
const mini = (value) => (value === null || value === undefined ? "" : `<span class="mini"><i style="width:${width(value)}"></i></span>`);
const passLabel = (ok) => (ok ? label("green", "pass") : label("red", "fail"));
const GEAR =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2"/>' +
  '<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4M4.6 4.6l2.8 2.8M16.6 16.6l2.8 2.8M4.6 19.4l2.8-2.8M16.6 7.4l2.8-2.8"/></svg>';

function reviewerSays(reviewer) {
  if (reviewer === null || reviewer === undefined) return "";
  if (typeof reviewer === "string") return `<span class="small">${esc(words(reviewer))}</span>`;
  const note = reviewer.note ? ` <span class="small">(${esc(words(reviewer.note))}: it said ${esc(reviewer.said)})</span>` : "";
  return `reviewer: ${label("neutral", reviewer.answer)}${note}${reviewer.words ? ` <span class="quote small">“${esc(reviewer.words)}”</span>` : ""}`;
}

function detailList(detail) {
  return `<dl class="detail">${Object.entries(detail)
    .map(([key, value]) => `<dt>${esc(words(key))}</dt><dd>${key === "reviewer" ? reviewerSays(value) : esc(typeof value === "object" && value !== null ? JSON.stringify(value) : String(value))}</dd>`)
    .join("")}</dl>`;
}

function galleryList(entries) {
  return entries
    .map((entry) => `<details><summary>${mono(entry.kind)} · ${esc(entry.title)} ${mono(entry.game_id)}${entry.version ? ` <span class="small">in ${esc(versionName(entry.version))}</span>` : ""}</summary><p>${esc(entry.what)}</p>${detailList(entry.detail)}</details>`)
    .join("");
}

export function renderEvaluation(evaluation) {
  const { report, verdict } = evaluation;
  const versions = Object.keys(report.matching);
  const decision = report.decision;
  const markName = (id) => evaluation.marks.find((mark) => mark.id === id)?.label ?? id;
  const out = [];

  const shipped =
    verdict.ships === null
      ? `<span class="big">Nothing ships</span> ${label("red", "not serving")}`
      : `<span class="big">${esc(versionName(verdict.ships))}</span> ${label("green", "ships")}`;
  const ownerTone = report.owner_check.status === "answered" ? "green" : "amber";
  out.push(
    `<div class="verdict${verdict.ships === null ? " failed" : ""}"><p class="kicker">The release gate's verdict</p>` +
      `<p class="ships">${shipped} <button type="button" id="what-if-open" class="icon" aria-expanded="false" aria-controls="what-if" title="Explore other pass marks">${GEAR}<span>What if the pass marks were different?</span></button></p>` +
      `<p>${esc(verdict.reason)}</p><p class="small">Verdict for index ${mono(verdict.index_hash.slice(0, 12))}, reached with the pass marks committed in ${mono(evaluation.thresholds_file)} (decided ${esc(evaluation.thresholds.decided_on)}).</p>` +
      `<p>${label(ownerTone, `owner's check ${report.owner_check.status}`)} <span class="small">${esc(report.owner_check.note)}</span></p></div><div id="what-if" hidden></div>`,
  );

  // The race. Quality is drawn from zero, with the committed pass mark as a tick; cost against the dearest version.
  const accuracyMark = evaluation.marks.find((mark) => mark.measure === "pairwise_accuracy");
  const passMark = accuracyMark ? evaluation.thresholds[accuracyMark.group]?.[accuracyMark.key] : undefined;
  const dearest = Math.max(...versions.map((version) => report.matching[version].cost.estimated_usd));
  const raceRows = versions
    .map((version) => {
      const row = report.matching[version];
      const state = decision.versions[version];
      const tick = typeof passMark === "number" ? `<span class="at" style="left:${width(passMark)}" title="pass mark ${esc(passMark)}"></span>` : "";
      const quality = row.pairwise.pooled.rate === null ? "" : `<span class="track"><span class="fill" style="width:${width(row.pairwise.pooled.rate)}"></span>${tick}</span>`;
      const cost = `<span class="track"><span class="fill blue" style="width:${width(dearest > 0 ? row.cost.estimated_usd / dearest : 0)}"></span></span>`;
      return (
        `<tr role="row"><th scope="row" role="rowheader">${esc(versionName(version))}${version === verdict.ships ? `<br>${label("green", "ships")}` : ""}</th>` +
        `<td role="cell" data-th="Ranking quality"><span class="figure">${pct(row.pairwise.pooled.rate)}</span><span class="small">${count(row.pairwise.pooled.count)} of ${count(row.pairwise.pooled.of)} pairs in the right order</span>${quality}` +
        `<span class="small">mean per game ${pct(row.pairwise.per_game.mean)} over ${count(row.pairwise.per_game.games)} games</span><span class="small">wrongly shown: ${count(row.wrongly_shown.count)} of ${count(row.wrongly_shown.results_judged)} results judged</span></td>` +
        `<td role="cell" data-th="Cost of building it"><span class="figure">$${esc(row.cost.estimated_usd.toFixed(4))}</span><span class="small">${plural(row.cost.model_calls, "model call", "model calls")} · ${esc(row.cost.seconds.toFixed(1))} s of calls</span>${cost}</td>` +
        `<td role="cell" class="gate" data-th="Pass marks">${passLabel(state.passed)}${state.failed_marks.length > 0 ? `<span class="small">${esc(state.failed_marks.map(markName).join(", "))}</span>` : ""}</td></tr>`
      );
    })
    .join("");
  out.push(
    section(
      "race",
      "The race",
      "Ranking quality against cost",
      "Pairwise accuracy: for each game, how often a game the plan calls related scores above one it calls unrelated. Cost is what building that version of the index took.",
      `<table class="race" role="table"><thead role="rowgroup"><tr role="row"><th role="columnheader">Version</th><th role="columnheader">Ranking quality</th><th role="columnheader">Cost of building it</th><th role="columnheader">Pass marks</th></tr></thead><tbody role="rowgroup">${raceRows}</tbody></table>` +
        `<p class="small">Quality bars run from 0 to 100%${typeof passMark === "number" ? `; the tick is the committed pass mark, ${esc(passMark)}` : ""}. Cost bars are drawn against the dearest version. ` +
        `Check games on ${esc(report.check_games.brand)}: ${report.check_games.games.map(mono).join(" ")}. A result is wrongly shown when the rule calls it unrelated and the reviewer also says no.</p>`,
    ),
  );

  const conditions = [
    ["by_condition", "description", "Has a description"],
    ["by_condition", "tags_only", "Tags only"],
    ["by_condition", "none", "Nearly empty"],
    ["by_thin", "thin", "Thin"],
    ["by_thin", "not_thin", "Not thin"],
  ];
  const versionHeads = (list) => list.map((version) => `<th scope="col" class="num">${esc(versionName(version))}${version === verdict.ships ? `<br>${label("green", "ships")}` : ""}</th>`).join("");
  const helpRows = conditions
    .map(
      ([group, key, name]) =>
        `<tr><th scope="row">${name}</th>${versions
          .map((version) => {
            const cell = report.matching[version][group][key].per_game;
            return `<td class="num">${pct(cell.mean)}${mini(cell.mean)}<span class="small">${count(cell.games)} games</span></td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  out.push(
    section(
      "where-it-helps",
      "Where it helps",
      "The same result, by the condition of the record",
      "Pairwise accuracy, mean per game, split by what the record that was asked about had to offer. Read across a row to see what each version adds for that kind of record.",
      `<div class="scroll"><table class="by-condition"><thead><tr><th scope="col">Record</th>${versionHeads(versions)}</tr></thead><tbody>${helpRows}</tbody></table></div>`,
    ),
  );

  const labelled = Object.keys(report.enrichment);
  const of = (value) => `${count(value.count)} <span class="small">of ${count(value.of)}</span>`;
  const measures = [
    ["Precision", "Of the labels asserted, the share that are correct", (row) => share(row.precision)],
    ["Recovery", "Of the labels the record's own words support, the share asserted", (row) => share(row.recovery)],
    ["Recovery without tags", "The same, where the evidence is only in the description or the title", (row) => share(row.recovery_without_tags)],
    ["Missed abstentions", "Fields where nothing should be asserted and something was", (row) => of(row.missed_abstentions)],
    ["Invalid quotes", "Labels whose quote is not in the record word for word", (row) => of(row.invalid_quotes)],
    ["Recoverable labels not asserted", "Labels the record supports that the version left out", (row) => `${count(row.missed.not_asserted)} <span class="small">+ ${count(row.missed.conflict_rule)} on a field left empty by a tag conflict</span>`],
  ];
  const enrichRows = measures.map(([name, means, value]) => `<tr><th scope="row">${name}<span class="small">${means}</span></th>${labelled.map((version) => `<td class="num">${value(report.enrichment[version])}</td>`).join("")}</tr>`).join("");
  const disagreements = report.disagreements.list
    .map((entry) => `<li>${esc(entry.title)} ${mono(entry.game_id)}: ${tag("model", entry.label)} is ${esc(words(entry.plan))} in the plan; asserted by ${esc(entry.asserted_by.map((by) => versionName(by.version)).join(", "))} from <span class="quote">“${esc(entry.asserted_by[0]?.quote ?? "")}”</span>. ${reviewerSays(entry.reviewer)}</li>`)
    .join("");
  const control = report.control;
  out.push(
    section(
      "enrichment-measures",
      "The labels",
      "Is enrichment safe to automate?",
      "Counts beside every rate. Raw text asserts no labels, so these measures do not apply to it.",
      `<div class="scroll"><table class="measures"><thead><tr><th scope="col">Measure</th>${versionHeads(labelled)}</tr></thead><tbody>${enrichRows}</tbody></table></div>` +
        `<h4>Where a tag contradicts the description: ${plural(report.conflict_games.games.length, "game", "games")}</h4><p class="small">${esc(report.conflict_games.note)}</p>` +
        `<div class="scroll"><table><thead><tr><th>Game</th><th>The tag says</th><th>The description says</th>${labelled.map((version) => `<th>${esc(versionName(version))}</th>`).join("")}</tr></thead><tbody>${report.conflict_games.games
          .map(
            (entry) =>
              `<tr><td>${esc(entry.title)} ${mono(entry.game_id)}</td><td>${mono(entry.tag)}</td><td>${esc(entry.description_states.map(words).join(", "))}</td>${labelled
                .map((version) => {
                  const field = entry.mechanics[version];
                  return `<td>${field.status === "asserted" ? field.labels.map((term) => tag(version === "table" ? "synonym_table" : "model", term)).join(" ") : label("amber", field.status === "conflict" ? "conflicting" : field.status)}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div>` +
        `<h4>Disagreements with the plan: ${esc(report.disagreements.count)}</h4><ul class="plain">${disagreements}</ul>` +
        `<h4>The reviewer, ${mono(report.reviewer.model)}</h4><p>Control: it agreed with the plan on ${esc(control.agreed)} of ${esc(control.size)} labels where the plan and the pipeline agree (${esc(control.applies.agreed)} of ${esc(control.applies.of)} where the label applies, ${esc(control.does_not_apply.agreed)} of ${esc(control.does_not_apply.of)} where it does not). ` +
        `It answered ${esc(report.reviewer.questions)} questions: ${esc(report.reviewer.answers.yes)} yes, ${esc(report.reviewer.answers.no)} no, ${esc(report.reviewer.answers.unclear)} unclear.</p>` +
        (report.reviewer.unclear.length === 0 ? "" : `<p class="small">Recorded as unclear: ${report.reviewer.unclear.map((entry) => `${mono(entry.question_id)} (${esc(words(entry.note ?? "it said unclear"))})`).join(", ")}.</p>`),
    ),
  );

  out.push(
    section(
      "gallery",
      "Failures",
      "What went wrong, and what was planted",
      "Real failures the evaluation found in the system's own output, and, listed apart, the mess that was planted in the catalogue on purpose.",
      `<div class="gallery"><h4>Real failures: ${esc(report.gallery.real.length)}</h4>${galleryList(report.gallery.real)}</div><div class="gallery"><h4>Planted on purpose: ${esc(report.gallery.injected.length)}</h4>${galleryList(report.gallery.injected)}</div>`,
    ),
  );
  return out.join("");
}

// ---------------------------------------------------------------------------
// What-if: other pass marks against the measured numbers
// ---------------------------------------------------------------------------

const RANGES = { rate: { min: 0, max: 1, step: 0.01 }, count: { min: 0, max: 10, step: 1 }, margin: { min: 0, max: 0.2, step: 0.005 } };
const kind = (mark) => (mark.direction === "max" ? "count" : "rate");

/** One pass mark: its slider with the committed mark as a fixed tick, and what each version makes of the value now set. */
function markRow(id, bound, name, range, value, committedValue, results) {
  const at = (committedValue - range.min) / (range.max - range.min);
  const moved = value !== committedValue;
  return (
    `<div class="mark${moved ? " moved" : ""}"><div><div class="mh"><label for="mark-${id}">${esc(name)}</label><span class="small">${bound} <output for="mark-${id}">${esc(value)}</output>${moved ? ` ${label("amber", "moved")}` : ""}</span></div>` +
    `<div class="slider"><input type="range" id="mark-${id}" name="${id}" min="${range.min}" max="${range.max}" step="${range.step}" value="${esc(value)}">` +
    `<span class="tick" style="--at:${at.toFixed(4)}" title="committed mark"></span><div class="small">committed: ${esc(committedValue)}</div></div></div>` +
    `<ul class="per-version">${results}</ul></div>`
  );
}

/** The sliders. `whatIf.marks` are the marks now set, `whatIf.committed` the marks in the owner's file, `whatIf.decision` the gate's answer for the marks now set. */
export function renderWhatIf(evaluation, whatIf) {
  const { marks } = evaluation;
  const committed = whatIf.committed;
  const set = whatIf.marks;
  const versions = Object.keys(whatIf.decision.versions);
  const perVersion = (cell) => versions.map((version) => `<li><span class="small">${esc(versionName(version))}</span>${cell(version)}</li>`).join("");
  const rows = marks
    .map((mark) => {
      const results = perVersion((version) => {
        const result = whatIf.decision.versions[version].marks.find((entry) => entry.mark === mark.id);
        if (!result.applies) return label("neutral", "does not apply");
        return `${passLabel(result.pass)} <span class="num small">measured ${esc(result.measured === null ? "nothing" : result.measured)}</span>`;
      });
      return markRow(mark.key, mark.direction === "min" ? "at least" : "at most", mark.label, RANGES[kind(mark)], set[mark.group][mark.key], committed[mark.group][mark.key], results);
    })
    .join("");
  const marginRow = markRow(
    "margin",
    "within",
    "Margin of the best",
    RANGES.margin,
    set.ship_rule.margin,
    committed.ship_rule.margin,
    perVersion((version) => `<span class="num small">accuracy ${esc(whatIf.decision.versions[version].pairwise_accuracy ?? "nothing")}</span>`),
  );
  const would = whatIf.decision.ships === null ? label("red", "nothing would ship") : label("neutral", `would ship: ${versionName(whatIf.decision.ships)}`);
  return (
    `<div class="what-if" data-what-if><p class="kicker">What if</p><h3>Other pass marks, against the measured numbers</h3>` +
    `<p class="callout amber"><span>${label("amber", "exploration only")} <strong>The release gate reads only the committed file ${mono(evaluation.thresholds_file)}.</strong> Moving a slider changes no file and nothing that is served; the tick on each slider is the committed mark.</span></p>` +
    `<div class="now"><p aria-live="polite">With these marks: ${would} <span class="small">${esc(whatIf.decision.reason)}</span></p>` +
    `<ul class="per-version">${perVersion((version) => `${passLabel(whatIf.decision.versions[version].passed)}<span class="small">all marks</span>`)}</ul></div>` +
    `<div class="marks">${rows}${marginRow}</div>` +
    `<p><button type="button" id="what-if-reset">Back to the committed marks</button></p></div>`
  );
}

/** `values` maps a mark's key (or "margin") to a number. An empty object asks for the committed marks. */
export async function whatIfView(get, evaluation, values) {
  const whatIf = await get(Object.keys(values).length === 0 ? "/api/what-if" : url("/api/what-if", values));
  return renderWhatIf(evaluation, whatIf);
}

// ---------------------------------------------------------------------------
// States that are not a trace
// ---------------------------------------------------------------------------

export const renderEmpty = () => `<p class="lede">Choose a brand and a game. The page will follow the request through five steps, from the raw record to the result or the reason for declining.</p>${flow(null)}`;
export const renderLoading = () => "<p>Loading</p>";
export const renderBadInput = (message) => `<p>${label("amber", "bad request")} ${esc(message)}</p>`;
export const renderFailed = (message) => `<p>${label("red", "failed")} ${esc(message)} Nothing is shown because nothing was received.</p>`;
