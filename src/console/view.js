// The console's views: plain functions from the service's responses to HTML text.
//
// The page answers four questions in order: what the system recommends, why these and not
// others, what the model added, and whether the model was worth it. The detail behind each
// answer stays on the page, folded away under a labelled control.
//
// Nothing here computes a score, a label or a verdict. Every value shown is read from a
// response of this service, fetched through the `get` function a view is given, and every
// piece of text from a response is escaped before it reaches the page: catalogue text is data.
// What a view adds is reading and drawing: a bar as long as a number the response carries, a
// count of a list it carries, a quote marked where it sits in the text it was copied from, the
// labels two records both hold, and a search of the responses for a game that shows a moment.
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
const url = (path, params) => `${path}?${new URLSearchParams(params).toString()}`;

/** Detail that is true and not the first thing to read: folded away under a summary that says what it holds. */
function drawer(id, summary, lede, body) {
  return `<details id="${id}" class="drawer"><summary>${summary}</summary><div class="drawer-body">${lede ? `<p class="lede">${lede}</p>` : ""}${body}</div></details>`;
}

const VERSION_NAMES = { raw: "Raw text", table: "Synonym table", model_where_thin: "Model where thin", model_everywhere: "Model everywhere" };
export const versionName = (version) => VERSION_NAMES[version] ?? version;

/** The labels a version holds for a record, themes first. */
function heldLabels(anchor) {
  if (!anchor || anchor.fields === null || anchor.fields === undefined) return [];
  return ["themes", "mechanics"].flatMap((field) => (anchor.fields[field]?.labels ?? []).map((entry) => ({ ...entry, field })));
}

// ---------------------------------------------------------------------------
// 1 · What it recommends
// ---------------------------------------------------------------------------

/** The labels of the game played that a recommended game also holds, in the same version. */
function sharedLabels(anchor, neighbour) {
  const theirs = heldLabels(neighbour?.trace?.anchor);
  return heldLabels(anchor).filter((mine) => theirs.some((other) => other.field === mine.field && other.label === mine.label));
}

const pct = (value) => (value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`);

/**
 * The model's value, beside the result: what the evaluation measured over every game, and what the
 * other versions return for this request. A different list is not called a better one; only the measured numbers are.
 */
function worth(response, { versions, evaluation }) {
  if (versions === undefined && evaluation === undefined) return "";
  let here = "";
  if (versions !== undefined) {
    const mine = response.results.map((entry) => entry.game_id);
    const lines = Object.keys(versions)
      .filter((version) => version !== response.served.version)
      .map((version) => {
        const theirs = versions[version].results.map((entry) => entry.game_id);
        const same = theirs.filter((id) => mine.includes(id)).length;
        const calls = evaluation?.report.matching[version]?.cost.model_calls;
        const built = calls === undefined ? "" : calls === 0 ? ` ${label("neutral", "no model")}` : ` ${label("blue", "model")}`;
        let returns;
        if (versions[version].outcome === "declined") returns = "declines";
        else if (mine.length === 0) returns = `returns ${plural(theirs.length, "game", "games")}`;
        else if (same === mine.length && theirs.length === same) returns = theirs.join() === mine.join() ? "the same games, same order" : "the same games, another order";
        else returns = `${count(same)} of these ${count(mine.length)}${theirs.length > same ? `, and ${plural(theirs.length - same, "other", "others")}` : ""}`;
        return `<li><span>${esc(versionName(version))}${built}</span><span class="num">${returns}</span></li>`;
      })
      .join("");
    here = `<h3>This request in the other versions</h3><ul class="others" data-others>${lines}</ul><p class="small">A different list is not a better list.${evaluation === undefined ? "" : " Whether the model's lists are better is what the numbers above measure, over every game."}</p>`;
  }
  let measured = "";
  if (evaluation !== undefined) {
    const { report, verdict } = evaluation;
    const names = Object.keys(report.matching);
    const dearest = Math.max(...names.map((version) => report.matching[version].cost.estimated_usd));
    const rows = names
      .map((version) => {
        const row = report.matching[version];
        const failed = report.decision.versions[version]?.passed === false ? `<br>${label("red", "fails a pass mark")}` : "";
        return (
          `<tr${version === verdict.ships ? ' class="served"' : ""}><th scope="row">${esc(versionName(version))}${version === verdict.ships ? ` ${label("green", "served")}` : ""}${failed}</th>` +
          `<td class="num">${pct(row.pairwise.pooled.rate)}<span class="track"><span class="fill" style="width:${width(row.pairwise.pooled.rate ?? 0)}"></span></span></td>` +
          `<td class="num">$${esc(row.cost.estimated_usd.toFixed(4))}<span class="track"><span class="fill blue" style="width:${width(dearest > 0 ? row.cost.estimated_usd / dearest : 0)}"></span></span></td></tr>`
        );
      })
      .join("");
    measured =
      `<h3>Measured over the whole catalogue</h3><table class="mini-race" data-measured><thead><tr><th scope="col">Version</th><th scope="col" class="num">Ranked right</th><th scope="col" class="num">Est. cost to build</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="small">Ranked right: how often a related game scores above an unrelated one, against the answer key of this fictional catalogue. It shows direction, not how real players would judge a list. Costs are estimates.</p>`;
  }
  return `<aside class="worth" aria-label="The four versions, measured">${measured}${here}</aside>`;
}

/**
 * The four sections of the page. Each asks one question in plain words and says why it matters;
 * the answer for the chosen game and brand is drawn beside it. One section is open at a time.
 */
export const SECTIONS = [
  {
    id: "shown",
    pane: "outcome",
    tab: "What is shown",
    question: "What would a player who played this game be shown next?",
    why: "Only a game that is live on this brand and cleared the similarity floor against the game played is returned. That is all the service promises about them.",
  },
  {
    id: "added",
    pane: "enrichment",
    tab: "What the model added",
    question: "What did the language model add to this game's record?",
    why: "Suppliers describe games unevenly. A model can read the supplier's own text, offline, and add labels; each label it adds keeps the words it was read from.",
  },
  {
    id: "removed",
    pane: "removals",
    tab: "What was removed",
    question: "Which games were left out, and why?",
    why: "A game that is not live on the brand must never be shown, however similar it is. Availability is settled first, by rules; scores only order what is left.",
  },
  {
    id: "worth",
    pane: "worth",
    tab: "Was it worth it",
    question: "Was the language model worth its cost?",
    why: "A model costs money and can be wrong. Which version is served is decided by a release gate, from measured numbers and pass marks committed before any result.",
  },
];

const sectionOf = (id) => (SECTIONS.some((section) => section.id === id) ? id : SECTIONS[0].id);

/** The links that switch between the sections. Each carries the request, so it opens the same view anywhere. */
export function renderTabs(open, request) {
  return SECTIONS.map((section, index) => `<a href="${esc(url("/", { ...request, section: section.id }))}" data-tab="${section.id}"${section.id === sectionOf(open) ? ' aria-current="true"' : ""}><span class="num">${index + 1}</span> ${esc(section.tab)}</a>`).join("");
}

/** One section: the question on the left, and on the right the sentence that answers it, then what supports it. */
function pane(section, number, open, response, look, { answer, rest }) {
  const example = look && sectionOf(look.section) === section.id ? `<p class="example small" data-look>${label("neutral", "this example")} ${esc(look.note)}</p>` : "";
  return (
    `<section id="${section.pane}" class="pane" data-section="${section.id}" data-game="${esc(response.request.game_id)}" data-brand="${esc(response.request.brand)}"${section.id === open ? "" : " hidden"}>` +
    `<div class="ask"><p class="kicker">${number} · ${esc(section.tab)}</p><h2 data-question>${esc(section.question)}</h2><p class="why small">${esc(section.why)}</p>${example}</div>` +
    `<div class="reply"><div class="says" data-answer>${answer}</div>${rest}</div></section>`
  );
}

/**
 * A failure the evaluation lists for this game, said with the result. It is said only where the evaluation
 * found it: in that version, and, when it is about a request, on that brand and with that result on the page.
 */
function knownFailures(response, evaluation) {
  const anchor = response.trace?.anchor ?? null;
  if (anchor === null || evaluation === undefined) return "";
  return evaluation.report.gallery.real
    .filter((entry) => {
      if (entry.game_id !== anchor.game_id) return false;
      if (entry.version && entry.version !== response.served.version) return false;
      const result = entry.detail?.result;
      const brand = entry.detail?.brand ?? (result ? evaluation.report.check_games.brand : null);
      if (brand !== null && brand !== response.request.brand) return false;
      return !result || response.results.some((shown) => shown.game_id === result.game_id);
    })
    .map((entry) => {
      const about = [entry.detail?.label ? `label ${words(entry.detail.label)}` : "", entry.detail?.result ? `the result ${entry.detail.result.title}` : "", entry.version ? `in ${versionName(entry.version)}` : ""].filter(Boolean).join(", ");
      return `<p class="callout amber" data-failure><span>${label("amber", "a failure the evaluation found")} ${esc(entry.what)}${about ? ` <span class="small">${esc(about)}</span>` : ""}</span></p>`;
    })
    .join("");
}

/** 1 · What is shown: the result or the decline, in a sentence that claims only what the service guarantees. */
function shown(response, extras) {
  const { neighbours, evaluation } = extras;
  const anchor = response.trace?.anchor ?? null;
  const title = esc(anchor ? anchor.title : response.request.game_id);
  const brand = esc(response.request.brand);
  const inspection =
    response.inspection && !response.inspection.is_served_version
      ? `<p class="callout blue"><span>${label("neutral", "inspection")} This is ${esc(versionName(response.served.version))}, shown for comparison. Players are served ${esc(versionName(response.inspection.served_version))}.</span></p>`
      : "";
  const failures = knownFailures(response, evaluation);
  if (response.outcome === "declined") {
    return {
      answer:
        `<div class="callout amber decline"><p data-decline>${label("amber", "declined")} <strong>Given ${title} on ${brand}, the service recommends nothing, and says why.</strong></p>` +
        `<p class="reason">${esc(response.decline.detail)}</p><p>A player would see nothing. <span class="small">Reason code ${mono(response.decline.reason)}</span></p></div>`,
      rest: `${inspection}${failures}${provenance(response)}`,
    };
  }
  const cards = response.results
    .map((entry, index) => {
      let common = "";
      if (neighbours !== undefined) {
        const shared = sharedLabels(anchor, neighbours[entry.game_id]);
        if (anchor?.fields === null) common = '<p class="why small">No labels in this version: only the two texts are alike.</p>';
        else if (shared.length === 0) common = '<p class="why small">No label in common: only the two texts are alike.</p>';
        else common = `<p class="why" data-shared><span class="small">in common</span> ${shared.map((held) => tag(held.method, held.label)).join(" ")}</p>`;
      }
      return `<li style="--i:${index}"><span class="rank num">${esc(entry.rank)}</span><div><strong>${esc(entry.title)}</strong> <span class="small">${esc(entry.provider)}</span>${common}</div></li>`;
    })
    .join("");
  const reading =
    neighbours === undefined
      ? ""
      : `<p class="small">The order is a similarity between two texts and cannot be traced to single labels. What a game has in common with the one played is shown to help read the list, not as the cause of its score. ${tag("model", "blue")} was added by the model, ${tag("table", "plain")} came from the supplier's tags.</p>`;
  const exact =
    `<div class="scroll"><table class="scores"><thead><tr><th class="num">Rank</th><th>Game</th><th>Identifier</th><th class="num">Score</th></tr></thead><tbody>` +
    `${response.results.map((entry) => `<tr><td class="num">${esc(entry.rank)}</td><td>${esc(entry.title)}</td><td>${mono(entry.game_id)}</td><td class="num">${esc(entry.score)}</td></tr>`).join("")}</tbody></table></div>`;
  return {
    answer: `<p class="lede">${label("green", "result")} Given <strong>${title}</strong> on <strong>${brand}</strong>, the service returns ${plural(response.results.length, "game that is", "games that are")} live there and cleared the similarity floor, highest score first. It promises nothing more about them.</p>`,
    rest: `${inspection}<ol class="results" data-results>${cards}</ol>${failures}${reading}${drawer("result-scores", "The exact scores and identifiers of these games", "", exact)}${provenance(response)}`,
  };
}

