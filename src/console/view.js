// The console's views: plain functions from the service's responses to HTML text.
//
// Nothing here computes a score, a label or a verdict. Every value shown is read from a
// response of this service, fetched through the `get` function a view is given, and every
// piece of text from a response is escaped before it reaches the page: catalogue text is data.
// The same file runs in the browser and under the tests, which is why it touches no DOM.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const label = (tone, text) => `<span class="label ${tone}">${esc(text)}</span>`;
const mono = (text) => `<code>${esc(text)}</code>`;
const words = (term) => String(term).replaceAll("_", " ");
const game = (entry) => `${esc(entry.title)} <span class="small">${mono(entry.game_id)} · ${esc(entry.provider)}</span>`;

function section(id, kicker, heading, lede, body) {
  return `<section id="${id}" class="section"><p class="kicker">${esc(kicker)}</p><h3>${esc(heading)}</h3><p class="lede">${lede}</p>${body}</section>`;
}

const VERSION_NAMES = { raw: "Raw text", table: "Synonym table", model_where_thin: "Model where thin", model_everywhere: "Model everywhere" };
export const versionName = (version) => VERSION_NAMES[version] ?? version;

// ---------------------------------------------------------------------------
// Trace: one request, top to bottom
// ---------------------------------------------------------------------------

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
    ...Object.entries(d.facts).map(([key, value]) => [key, value]),
  ];
  const status = anchor.status_on_brand === "live" ? label("green", "live on this brand") : label("ochre", `${words(anchor.status_on_brand)} on this brand`);
  return section(
    "raw-record",
    "1 · What went in",
    "Raw record",
    `The record as the source delivered it, source row ${mono(d.source_record_id)}. ${status}`,
    `<dl class="raw">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${absent(value)}</dd>`).join("")}</dl>`,
  );
}

function evidenceRow(entry) {
  const method = entry.method === "model" ? `model ${esc(entry.model ?? "")}, prompt ${esc(entry.prompt_version ?? "")}` : "synonym table";
  return `<tr><td>${label("plum", words(entry.label))}</td><td class="quote">“${esc(entry.quote)}”</td><td>${label("slate", entry.source_field)}</td><td class="small">${method}</td></tr>`;
}

function evidenceTable(labels, caption) {
  if (labels.length === 0) return `<p class="small">${esc(caption)}: nothing.</p>`;
  return `<div class="scroll"><table><caption>${esc(caption)}</caption><thead><tr><th>Label</th><th>The words it quoted</th><th>Field</th><th>Added by</th></tr></thead><tbody>${labels.map(evidenceRow).join("")}</tbody></table></div>`;
}

function fieldLine(name, field) {
  if (field.status === "asserted") return `<li><strong>${esc(name)}</strong> ${field.labels.map((entry) => label(entry.method === "model" ? "plum" : "slate", words(entry.label))).join(" ")}</li>`;
  const why = field.status === "conflict" ? `conflicting: ${words(field.conflict_reason ?? "")}. No label is asserted.` : "abstained: nothing in the record supports a label.";
  return `<li><strong>${esc(name)}</strong> ${label("ochre", field.status === "conflict" ? "conflicting" : "abstained")} <span class="small">${esc(why)}</span></li>`;
}

function enrichment(anchor, version) {
  const { table, model, conflict, cleaned } = anchor.steps;
  const parts = [];
  parts.push(`<h4>Step 1 · Cleaning <span class="small">code only</span></h4><p class="small">Title: ${esc(cleaned.title)}. Description: ${cleaned.description === null ? "none" : "markup removed, words unchanged"}.</p>`);
  parts.push(`<h4>Step 2 · Synonym table <span class="small">a lookup, no model</span></h4>${evidenceTable([...table.themes, ...table.mechanics], "Labels the table found in the delivered tags")}`);
  if (table.dropped.length > 0) parts.push(`<p class="small">Dropped as not an attribute of the game: ${table.dropped.map((entry) => `${mono(entry.tag)} (${esc(words(entry.reason))})`).join(", ")}.</p>`);
  if (table.unknown.length > 0) parts.push(`<p class="small">Unknown to the table, and not guessed: ${table.unknown.map((entry) => mono(entry.tag)).join(", ")}.</p>`);
  if (conflict !== null) {
    parts.push(
      `<p>${label("ochre", "conflicting")} The tag ${mono(conflict.tag)} asserts ${esc(words(conflict.tag_asserts))}, and the description says “${esc(conflict.description_quote)}” (${esc(conflict.description_states.map(words).join(", "))}). Code cannot tell which is right, so no mechanic is asserted.</p>`,
    );
  }
  const thin = anchor.thin ? `${label("ochre", "thin")} The table left this record without a usable label for its themes or its mechanics.` : "The table found labels for both fields, so the record is not thin.";
  parts.push(`<h4>Step 3 · Thin rule</h4><p>${thin}</p>`);
  const modelLabels = [...model.themes, ...model.mechanics];
  const used = model.used ? `${label("plum", "used in this version")}` : `${label("neutral", "not used in this version")}`;
  parts.push(`<h4>Step 4 · Model <span class="small">asked offline, once per record; answer stored</span></h4><p>${used}</p>${evidenceTable(modelLabels, "Labels the model asserted, each with the words it copied from the record")}`);
  if (model.stripped.length > 0) parts.push(`<p class="small">Stripped from the model's answer: ${model.stripped.map((entry) => `${esc(entry.label)} (${esc(words(entry.reason))})`).join(", ")}.</p>`);
  const fields =
    anchor.fields === null
      ? `<p>${label("neutral", "no labels")} ${esc(versionName(version))} embeds the delivered text as it is and asserts no label.</p>`
      : `<ul class="fields">${fieldLine("Themes", anchor.fields.themes)}${fieldLine("Mechanics", anchor.fields.mechanics)}</ul>`;
  parts.push(`<h4>What ${esc(versionName(version))} holds for this record</h4>${fields}<details><summary>The text that was embedded</summary><pre>${esc(anchor.text)}</pre></details>`);
  return section("enrichment", "2 · What each step added", "Enrichment", "Every label sits beside the words it was read from. Plum labels came from the model, slate ones from the table.", parts.join(""));
}