// ---------------------------------------------------------------------------
// 3 · Why these and not others
// ---------------------------------------------------------------------------

/**
 * What a game has to be to pass each filter, and which of three different things the filter decides.
 * A filter the console does not know keeps the service's own name and stands apart.
 */
const STEPS = {
  not_live_on_brand: { name: "Live on this brand", group: "eligible" },
  anchor_or_duplicate: { name: "Not the game itself", group: "eligible" },
  insufficient_data: { name: "Enough to compare", group: "eligible" },
  below_floor: { name: "Similar enough", group: "similar" },
  family_cap: { name: "One per family", group: "limit" },
  over_limit: { name: "Within the limit", group: "limit" },
};
const GROUPS = { eligible: "Which games may be shown at all", similar: "Which of them are similar enough", limit: "How many are shown", other: "Other steps" };
const stepName = (filter) => STEPS[filter]?.name ?? words(filter);
const stepGroup = (filter) => STEPS[filter]?.group ?? "other";

function scoreTable(trace) {
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
  return drawer(
    "scores",
    `Every score against the floor: ${plural(trace.scores.length, "candidate", "candidates")}`,
    "Each candidate's similarity to the game played. The tick on each bar is the similarity floor: a score under it is never shown to a player.",
    `<div class="scroll tall" tabindex="0" role="region" aria-label="Scores of every candidate"><table class="scores"><thead><tr><th class="num">Rank</th><th>Game</th><th class="num">Score</th><th>From 0 to 1</th></tr></thead><tbody>${rows}${floorDrawn ? "" : floorRow}</tbody></table></div>`,
  );
}

/**
 * Why these games and not others: the steps the trace gives, in its order, set out as the three
 * different things they decide. Eligibility is rules, the floor is a point in the spread of scores,
 * and the limit is a number: none of them is evidence that a player would find the result relevant.
 */
function path(response, focus) {
  const { trace } = response;
  if (trace.filters.length === 0) return { answer: '<p class="lede">The request was declined before any filter ran: no game was removed and none was scored.</p>', rest: "" };
  const start = trace.filters[0].removed.length + trace.filters[0].remaining;
  const shown = response.results.length;
  const bar = (remaining) => `<span class="track"><span class="fill" style="width:${width(start === 0 ? 0 : remaining / start)}"></span></span>`;
  let found = "";
  const node = (step, index) => {
    const name = stepName(step.filter);
    const hit = focus ? step.removed.find((entry) => entry.game_id === focus) : undefined;
    if (hit) found = `<p class="callout amber" data-focus><span>${label("amber", "removed")} <strong>${esc(hit.title)}</strong> was taken out at the step “${esc(name)}”: ${esc(words(hit.why))}.</span></p>`;
    const removed =
      step.removed.length === 0
        ? '<p class="small">This step removed nothing.</p>'
        : `<ul class="removed">${step.removed.map((entry) => `<li${entry.game_id === focus ? ' class="focus"' : ""}><span>${game(entry)}</span><span class="why">${esc(words(entry.why))}</span></li>`).join("")}</ul>`;
    return (
      `<button type="button" class="node step${step.removed.length === 0 ? " quiet" : ""}" style="--i:${index + 1}" aria-expanded="${hit ? "true" : "false"}" aria-controls="step-${index}" title="${esc(step.filter)}">` +
      `<span class="n num">${count(step.remaining)}</span><span class="name">${esc(name)}</span><span class="cut num">${step.removed.length === 0 ? "none removed" : `${count(step.removed.length)} removed`}</span>${bar(step.remaining)}</button>` +
      `<div id="step-${index}" class="step-panel"${hit ? "" : " hidden"}><p><strong>${esc(name)}.</strong> ${esc(step.rule)}</p>${removed}</div>`
    );
  };
  // Runs of neighbouring steps that decide the same thing, in the order the trace gives them.
  const runs = [];
  trace.filters.forEach((step, index) => {
    const group = stepGroup(step.filter);
    if (runs.at(-1)?.group !== group) runs.push({ group, steps: [] });
    runs.at(-1).steps.push({ step, index });
  });
  const says = (run) => {
    if (run.group === "eligible") return "Rules, not scores. A game that is not live on the brand is removed before anything is scored.";
    if (run.group === "similar") return `The floor is ${esc(trace.floor)}. ${esc(trace.floor_rule)} It is a point in the spread of scores: it says a game is closer than most pairs are, not that a player would find it relevant.`;
    if (run.group !== "limit") return "";
    const cut = run.steps.flatMap(({ step }) => step.removed);
    if (cut.length === 0) return "Every game that cleared the floor is shown.";
    if (cut.length > 3) return `${plural(cut.length, "game", "games")} cleared the floor and are not shown. Open a step to see them.`;
    return `Cleared the floor and not shown: ${cut.map((entry) => `<strong>${esc(entry.title)}</strong> (${esc(words(entry.why))})`).join(", ")}.`;
  };
  const groups = runs
    .map((run, at) => {
      const first = at === 0 ? `<div class="node start" style="--i:0"><span class="n num">${count(start)}</span><span class="name">In the catalogue</span><span class="cut">&nbsp;</span>${bar(start)}</div>` : "";
      const last =
        at === runs.length - 1 ? `<div class="node end${shown === 0 ? " none" : ""}" style="--i:${trace.filters.length + 1}"><span class="n num">${count(shown)}</span><span class="name">Shown</span><span class="cut">&nbsp;</span>${bar(shown)}</div>` : "";
      const nodes = run.steps.map(({ step, index }) => node(step, index)).join("");
      return `<div class="stage ${run.group}"><h3><span class="num">${at + 1}</span> ${GROUPS[run.group]}</h3><div class="path" style="--steps:${run.steps.length + (first ? 1 : 0) + (last ? 1 : 0)}">${first}${nodes}${last}</div><p class="small">${says(run)}</p></div>`;
    })
    .join("");
  if (focus && found === "") {
    const result = response.results.find((entry) => entry.game_id === focus);
    if (result) found = `<p class="callout green" data-focus><span>${label("green", "shown")} <strong>${esc(result.title)}</strong> passes every step here and is shown at rank ${esc(result.rank)}.</span></p>`;
  }
  // How many games each of the three things took out, counted from the trace's own lists.
  const took = (group) => runs.filter((run) => run.group === group).flatMap((run) => run.steps).reduce((sum, { step }) => sum + step.removed.length, 0);
  const parts = [
    ["eligible", "may not be shown at all"],
    ["similar", "are not similar enough"],
    ["limit", "are cut by the limit on how many are shown"],
  ]
    .filter(([group]) => runs.some((run) => run.group === group))
    .map(([group, says]) => `${took(group) === 0 ? "none" : count(took(group))} ${says}`);
  return {
    answer: `<p class="lede">Of the ${plural(start, "game", "games")} in the catalogue, ${shown === 0 ? "none is shown" : `${count(shown)} ${shown === 1 ? "is" : "are"} shown`}: ${parts.join(", ")}.</p>`,
    rest:
      `${found}<p class="small">Open a step to see what it removed.</p><div class="stages" role="group" aria-label="The steps from the catalogue to the result">${groups}</div>` +
      `${trace.scores.length === 0 ? "" : scoreTable(trace)}`,
  };
}

// ---------------------------------------------------------------------------
// 2 · What the model added
// ---------------------------------------------------------------------------

function absent(value) {
  if (value === null || value === undefined) return '<span class="absent">(none delivered)</span>';
  if (Array.isArray(value)) return value.length === 0 ? '<span class="absent">(empty list)</span>' : value.map((item) => mono(item)).join(" ");
  if (value === "") return '<span class="absent">(empty)</span>';
  return esc(typeof value === "object" ? JSON.stringify(value) : value);
}

const ref = (numbers) => (numbers.length === 0 ? "" : `<sup class="ref">${numbers.join(", ")}</sup>`);

/**
 * A text of the record with the words each label was read from marked in place, each mark followed by
 * the numbers of its labels. Returns the numbers that were placed, so a quote that is not found is said.
 */
function markedText(text, labels) {
  const spans = [];
  for (const entry of labels) {
    const start = entry.quote === "" ? -1 : text.indexOf(entry.quote);
    if (start !== -1) spans.push({ start, end: start + entry.quote.length, numbers: [entry.n] });
  }
  spans.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.numbers.push(...span.numbers);
    } else merged.push(span);
  }
  let html = "";
  let cursor = 0;
  for (const span of merged) {
    html += `${esc(text.slice(cursor, span.start))}<mark>${esc(text.slice(span.start, span.end))}</mark>${ref(span.numbers)}`;
    cursor = span.end;
  }
  return { html: html + esc(text.slice(cursor)), placed: spans.flatMap((span) => span.numbers) };
}

const sameTag = (a, b) => a === b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** One or two sentences on what happened to this record on its way into this version of the index. */
/** What the lookup table found in the supplier's tags for this record, whatever the version shown holds. */
const tableFound = (anchor) => anchor.steps.table.themes.length + anchor.steps.table.mechanics.length;
/** The fields the table left without a label: the reason a record counts as thin. */
const tableMissed = (anchor) => ["themes", "mechanics"].filter((field) => anchor.steps.table[field].length === 0);