function removals(trace) {
  if (trace.filters.length === 0) {
    return section("removals", "3 · What was removed", "Removals", "The request was declined before any filter ran.", "");
  }
  const rows = trace.filters
    .map((step) => {
      const list =
        step.removed.length === 0
          ? ""
          : `<details><summary>Show the ${step.removed.length}</summary><ul>${step.removed.map((entry) => `<li>${game(entry)} <span class="small">— ${esc(words(entry.why))}</span></li>`).join("")}</ul></details>`;
      return `<tr><td>${mono(step.filter)}<div class="small">${esc(step.rule)}</div>${list}</td><td class="num">${step.removed.length}</td><td class="num">${step.remaining}</td></tr>`;
    })
    .join("");
  return section(
    "removals",
    "3 · What was removed",
    "Removals",
    "The filters in the order they ran. Availability comes first: a game that is not live on the brand is removed before anything is scored.",
    `<div class="scroll"><table><thead><tr><th>Filter</th><th class="num">Removed</th><th class="num">Left</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

function scores(trace) {
  if (trace.scores.length === 0) return section("scores", "4 · What was scored", "Scores", "Nothing was scored for this request.", "");
  let floorDrawn = false;
  const floorRow = `<tr class="floor"><td colspan="3">${label("neutral", "similarity floor")} ${esc(trace.floor)} <span class="small">${esc(trace.floor_rule)}</span></td></tr>`;
  const rows = trace.scores
    .map((entry) => {
      const below = entry.score < trace.floor;
      const line = below && !floorDrawn ? floorRow : "";
      if (below) floorDrawn = true;
      return `${line}<tr${below ? ' class="below"' : ""}><td class="num">${entry.rank}</td><td>${game(entry)}</td><td class="num">${esc(entry.score)}</td></tr>`;
    })
    .join("");
  return section(
    "scores",
    "4 · What was scored",
    "Scores",
    `Every game that passed the filters above, scored against the game that was asked about. ${trace.scores.length} candidates.`,
    `<div class="scroll tall"><table><thead><tr><th class="num">Rank</th><th>Game</th><th class="num">Score</th></tr></thead><tbody>${rows}${floorDrawn ? "" : floorRow}</tbody></table></div>`,
  );
}

function outcome(response) {
  if (response.outcome === "declined") {
    return section(
      "outcome",
      "5 · What came out",
      "Outcome",
      "The service declined. This is an answer, not an error.",
      `<p data-decline>${label("ochre", "declined")} ${mono(response.decline.reason)}</p><p>${esc(response.decline.detail)}</p><p>A player would see nothing.</p>`,
    );
  }
  const items = response.results.map((entry) => `<li>${label("green", "result")} ${game(entry)} <span class="num">score ${esc(entry.score)}</span></li>`).join("");
  return section("outcome", "5 · What came out", "Outcome", `${response.results.length} related games, best first.`, `<ol class="results" data-results>${items}</ol>`);
}

function provenance(response) {
  const timings = response.trace ? Object.entries(response.trace.timings_ms).map(([stage, ms]) => `${esc(words(stage))} ${esc(ms)} ms`).join(" · ") : "";
  const inspection =
    response.inspection && !response.inspection.is_served_version
      ? ` ${label("slate", "inspection")} This is ${esc(versionName(response.served.version))}, shown for comparison. Players are served ${esc(versionName(response.inspection.served_version))}.`
      : "";
  return `<p class="small provenance">Index ${mono(response.served.index_hash.slice(0, 12))} · version ${mono(response.served.version)} · ${timings}.${inspection}</p>`;
}

/** The trace for one response of /api/recommendations or /api/inspect. */
export function renderTrace(response) {
  const trace = response.trace;
  const head = `<h2>${response.trace?.anchor ? esc(response.trace.anchor.title) : esc(response.request.game_id)} <span class="small">on ${esc(response.request.brand)}</span></h2>`;
  if (!trace || trace.anchor === null) return `${head}${outcome(response)}${provenance(response)}`;
  return `${head}${rawRecord(trace.anchor)}${enrichment(trace.anchor, response.served.version)}${removals(trace)}${scores(trace)}${outcome(response)}${provenance(response)}`;
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

export function renderCompare(responses, served) {
  const versions = Object.keys(responses);
  const cell = (response, row) => {
    const anchor = response.trace?.anchor;
    if (row === "outcome") return response.outcome === "declined" ? `${label("ochre", "declined")} ${mono(response.decline.reason)}` : `${label("green", `${response.results.length} results`)}`;
    if (row === "results") return response.results.length === 0 ? '<span class="absent">none</span>' : `<ol>${response.results.map((entry) => `<li>${esc(entry.title)} <span class="num small">${esc(entry.score)}</span></li>`).join("")}</ol>`;
    if (!anchor) return '<span class="absent">-</span>';
    if (anchor.fields === null) return '<span class="absent">no labels in this version</span>';
    const field = anchor.fields[row];
    if (field.status !== "asserted") return label("ochre", field.status === "conflict" ? "conflicting" : "abstained");
    return field.labels.map((entry) => `<div>${label(entry.method === "model" ? "plum" : "slate", words(entry.label))} <span class="quote small">“${esc(entry.quote)}”</span></div>`).join("");
  };
  const header = versions.map((version) => `<th>${esc(versionName(version))}${version === served ? ` ${label("green", "served")}` : ""}<div class="small">floor ${esc(responses[version].trace?.floor ?? "")}</div></th>`).join("");
  const rows = [
    ["outcome", "Outcome"],
    ["themes", "Themes"],
    ["mechanics", "Mechanics"],
    ["results", "Results"],
  ]
    .map(([row, name]) => `<tr><th scope="row">${name}</th>${versions.map((version) => `<td>${cell(responses[version], row)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="scroll"><table class="compare"><thead><tr><th></th>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
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
const share = (value) => (value.rate === null ? `none of ${esc(value.of)}` : `${pct(value.rate)} <span class="small">${esc(value.count)} of ${esc(value.of)}</span>`);
const bar = (value) => (value === null ? "" : `<span class="bar" style="width:${Math.max(0, Math.min(100, value * 100)).toFixed(1)}%"></span>`);
const passLabel = (ok) => (ok ? label("green", "pass") : label("red", "fail"));

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
  const out = [];

  const shipped = verdict.ships === null ? label("red", "not serving") : label("green", `ships: ${versionName(verdict.ships)}`);
  const ownerTone = report.owner_check.status === "answered" ? "green" : "ochre";
  out.push(
    `<div class="verdict"><p>${shipped} <button type="button" id="what-if-open" class="icon" aria-expanded="false" aria-controls="what-if" title="Explore other pass marks">&#9881;<span> What if the pass marks were different?</span></button></p>` +
      `<p>${esc(verdict.reason)}</p><p class="small">Verdict for index ${mono(verdict.index_hash.slice(0, 12))}, reached with the pass marks committed in ${mono(evaluation.thresholds_file)} (decided ${esc(evaluation.thresholds.decided_on)}).</p>` +
      `<p>${label(ownerTone, `owner's check ${report.owner_check.status}`)} ${esc(report.owner_check.note)}</p></div><div id="what-if" hidden></div>`,
  );

  const raceRows = versions
    .map((version) => {
      const row = report.matching[version];
      const state = decision.versions[version];
      return (
        `<tr><th scope="row">${esc(versionName(version))}${version === verdict.ships ? ` ${label("green", "ships")}` : ""}</th>` +
        `<td class="barcell">${share(row.pairwise.pooled)}${bar(row.pairwise.pooled.rate)}</td><td class="num">${pct(row.pairwise.per_game.mean)} <span class="small">${esc(row.pairwise.per_game.games)} games</span></td>` +
        `<td class="num">${esc(row.wrongly_shown.count)} <span class="small">of ${esc(row.wrongly_shown.results_judged)} shown</span></td>` +
        `<td class="num">${esc(row.cost.model_calls)}</td><td class="num">$${esc(row.cost.estimated_usd.toFixed(4))}</td><td class="num">${esc(row.cost.seconds.toFixed(1))} s</td>` +
        `<td>${passLabel(state.passed)}${state.failed_marks.length > 0 ? ` <span class="small">${esc(state.failed_marks.join(", "))}</span>` : ""}</td></tr>`
      );
    })
    .join("");
  out.push(
    section(
      "race",
      "Evaluation",
      "Race: ranking quality and cost",
      "Pairwise accuracy: for each game, how often a game the plan calls related scores above one it calls unrelated. Cost is what building that version of the index took.",
      `<div class="scroll"><table><thead><tr><th>Version</th><th>Pairwise, pooled</th><th class="num">Mean per game</th><th class="num">Wrongly shown</th><th class="num">Model calls</th><th class="num">Est. cost</th><th class="num">Call time</th><th>Marks</th></tr></thead><tbody>${raceRows}</tbody></table></div>` +
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
  const helpRows = versions
    .map((version) => `<tr><th scope="row">${esc(versionName(version))}</th>${conditions.map(([group, key]) => `<td class="num">${pct(report.matching[version][group][key].per_game.mean)} <span class="small">${esc(report.matching[version][group][key].per_game.games)}</span></td>`).join("")}</tr>`)
    .join("");
  out.push(
    section(
      "where-it-helps",
      "Evaluation",
      "Where it helps",
      "The same pairwise accuracy, mean per game, split by the condition of the record that was asked about. The small number is how many games are in that condition.",
      `<div class="scroll"><table><thead><tr><th>Version</th>${conditions.map(([, , name]) => `<th class="num">${name}</th>`).join("")}</tr></thead><tbody>${helpRows}</tbody></table></div>`,
    ),
  );

  const labelled = Object.keys(report.enrichment);
  const enrichRows = labelled
    .map((version) => {
      const row = report.enrichment[version];
      return `<tr><th scope="row">${esc(versionName(version))}</th><td class="num">${share(row.precision)}</td><td class="num">${share(row.recovery)}</td><td class="num">${share(row.recovery_without_tags)}</td><td class="num">${esc(row.missed_abstentions.count)} <span class="small">of ${esc(row.missed_abstentions.of)}</span></td><td class="num">${esc(row.invalid_quotes.count)} <span class="small">of ${esc(row.invalid_quotes.of)}</span></td><td class="num">${esc(row.missed.not_asserted)} <span class="small">+ ${esc(row.missed.conflict_rule)} withheld by the conflict rule</span></td></tr>`;
    })
    .join("");
  const disagreements = report.disagreements.list
    .map((entry) => `<li>${esc(entry.title)} ${mono(entry.game_id)}: ${label("plum", words(entry.label))} is ${esc(words(entry.plan))} in the plan; asserted by ${esc(entry.asserted_by.map((by) => versionName(by.version)).join(", "))} from “${esc(entry.asserted_by[0]?.quote ?? "")}”. ${reviewerSays(entry.reviewer)}</li>`)
    .join("");
  const control = report.control;
  out.push(
    section(
      "enrichment-measures",
      "Evaluation",
      "Is enrichment safe to automate?",
      "Counts beside every rate. Raw text asserts no labels, so these measures do not apply to it.",
      `<div class="scroll"><table><thead><tr><th>Version</th><th class="num">Precision</th><th class="num">Recovery</th><th class="num">Recovery without tags</th><th class="num">Missed abstentions</th><th class="num">Invalid quotes</th><th class="num">Recoverable labels not asserted</th></tr></thead><tbody>${enrichRows}</tbody></table></div>` +
        `<p class="small">${esc(report.conflict_games.note)} Games: ${report.conflict_games.games.map((entry) => mono(entry.game_id)).join(" ")}.</p>` +
        `<h4>Disagreements with the plan: ${esc(report.disagreements.count)}</h4><ul>${disagreements}</ul>` +
        `<h4>The reviewer, ${mono(report.reviewer.model)}</h4><p>Control: it agreed with the plan on ${esc(control.agreed)} of ${esc(control.size)} labels where the plan and the pipeline agree (${esc(control.applies.agreed)} of ${esc(control.applies.of)} where the label applies, ${esc(control.does_not_apply.agreed)} of ${esc(control.does_not_apply.of)} where it does not). ` +
        `It answered ${esc(report.reviewer.questions)} questions: ${esc(report.reviewer.answers.yes)} yes, ${esc(report.reviewer.answers.no)} no, ${esc(report.reviewer.answers.unclear)} unclear.</p>` +
        (report.reviewer.unclear.length === 0 ? "" : `<p class="small">Recorded as unclear: ${report.reviewer.unclear.map((entry) => `${mono(entry.question_id)} (${esc(words(entry.note ?? "it said unclear"))})`).join(", ")}.</p>`),
    ),
  );

  out.push(
    section(
      "gallery",
      "Evaluation",
      "Failures",
      "Real failures the evaluation found in the system's own output, and, listed apart, the mess that was planted in the catalogue on purpose.",
      `<h4>Real failures: ${esc(report.gallery.real.length)}</h4>${galleryList(report.gallery.real)}<h4>Planted on purpose: ${esc(report.gallery.injected.length)}</h4>${galleryList(report.gallery.injected)}`,
    ),
  );
  return out.join("");
}

// ---------------------------------------------------------------------------
// What-if: other pass marks against the measured numbers
// ---------------------------------------------------------------------------

const RANGES = { rate: { min: 0, max: 1, step: 0.01 }, count: { min: 0, max: 10, step: 1 }, margin: { min: 0, max: 0.2, step: 0.005 } };
const kind = (mark) => (mark.direction === "max" ? "count" : "rate");

/** The sliders. `values` are the marks now set; `committed` the marks in the owner's file; `decision` the gate's answer for `values`. */
export function renderWhatIf(evaluation, whatIf) {
  const { marks } = evaluation;
  const committed = whatIf.committed;
  const set = whatIf.marks;
  const versions = Object.keys(whatIf.decision.versions);
  const rows = marks
    .map((mark) => {
      const range = RANGES[kind(mark)];
      const committedValue = committed[mark.group][mark.key];
      const value = set[mark.group][mark.key];
      const tick = ((committedValue - range.min) / (range.max - range.min)) * 100;
      const cells = versions
        .map((version) => {
          const result = whatIf.decision.versions[version].marks.find((entry) => entry.mark === mark.id);
          if (!result.applies) return `<td>${label("neutral", "does not apply")}</td>`;
          return `<td>${passLabel(result.pass)} <span class="num small">measured ${esc(result.measured === null ? "nothing" : result.measured)}</span></td>`;
        })
        .join("");
      return (
        `<tr><th scope="row"><label for="mark-${mark.key}">${esc(mark.label)}</label><div class="small">${mark.direction === "min" ? "at least" : "at most"} <output for="mark-${mark.key}">${esc(value)}</output>${value === committedValue ? "" : ` ${label("ochre", "moved")}`}</div></th>` +
        `<td class="slider"><input type="range" id="mark-${mark.key}" name="${mark.key}" min="${range.min}" max="${range.max}" step="${range.step}" value="${esc(value)}">` +
        `<span class="tick" style="left:${tick.toFixed(2)}%" title="committed mark"></span><div class="small">committed: ${esc(committedValue)}</div></td>${cells}</tr>`
      );
    })
    .join("");
  const marginRange = RANGES.margin;
  const marginTick = ((committed.ship_rule.margin - marginRange.min) / (marginRange.max - marginRange.min)) * 100;
  const marginRow =
    `<tr><th scope="row"><label for="mark-margin">Margin of the best</label><div class="small">within <output for="mark-margin">${esc(set.ship_rule.margin)}</output>${set.ship_rule.margin === committed.ship_rule.margin ? "" : ` ${label("ochre", "moved")}`}</div></th>` +
    `<td class="slider"><input type="range" id="mark-margin" name="margin" min="${marginRange.min}" max="${marginRange.max}" step="${marginRange.step}" value="${esc(set.ship_rule.margin)}"><span class="tick" style="left:${marginTick.toFixed(2)}%" title="committed mark"></span><div class="small">committed: ${esc(committed.ship_rule.margin)}</div></td>` +
    versions.map((version) => `<td class="num small">accuracy ${esc(whatIf.decision.versions[version].pairwise_accuracy ?? "nothing")}</td>`).join("") +
    "</tr>";
  const totals = `<tr><th scope="row">All marks</th><td></td>${versions.map((version) => `<td>${passLabel(whatIf.decision.versions[version].passed)}</td>`).join("")}</tr>`;
  const would = whatIf.decision.ships === null ? `${label("red", "nothing would ship")}` : `${label("slate", `would ship: ${versionName(whatIf.decision.ships)}`)}`;
  return (
    `<div class="what-if" data-what-if><p class="kicker">What if</p><h3>Other pass marks, against the measured numbers</h3>` +
    `<p>${label("slate", "exploration only")} <strong>The release gate reads only the committed file ${mono(evaluation.thresholds_file)}.</strong> Moving a slider changes no file and nothing that is served; the tick on each slider is the committed mark.</p>` +
    `<div class="scroll"><table><thead><tr><th>Pass mark</th><th>Slider</th>${versions.map((version) => `<th>${esc(versionName(version))}</th>`).join("")}</tr></thead><tbody>${rows}${marginRow}${totals}</tbody></table></div>` +
    `<p aria-live="polite">With these marks: ${would} <span class="small">${esc(whatIf.decision.reason)}</span></p>` +
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

export const renderEmpty = () => '<p class="lede">Choose a brand and a game. The page will show the raw record, what enrichment added, what each filter removed, the scores against the floor, and the result or the reason for declining.</p>';
export const renderLoading = () => "<p>Loading</p>";
export const renderBadInput = (message) => `<p>${label("ochre", "bad request")} ${esc(message)}</p>`;
export const renderFailed = (message) => `<p>${label("red", "failed")} ${esc(message)} Nothing is shown because nothing was received.</p>`;