/** One or two sentences on what happened to this record. Each is read from the record's own data, never assumed from the version. */
function story(anchor, version) {
  if (anchor.fields === null) return `${esc(versionName(version))} holds no labels: it indexes the supplier's text as it is.`;
  const held = heldLabels(anchor);
  const fromModel = held.filter((entry) => entry.method === "model").length;
  const fromTable = held.length - fromModel;
  const found = tableFound(anchor);
  const { conflict, model } = anchor.steps;
  const thin = anchor.thin ? `It found none for the ${tableMissed(anchor).join(" or ") || "record"}, so this record counts as thin.` : "";
  const sentences = [];
  if (conflict !== null) sentences.push(`A supplier tag says ${esc(words(conflict.tag_asserts))}, but the description says ${esc(conflict.description_states.map(words).join(", "))}. A lookup cannot tell which is right, so it asserts no mechanic.`);
  else if (found === 0) sentences.push(`The supplier's tags gave the lookup table no usable label${anchor.thin ? ", so this record counts as thin" : ""}.`);
  else sentences.push(`The lookup table read ${plural(found, "label", "labels")} from the supplier's tags${fromTable === 0 ? ", and this version holds none of them" : fromTable < found ? `, and this version holds ${count(fromTable)} of them` : ""}.${thin ? ` ${thin}` : ""}`);
  if (fromModel > 0) sentences.push(`The model read the text and added ${plural(fromModel, "label", "labels")}, each copied from the words it was read from.`);
  else if (!model.used) sentences.push("The model is not used for this record in this version.");
  else sentences.push("The model was asked, and this version holds no label from it.");
  return sentences.join(" ");
}

/**
 * What the supplier's structured fields held, what the index holds now, and one phrase the model read,
 * all visible without opening anything; then the supplier's text with every quoted phrase marked in place.
 */
function added(anchor, version) {
  const d = anchor.delivered;
  const { cleaned, table, conflict } = anchor.steps;
  const held = heldLabels(anchor).map((entry, index) => ({ ...entry, n: index + 1 }));
  const placed = new Set();
  const text = (field) => {
    if (typeof cleaned[field] !== "string") return absent(cleaned[field]);
    const marked = markedText(cleaned[field], held.filter((entry) => entry.source_field === field));
    for (const number of marked.placed) placed.add(number);
    return `<p class="copy">${marked.html}</p>`;
  };
  const tags = (field) => {
    if (!Array.isArray(d[field]) || d[field].length === 0) return absent(d[field]);
    return d[field]
      .map((delivered) => {
        const numbers = held.filter((entry) => entry.source_field === field && sameTag(entry.quote, delivered)).map((entry) => entry.n);
        for (const number of numbers) placed.add(number);
        if (conflict !== null && sameTag(conflict.tag, delivered)) return `<span class="sent"><span class="tag contradicted">${esc(delivered)}</span> <span class="small">contradicted by the description</span></span>`;
        const dropped = table.dropped.find((entry) => sameTag(entry.tag, delivered));
        if (dropped) return `<span class="sent"><span class="tag dropped">${esc(delivered)}</span> <span class="small">not about the game (${esc(words(dropped.reason))})</span></span>`;
        if (table.unknown.some((entry) => sameTag(entry.tag, delivered))) return `<span class="sent"><span class="tag unknown">${esc(delivered)}</span> <span class="small">unknown to the table, not guessed</span></span>`;
        return `<span class="sent"><span class="tag table">${esc(delivered)}</span>${ref(numbers)}</span>`;
      })
      .join(" ");
  };
  // The order matters: the fields are drawn first, so that every label knows whether its words were found.
  const fields = `<dl class="kv"><dt>features</dt><dd>${tags("features")}</dd><dt>themes</dt><dd>${tags("themes")}</dd><dt>tags</dt><dd>${tags("tags")}</dd></dl>`;
  const prose = `<dl class="kv"><dt>title</dt><dd>${text("title")}</dd><dt>description</dt><dd>${text("description")}</dd></dl>`;

  const fieldLine = (name, field) => {
    if (field.status !== "asserted") {
      const why = field.status === "conflict" ? "The supplier's tag and the description disagree, so nothing is asserted." : "Nothing in the record supports a label, so none is asserted.";
      return `<li><strong>${name}</strong><span>${label("amber", field.status === "conflict" ? "conflicting" : "abstained")} <span class="small">${why}</span></span></li>`;
    }
    const chips = held
      .filter((entry) => entry.field === name.toLowerCase())
      .map((entry) => {
        const textual = entry.source_field === "title" || entry.source_field === "description";
        const lost = textual && !placed.has(entry.n) ? ` ${label("amber", "words not found in the record")}` : "";
        return `<span class="sent">${tag(entry.method, entry.label)}${placed.has(entry.n) ? ref([entry.n]) : ""}${lost}</span>`;
      })
      .join(" ");
    return `<li><strong>${name}</strong><span>${chips}</span></li>`;
  };
  const holds =
    anchor.fields === null
      ? `<p>${label("neutral", "no labels")} This version indexes the supplier's text as it is.</p>`
      : `<ul class="fields">${fieldLine("Themes", anchor.fields.themes)}${fieldLine("Mechanics", anchor.fields.mechanics)}</ul>` +
        `<p class="small">${tag("model", "blue")} was added by the model, ${tag("table", "plain")} by the lookup table. A number joins a label to the words it was read from.</p>`;

  // One phrase the model read, as the shortest proof that a label of its own rests on the record's words.
  const fromModel = held.filter((entry) => entry.method === "model" && placed.has(entry.n)).sort((a, b) => a.quote.length - b.quote.length)[0];
  const phrase =
    fromModel === undefined
      ? '<p class="small">The index holds no label from the model for this record, so there is no phrase to show.</p>'
      : `<blockquote data-phrase>“${esc(fromModel.quote)}”</blockquote><p>${tag("model", fromModel.label)}${ref([fromModel.n])} <span class="small">read from the ${esc(fromModel.source_field)}</span></p>`;

  return {
    answer: `<p class="lede" data-story>${story(anchor, version)}</p>`,
    rest:
      `<div class="trio"><div class="card"><h3>The supplier's structured fields</h3>${fields}</div><div class="card holds"><h3>What ${esc(versionName(version))} holds</h3>${holds}</div><div class="card phrase"><h3>One phrase the model read</h3>${phrase}</div></div>` +
      `${drawer("marked-text", "The supplier's text, with the words each label was read from", "", prose)}${steps(anchor, version)}${rawRecord(anchor)}`,
  };
}

function rawRecord(anchor) {
  const d = anchor.delivered;
  const rows = [["title", d.title], ["provider", d.provider], ["category", d.category], ["description", d.description], ["features", d.features], ["themes", d.themes], ["tags", d.tags], ...Object.entries(d.facts)];
  const status = anchor.status_on_brand === "live" ? label("green", "live on this brand") : label("amber", `${words(anchor.status_on_brand)} on this brand`);
  return drawer(
    "raw-record",
    "The raw record, exactly as the supplier delivered it",
    `Source row ${mono(d.source_record_id)}. ${status}`,
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

/** Every step of enrichment for this record, with the model and prompt behind each of the model's labels. */
function steps(anchor, version) {
  const { table, model, conflict, cleaned } = anchor.steps;
  const step = (kind, number, name, who, body) => `<li class="${kind}"><div class="sh"><span class="n">Step ${number}</span><h4>${name}</h4>${who}</div>${body}</li>`;
  const list = [];
  list.push(step("code", 1, "Cleaning", label("neutral", "code only"), `<p class="small">Title: ${esc(cleaned.title)}. Description: ${cleaned.description === null ? "none delivered" : "kept word for word, with any markup removed"}.</p>`));

  let tableBody = evidenceList([...table.themes, ...table.mechanics], "Labels the table found in the delivered tags");
  if (table.dropped.length > 0) tableBody += `<p class="small">Dropped as not an attribute of the game: ${table.dropped.map((entry) => `${mono(entry.tag)} (${esc(words(entry.reason))})`).join(", ")}.</p>`;
  if (table.unknown.length > 0) tableBody += `<p class="small">Unknown to the table, and not guessed: ${table.unknown.map((entry) => mono(entry.tag)).join(", ")}.</p>`;
  if (conflict !== null) tableBody += conflictNote(conflict);
  list.push(step("code", 2, "Synonym table", label("neutral", "a lookup, no model"), tableBody));

  const thin = anchor.thin
    ? `${label("amber", "thin")} The table left this record without a usable label for its ${tableMissed(anchor).join(" or ") || "themes or its mechanics"}.`
    : tableMissed(anchor).length === 0
      ? "The table found labels for both fields, so the record is not thin."
      : "The rule does not count this record as thin.";
  list.push(step("code", 3, "Thin rule", label("neutral", "a rule"), `<p>${thin}</p>`));

  const used = model.used ? label("blue", "used in this version") : label("neutral", "not used in this version");
  let modelBody =
    `<p>${used} <span class="small">The model was asked once for this record, offline, and its answer is stored. No model is called when a request arrives.</span></p>` +
    evidenceList([...model.themes, ...model.mechanics], "Labels the model asserted, each with the words it copied from the record");
  if (model.stripped.length > 0) modelBody += `<p class="small">Stripped from the model's answer: ${model.stripped.map((entry) => `${esc(entry.label)} (${esc(words(entry.reason))})`).join(", ")}.</p>`;
  list.push(step("model", 4, "Model", label("blue", "asked offline"), modelBody));

  const fieldLine = (name, field) => {
    if (field.status === "asserted") return `<li><strong>${esc(name)}</strong> ${field.labels.map((entry) => tag(entry.method, entry.label)).join(" ")}</li>`;
    const why = field.status === "conflict" ? `conflicting: ${words(field.conflict_reason ?? "")}. No label is asserted.` : "abstained: nothing in the record supports a label.";
    return `<li><strong>${esc(name)}</strong> ${label("amber", field.status === "conflict" ? "conflicting" : "abstained")} <span class="small">${esc(why)}</span></li>`;
  };
  const fields =
    anchor.fields === null
      ? `<p>${label("neutral", "no labels")} ${esc(versionName(version))} embeds the delivered text as it is and asserts no label.</p>`
      : `<ul class="fields">${fieldLine("Themes", anchor.fields.themes)}${fieldLine("Mechanics", anchor.fields.mechanics)}</ul>`;
  list.push(`<li class="holds"><div class="sh"><h4>What ${esc(versionName(version))} holds for this record</h4></div>${fields}<p class="small">The text that was embedded:</p><pre>${esc(anchor.text)}</pre></li>`);

  return drawer("steps", "Step by step: cleaning, lookup table, thin rule, model", "Who did what to this record, with the model and the prompt behind each of the model's labels.", `<ol class="steps">${list.join("")}</ol>`);
}

// ---------------------------------------------------------------------------
// One request: the three answers, then where it came from
// ---------------------------------------------------------------------------

function provenance(response) {
  const timings = response.trace ? Object.entries(response.trace.timings_ms).map(([stage, ms]) => `${esc(words(stage))} ${esc(ms)} ms`).join(" · ") : "";
  return drawer("provenance", "Index, version and timings of this request", "", `<p class="provenance">Index ${mono(response.served.index_hash.slice(0, 12))} · version ${mono(response.served.version)} · ${timings}.</p>`);
}

/**
 * One response of /api/recommendations or /api/inspect: the result or the decline first, the evidence beneath it.
 *
 * Everything in `extras` is optional and comes from this service too:
 * `neighbours` maps each recommended game to its own record in the same version, for what it has in common;
 * `versions` maps each version to its answer to the same request; `evaluation` is the evaluation;
 * `focus` is a game to point out on the path; `look` is the line an example brought with it.
 */
export function renderTrace(response, extras = {}) {
  const anchor = response.trace?.anchor ?? null;
  const none = (why) => ({ answer: `<p class="lede">${why}</p>`, rest: "" });
  const panes = {
    shown: shown(response, extras),
    added: anchor === null ? none("The index holds no record of this game, so there is nothing the model could have added.") : added(anchor, response.served.version),
    removed: anchor === null ? none("The request was declined before any filter ran: no game was removed and none was scored.") : path(response, extras.focus),
    worth: { answer: `<p class="lede">${servedFacts(extras.evaluation)}</p>`, rest: worth(response, extras) },
  };
  const open = sectionOf(extras.section);
  return SECTIONS.map((section, index) => pane(section, index + 1, open, response, extras.look, panes[section.id])).join("");
}

/** 4 · Which version is served, and what the evaluation measured for it. The words are the report's numbers. */
function servedFacts(evaluation) {
  if (evaluation === undefined) return "The evaluation is not loaded in this view, so it cannot say which version is served.";
  const { report, verdict } = evaluation;
  const served = verdict.ships;
  if (served === null) return `${label("red", "not serving")} <strong>Nothing is served.</strong> No version passes the release gate.`;
  const row = report.matching[served];
  const without = Object.keys(report.matching).filter((version) => report.matching[version].cost.model_calls === 0);
  const best = without.length === 0 ? null : Math.max(...without.map((version) => report.matching[version].pairwise.pooled.rate));
  return (
    `${label("green", "served")} <strong>${esc(versionName(served))}</strong> is the version served. It ${report.decision.versions[served]?.passed ? "passes every pass mark" : "does not pass every pass mark"}, ` +
    `puts ${pct(row.pairwise.pooled.rate)} of the pairs of games it was tested on in the right order, and took ${plural(row.cost.model_calls, "model call", "model calls")}, an estimated $${esc(row.cost.estimated_usd.toFixed(4))}, to build.` +
    `${best === null || row.cost.model_calls === 0 ? "" : ` The best version built without the model reaches ${pct(best)}.`}`
  );
}

/** The options of the brand picker. A brand an address names and the catalogue does not hold keeps an option, so the request goes out as written. */
export function brandOptions(catalogue, asked) {
  const options = catalogue.brands.map((entry) => ({ value: entry.brand, text: entry.brand }));
  if (asked && !catalogue.brands.some((entry) => entry.brand === asked)) options.unshift({ value: asked, text: `${asked} · not a brand of this catalogue` });
  return options;
}

/** The options of the version picker, with the same rule for a version an address names and the index does not have. */
export function versionOptions(catalogue, asked) {
  const options = catalogue.versions.map((version) => ({ value: version, text: version === catalogue.served.version ? `${versionName(version)} (served)` : `${versionName(version)} (inspection only)` }));
  if (asked && !catalogue.versions.includes(asked)) options.unshift({ value: asked, text: `${asked} · not a version of this index` });
  return options;
}

/**
 * What an address asks for. A game, brand or version it names is kept exactly as written, so the service answers
 * for that and says what is wrong with it. What it leaves out is the picker's first choice. Null when it names no request.
 */
export function addressRequest(search, catalogue) {
  const asked = new URLSearchParams(search);
  const point = { section: sectionOf(asked.get("section")), focus: asked.get("focus"), open: asked.get("open") };
  if (!asked.has("game") && !asked.has("brand") && !asked.has("version")) return { ...point, game: null, brand: null, version: null };
  const brand = asked.get("brand") ?? catalogue.brands[0]?.brand ?? "";
  return { ...point, brand, game: asked.get("game") ?? gameOptions(catalogue, brand, null)[0]?.value ?? "", version: asked.get("version") ?? catalogue.served.version };
}

/**
 * Keeps a late answer off the page. Call it when work for a place starts; the function it returns says
 * whether that work is still the latest started for that place.
 */
export function turns() {
  const latest = new Map();
  return (place) => {
    const mine = (latest.get(place) ?? 0) + 1;
    latest.set(place, mine);
    return () => latest.get(place) === mine;
  };
}

/**
 * The options of the game picker for one brand. A game that a link asks for and the index does not hold
 * gets an option of its own, so that the request is sent as asked and the service's decline is what is shown.
 */
export function gameOptions(catalogue, brand, asked) {
  // A picker names a game by its title. Two games that share a title are told apart by their supplier, and then by their identifier.
  const sharing = (key) => {
    const seen = new Map();
    for (const entry of catalogue.games) seen.set(key(entry), (seen.get(key(entry)) ?? 0) + 1);
    return (entry) => seen.get(key(entry)) > 1;
  };
  const sameTitle = sharing((entry) => entry.title);
  const sameTitleAndProvider = sharing((entry) => `${entry.title}\n${entry.provider}`);
  const options = catalogue.games.map((entry) => ({
    value: entry.game_id,
    text: !sameTitle(entry) ? entry.title : sameTitleAndProvider(entry) ? `${entry.title} (${entry.provider}, ${entry.game_id})` : `${entry.title} (${entry.provider})`,
  }));
  if (asked && !catalogue.games.some((entry) => entry.game_id === asked)) options.unshift({ value: asked, text: `${asked} · not in the index` });
  return options;
}

/**
 * Fetches and renders one request. `get` is the only way a view reaches data.
 * With `request.versions` it also asks every other version, to say beside the result what changes without the model.
 */
export async function traceView(get, request) {
  const params = { game: request.game, brand: request.brand };
  const response =
    request.version === undefined || request.version === request.served
      ? await get(url("/api/recommendations", { ...params, trace: "1" }))
      : await get(url("/api/inspect", { ...params, version: request.version }));
  // Each recommended game's own record in the same version, to show what it has in common with the game played.
  const neighbours = {};
  for (const entry of response.results) neighbours[entry.game_id] = await get(url("/api/inspect", { game: entry.game_id, brand: request.brand, version: response.served.version }));
  let versions;
  if (request.versions !== undefined) {
    versions = {};
    for (const version of request.versions) versions[version] = version === response.served.version ? response : await get(url("/api/inspect", { ...params, version }));
  }
  return renderTrace(response, { neighbours, versions, evaluation: request.evaluation, focus: request.focus, look: request.look, section: request.section });
}

// ---------------------------------------------------------------------------
// Examples: one game for each thing worth seeing, found in the service's own responses
// ---------------------------------------------------------------------------

/** How many requests one search may make before it gives up and says it found none. */
const SEARCH_LIMIT = 40;

const EXAMPLES = [
  ["thin", "A thin record gains labels"],
  ["plain", "Already well described: the model adds nothing"],
  ["conflict", "A tag contradicts the description"],
  ["filter", "A plausible game is removed"],
  ["decline", "A decline instead of a guess"],
  ["versions", "The versions disagree"],
  ["failure", "A failure the evaluation found"],
];

/**
 * Looks through the catalogue and the evaluation for one game that shows each of the five things.
 * No game is named in the code: change the catalogue and the examples change with it. An example the
 * data does not hold is returned as not found, and shown as such.
 */
export async function findExamples(get, catalogue, evaluation) {
  const home = [...catalogue.brands].sort((a, b) => b.live - a.live)[0]?.brand;
  const byId = new Map(catalogue.games.map((entry) => [entry.game_id, entry]));
  const liveOn = (entry, brand) => entry?.status[brand] === "live";
  const served = catalogue.served.version;
  const link = (params) => `/?${new URLSearchParams(params)}`;
  const recommend = (id, brand, trace) => get(url("/api/recommendations", trace ? { game: id, brand, trace: "1" } : { game: id, brand }));

  const finders = {
    /** Among the thin records that are live and get results, the one the model added most labels to. */
    async thin() {
      let asked = 0;
      let best = null;
      for (const entry of catalogue.games) {
        if (!entry.thin || entry.conflict || entry.evidence === "none" || !liveOn(entry, home)) continue;
        if ((asked += 1) > SEARCH_LIMIT) break;
        const response = await recommend(entry.game_id, home, true);
        const fromModel = heldLabels(response.trace?.anchor).filter((held) => held.method === "model").length;
        if (response.outcome === "results" && fromModel > (best?.fromModel ?? 0)) best = { entry, fromModel, found: tableFound(response.trace.anchor) };
      }
      if (best === null) return null;
      const { entry, fromModel } = best;
      return { game: entry.game_id, brand: home, section: "added", href: link({ game: entry.game_id, brand: home, section: "added" }), note: `The supplier's tags gave ${best.found === 0 ? "no label" : plural(best.found, "label", "labels")}, and the model added ${fromModel} from the text.` };
    },
    async filter() {
      let asked = 0;
      for (const { brand: other } of [...catalogue.brands].filter((entry) => entry.brand !== home).sort((a, b) => b.live - a.live)) {
        for (const entry of catalogue.games) {
          if (!liveOn(entry, home) || !liveOn(entry, other)) continue;
          if ((asked += 1) > SEARCH_LIMIT) return null;
          const best = (await recommend(entry.game_id, other, false)).results[0];
          if (best === undefined || liveOn(byId.get(best.game_id), home)) continue;
          const here = await recommend(entry.game_id, home, true);
          const removed = here.trace?.filters.flatMap((step) => step.removed).find((gone) => gone.game_id === best.game_id);
          if (removed === undefined) continue;
          return {
            game: entry.game_id,
            brand: home,
            focus: best.game_id,
            href: link({ game: entry.game_id, brand: home, section: "removed", focus: best.game_id }),
            section: "removed",
            note: `${best.title} is its top result on ${other}, and is ${words(removed.why)} on ${home}.`,
          };
        }
      }
      return null;
    },
    /** A live game the service declines: a record with nothing in it first, and one the evaluation lists no failure for, so the example shows one thing. */
    async decline() {
      let asked = 0;
      const failed = new Set((evaluation?.report.gallery.real ?? []).map((entry) => entry.game_id));
      const order = (entry) => (entry.evidence === "none" ? 0 : 2) + (failed.has(entry.game_id) ? 1 : 0);
      for (const entry of catalogue.games.filter((entry) => liveOn(entry, home)).sort((a, b) => order(a) - order(b))) {
        if ((asked += 1) > SEARCH_LIMIT) break;
        const response = await recommend(entry.game_id, home, false);
        if (response.outcome === "declined") return { game: entry.game_id, brand: home, section: "shown", href: link({ game: entry.game_id, brand: home, section: "shown" }), note: `The service declines to recommend: ${words(response.decline.reason)}.` };
      }
      return null;
    },
    async conflict() {
      const listed = (evaluation?.report.conflict_games.games ?? []).filter((entry) => liveOn(byId.get(entry.game_id), home));
      const pick = listed.find((entry) => entry.mechanics[served]?.status === "asserted") ?? listed[0];
      if (pick === undefined) return null;
      return { game: pick.game_id, brand: home, section: "added", href: link({ game: pick.game_id, brand: home, section: "added" }), note: `The tag says ${words(pick.tag_asserts)}, the description says ${pick.description_states.map(words).join(", ")}.` };
    },
    /** Among the evaluation's check games, the one whose list changes most between the first version and the served one. */
    async versions() {
      const check = evaluation?.report.check_games;
      const names = Object.keys(check?.results ?? {});
      const ids = (version, index) => (check.results[version]?.[index]?.results ?? []).map((entry) => entry.game_id);
      let best = null;
      for (const [index, anchor] of (check?.results[served] ?? []).entries()) {
        if (!byId.has(anchor.anchor)) continue;
        const [first, mine] = [ids(names[0], index), ids(served, index)];
        const changed = first.filter((id) => !mine.includes(id)).length + mine.filter((id) => !first.includes(id)).length;
        if (changed > (best?.changed ?? 0)) best = { anchor: anchor.anchor, changed, first: first.length, mine: mine.length };
      }
      if (best === null) return null;
      return {
        game: best.anchor,
        brand: check.brand,
        section: "worth",
        href: link({ game: best.anchor, brand: check.brand, section: "worth", open: "versions" }),
        note: `${plural(best.first, "game", "games")} from ${versionName(names[0])}, ${best.mine} from ${versionName(served)}, not all the same.`,
      };
    },
    /** A record the supplier described well: the table's labels were enough, and this version holds none from the model. */
    async plain() {
      let asked = 0;
      for (const entry of catalogue.games) {
        if (entry.thin || entry.conflict || entry.evidence !== "description" || !liveOn(entry, home)) continue;
        if ((asked += 1) > SEARCH_LIMIT) break;
        const response = await recommend(entry.game_id, home, true);
        const held = heldLabels(response.trace?.anchor);
        if (response.outcome === "results" && held.length > 0 && held.every((label) => label.method !== "model")) {
          return { game: entry.game_id, brand: home, section: "added", href: link({ game: entry.game_id, brand: home, section: "added" }), note: `The supplier's tags already gave ${plural(held.length, "label", "labels")}; the model adds nothing.` };
        }
      }
      return null;
    },
    /** One of the real failures the evaluation lists, on a brand where the game is live if there is one. */
    async failure() {
      const real = (evaluation?.report.gallery.real ?? []).filter((entry) => byId.has(entry.game_id));
      // The brand the evaluation found it on, when it is about a request; otherwise a brand the game is live on.
      const where = (entry) =>
        entry.detail?.brand ?? (entry.detail?.result ? evaluation.report.check_games.brand : liveOn(byId.get(entry.game_id), home) ? home : (catalogue.brands.find((brand) => liveOn(byId.get(entry.game_id), brand.brand))?.brand ?? home));
      const pick = real.find((entry) => where(entry) === home && liveOn(byId.get(entry.game_id), home)) ?? real[0];
      if (pick === undefined) return null;
      const brand = where(pick);
      const version = pick.version && pick.version !== served ? { version: pick.version } : {};
      return { game: pick.game_id, brand, section: "shown", href: link({ game: pick.game_id, brand, section: "shown", ...version }), note: `${String(pick.what).split(". ")[0].replace(/\.$/, "")}.` };
    },
  };

  const examples = [];
  for (const [kind, name] of EXAMPLES) {
    const found = home === undefined ? null : await finders[kind]();
    examples.push(found === null ? { kind, name, found: false, note: "No game in this catalogue shows it." } : { kind, name, found: true, ...found });
  }
  return examples;
}

/** The examples as links. `current` is the page's own query string, so the open example is marked. */
export function renderExamples(examples, current) {
  const items = examples
    .map((example) => {
      const inner = `<strong>${esc(example.name)}</strong><span class="small">${esc(example.note)}</span>`;
      if (!example.found) return `<li class="missing">${inner}</li>`;
      const here = current !== undefined && example.game === current.game && example.brand === current.brand;
      return `<li><a href="${esc(example.href)}" data-example="${esc(example.kind)}"${here ? ' aria-current="true"' : ""}>${inner}</a></li>`;
    })
    .join("");
  return `<ol class="examples">${items}</ol>`;
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
// Was the model worth it: the verdict, one chart, and the detail behind it in drawers
// ---------------------------------------------------------------------------

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
    .map((entry) => `<details><summary>${esc(words(entry.kind))} · ${esc(entry.title)} ${mono(entry.game_id)}${entry.version ? ` <span class="small">in ${esc(versionName(entry.version))}</span>` : ""}</summary><p>${esc(entry.what)}</p>${detailList(entry.detail)}</details>`)
    .join("");
}

export function renderEvaluation(evaluation) {
  const { report, verdict } = evaluation;
  const versions = Object.keys(report.matching);
  const decision = report.decision;
  const out = [];

  // The fourth section states which version is served. Here: the gate's own words, and the state of the owner's check.
  const served = verdict.ships;
  const ownerTone = report.owner_check.status === "answered" ? "green" : "amber";
  const gate = drawer(
    "verdict",
    `The release gate's verdict in its own words, and the owner's check (${esc(report.owner_check.status)})`,
    "",
    `<p>${served === null ? label("red", "not serving") : label("green", "served")} ${esc(verdict.reason)}</p>` +
      `<p class="small">${label(ownerTone, `owner's check ${report.owner_check.status}`)} ${esc(report.owner_check.note)}</p>`,
  );

  const detailRows = versions
    .map((version) => {
      const row = report.matching[version];
      return (
        `<tr><th scope="row">${esc(versionName(version))}</th><td class="num">${share(row.pairwise.pooled)}</td><td class="num">${pct(row.pairwise.per_game.mean)}<span class="small">${count(row.pairwise.per_game.games)} games</span></td>` +
        `<td class="num">${count(row.wrongly_shown.count)}<span class="small">of ${count(row.wrongly_shown.results_judged)} judged</span></td><td class="num">${count(row.cost.model_calls)}</td><td class="num">$${esc(row.cost.estimated_usd.toFixed(4))}</td><td class="num">${esc(row.cost.seconds.toFixed(1))} s</td></tr>`
      );
    })
    .join("");
  const markRows = evaluation.marks
    .map((mark) => {
      const cells = versions
        .map((version) => {
          const result = decision.versions[version].marks?.find((entry) => entry.mark === mark.id);
          if (result === undefined) return '<td class="num">–</td>';
          if (!result.applies) return `<td class="num">${label("neutral", "does not apply")}</td>`;
          return `<td class="num">${passLabel(result.pass)}<span class="small">measured ${esc(result.measured === null ? "nothing" : result.measured)}</span></td>`;
        })
        .join("");
      const committed = evaluation.thresholds[mark.group]?.[mark.key];
      return `<tr><th scope="row">${esc(mark.label)}<span class="small">${mark.direction === "min" ? "at least" : "at most"} ${esc(committed ?? "")}</span></th>${cells}</tr>`;
    })
    .join("");
  const versionHeads = (list) => list.map((version) => `<th scope="col" class="num">${esc(versionName(version))}${version === served ? `<br>${label("green", "served")}` : ""}</th>`).join("");
  // How many model calls built each version: a split by kind of record must not be read as the model's work where it was never called.
  const calls = versions.map((version) => `${esc(versionName(version))} ${count(report.matching[version].cost.model_calls)}`).join(", ");
  out.push(
    `<p class="callout" data-limits><span>${label("neutral", "what this does not show")} The catalogue is fictional and its answer key is the generator's own plan, not a judgement by people. ` +
      `The stronger limit: the catalogue's text was written by the same model that does the enrichment, so that model is reading its own kind of writing, and the reviewer is a model too. ` +
      `These numbers show direction and the absence of glaring failure, not production accuracy. Costs are estimates.</span></p>` +
      `<p><button type="button" id="what-if-open" class="icon" aria-expanded="false" aria-controls="what-if" title="Explore other pass marks">${GEAR}<span>What if the pass marks were different?</span></button></p><div id="what-if" hidden></div>`,
    gate,
    drawer(
      "pass-marks",
      "Every pass mark, version by version",
      `The marks the release gate applies, as committed in ${mono(evaluation.thresholds_file)} (decided ${esc(evaluation.thresholds.decided_on)}), and what each version measured.`,
      `<div class="scroll"><table class="measures"><thead><tr><th scope="col">Pass mark</th>${versionHeads(versions)}</tr></thead><tbody>${markRows}</tbody></table></div>`,
    ),
    drawer(
      "race",
      "The numbers behind the table of the four versions",
      `Counts beside every rate. Verdict for index ${mono(verdict.index_hash.slice(0, 12))}.`,
      `<div class="scroll"><table><thead><tr><th>Version</th><th class="num">Pairs in the right order</th><th class="num">Mean per game</th><th class="num">Wrongly shown</th><th class="num">Model calls</th><th class="num">Est. cost</th><th class="num">Call time</th></tr></thead><tbody>${detailRows}</tbody></table></div>` +
        `<p class="small">Check games on ${esc(report.check_games.brand)}: ${report.check_games.games.map(mono).join(" ")}. A result is wrongly shown when the rule calls it unrelated and the reviewer also says no.</p>`,
    ),
  );

  const conditions = [
    ["by_condition", "description", "Has a description"],
    ["by_condition", "tags_only", "Tags only"],
    ["by_condition", "none", "Nearly empty"],
    ["by_thin", "thin", "Thin"],
    ["by_thin", "not_thin", "Not thin"],
  ];
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
    drawer(
      "where-it-helps",
      "The same result, split by the condition of the record",
      `Pairwise accuracy, mean per game, split by what the record that was asked about had to offer. A game's score depends on every other record in the index as well, so a row can move in a version that never ran the model on that kind of record. Model calls per version, for ${count(report.games)} games: ${calls}. A difference in a row is not, by itself, the model's work on those records.`,
      `<div class="scroll"><table class="by-condition"><thead><tr><th scope="col">Record</th>${versionHeads(versions)}</tr></thead><tbody>${helpRows}</tbody></table></div>`,
    ),
  );

  const labelled = Object.keys(report.enrichment);
  const of = (value) => `${count(value.count)} <span class="small">of ${count(value.of)}</span>`;
  const precision = (row) => {
    const held = row.precision.left_out.held_back;
    return held === 0 ? share(row.precision) : `${share(row.precision)}<span class="small">${esc(held)} held back; counted as wrong for the pass mark: ${esc(row.precision.gate.count)} of ${esc(row.precision.gate.of)}</span>`;
  };
  const measures = [
    ["Precision", "Of the labels asserted, the share that are correct", precision],
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
    drawer(
      "enrichment-measures",
      "Is enrichment safe to automate? Label measures, tag conflicts and the reviewer",
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
        `<h4>The reviewer, ${mono(report.reviewer.model)}</h4><p>Control: it agreed with the plan on ${esc(control.agreed)} of ${esc(control.reported)} labels where the plan and the pipeline agree (${esc(control.applies.agreed)} of ${esc(control.applies.of)} where the label applies, ${esc(control.does_not_apply.agreed)} of ${esc(control.does_not_apply.of)} where it does not). ` +
        `Of ${esc(report.reviewer.answered)} answers: ${esc(report.reviewer.answers.yes)} yes, ${esc(report.reviewer.answers.no)} no, ${esc(report.reviewer.answers.unclear)} unclear.</p>` +
        (report.reviewer.held_back === 0
          ? ""
          : `<p data-held-back>${label("amber", "held back")} ${esc(report.reviewer.held_back)} of the reviewer's ${esc(report.reviewer.questions)} answers are the owner's check questions (${esc(control.held_back)} of the ${esc(control.size)} control labels among them). They are held out of the working tree, not erased from the repository's history, and are in no count on this page until the owner has answered. The check rests on his not looking them up first.</p>`) +
        (report.owner_check.questions.length === 0
          ? ""
          : `<div class="scroll"><table><caption>The owner's check</caption><thead><tr><th>Question</th><th>From</th><th>Owner</th><th>Reviewer</th><th>Match</th><th>Answered blind</th></tr></thead><tbody>${report.owner_check.questions
              .map((entry) => `<tr><td>${mono(entry.question_id)}</td><td>${esc(entry.source)}</td><td>${esc(entry.owner)}</td><td>${esc(entry.reviewer)}</td><td>${entry.matched ? label("green", "match") : label("amber", "differs")}</td><td>${entry.blind ? "yes" : label("amber", "no: told the reviewer's answer first")}</td></tr>`)
              .join("")}</tbody></table></div>`) +
        (report.reviewer.unclear.length === 0 ? "" : `<p class="small">Recorded as unclear: ${report.reviewer.unclear.map((entry) => `${mono(entry.question_id)} (${esc(words(entry.note ?? "it said unclear"))})`).join(", ")}.</p>`),
    ),
  );

  out.push(
    drawer(
      "gallery",
      "Failures: what went wrong, and what was planted on purpose",
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
// States that are not a request
// ---------------------------------------------------------------------------

export const renderEmpty = () => '<p class="lede">Choose a game and a brand, or open an example. The page will show what the system would recommend, and why.</p>';
export const renderLoading = () => "<p>Loading</p>";
export const renderBadInput = (message) => `<p>${label("amber", "bad request")} ${esc(message)}</p>`;
export const renderFailed = (message) => `<p>${label("red", "failed")} ${esc(message)} Nothing is shown because nothing was received.</p>`;
