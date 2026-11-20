/**
 * Proofs of the page's invariants (docs/features/interface.md). The sections and the evidence are plain
 * functions from the service's responses to React elements, so they are rendered here to HTML text
 * against the real service, for every game on every brand in every version. What needs a browser
 * (the first screen, clicking, the keyboard, the drawer) is proved by tools/console-check.ts.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildConsole, drift } from "../../tools/build-console.ts";
import { MODEL as CATALOGUE_TEXT_MODEL } from "../dataset/truth-writer.ts";
import { ENRICHMENT_MODEL } from "../pipeline/enrich.ts";
import { VERSIONS, type Version } from "../pipeline/versions.ts";
import { route } from "../service/http.ts";
import type { Recommendation } from "../service/recommend.ts";
import { loadService } from "../service/state.ts";
import { Compare, Evidence, PARTS, Part, WhatIfView, type PartId } from "./evidence.ts";
import { TABS, addressOf, estimate, failuresHere, findExamples, gameOptions, latestOnly, loadRequest, readAddress, versionName, type Answer, type Catalogue, type Evaluation, type Loaded, type TabId, type WhatIf } from "./read.ts";
import { AddressProblems, EVIDENCE, LIMITS, RANKED_RIGHT, SECTIONS, type EvidenceId, type SectionProps } from "./view.ts";

const service = loadService();
const games = service.index.records.map((record) => record.game_id);
const { brands } = service.offerings;
const served = service.served.version;

/** The page's `get`, answered by the service's own router. It records every URL it is asked for. */
function getter(): { get: (url: string) => Promise<unknown>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: (url) => {
      asked.push(url);
      const reply = route(service, "GET", url);
      if (reply.status !== 200) return Promise.reject(new Error(`${reply.status} for ${url}: ${reply.body}`));
      return Promise.resolve(JSON.parse(reply.body) as unknown);
    },
  };
}

const ask = (path: string): Answer => JSON.parse(route(service, "GET", path).body) as Answer;
const catalogue = JSON.parse(route(service, "GET", "/api/catalogue").body) as Catalogue;
const evaluation = JSON.parse(route(service, "GET", "/api/evaluation").body) as Evaluation;
/** The brand with the most live games, as the catalogue route counts them. */
const home = ([...catalogue.brands].sort((a, b) => b.live - a.live)[0] as { brand: string }).brand;

/** Everything the page asks for one request, kept so that each proof walks the same answers. */
const loads = new Map<string, Promise<Loaded>>();
function load(game: string, brand: string, version: Version = served): Promise<Loaded> {
  const key = `${game} ${brand} ${version}`;
  let loaded = loads.get(key);
  if (loaded === undefined) loads.set(key, (loaded = loadRequest(getter().get, { game, brand, version }, catalogue)));
  return loaded;
}

const render = (node: ReactNode): string => renderToStaticMarkup(node);
const section = (tab: TabId, data: Loaded, more: Partial<SectionProps> = {}): string => render(h(SECTIONS[tab], { data, evaluation, ...more }));
const evidence = (id: EvidenceId, data: Loaded | null): string => render(h(Evidence, { id, data, evaluation }));
/** One part of the evaluation's evidence, as it is drawn when its name is pressed. */
const part = (id: PartId, report: Evaluation = evaluation): string => render(h(Part, { id, evaluation: report }));
const PART_IDS = [...Object.keys(PARTS.gate), ...Object.keys(PARTS.measures)] as PartId[];
/** The words of a piece of markup, as a reader sees them. */
const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#x27);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" })[name] as string)
    .replace(/\s+/g, " ");
/** Text as React writes it into markup. */
const esc = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character] as string);

type Held = { label: string; method: string; quote: string; source_field: string };
const held = (response: Recommendation): (Held & { field: string })[] => {
  const fields = response.trace?.anchor?.fields;
  if (!fields) return [];
  return (["themes", "mechanics"] as const).flatMap((field) => (fields[field]?.labels ?? []).map((label) => ({ ...(label as Held), field })));
};

test("UI-1: every view asks only this service's own routes, and shows the numbers the response carries", async () => {
  const { get, asked } = getter();
  const [game, brand] = [games[0] as string, brands[0] as string];
  await loadRequest(get, { game, brand, version: served }, catalogue);
  await loadRequest(get, { game, brand, version: "raw" }, catalogue);
  await findExamples(get, catalogue, evaluation);
  assert.ok(asked.length >= 8);
  for (const url of asked) assert.match(url, /^\/api\/(recommendations|inspect)\?/, url);

  // A view computes nothing: change a score, a candidate's score and the floor in the response, and the page shows the changed values.
  const data = structuredClone(await load(games.find((id) => ask(`/api/recommendations?game=${id}&brand=${brand}`).results.length > 0) as string, brand));
  const { response } = data;
  assert.ok(response.trace !== undefined && response.results[0] !== undefined && response.trace.scores[0] !== undefined);
  response.results[0].score = 0.123456;
  response.trace.scores[0].score = 0.654321;
  response.trace.floor = 0.111111;
  const shown = section("shown", data);
  assert.ok(shown.includes("0.123456") && shown.includes(">0.12<"), "the changed score is not on the page, rounded and exact");
  const scores = evidence("scores", data);
  for (const value of ["0.654321", "0.111111"]) assert.ok(scores.includes(value), `${value} is not in the scores`);
  assert.ok(shown.includes("against a floor of 0.111111"));
});

test("UI-2: every declined request shows its reason, the word declined and no results, and never a failure label", async () => {
  const seen = new Set<string>();
  for (const brand of brands) {
    for (const game of [...games, "no-such-game"]) {
      if (ask(`/api/recommendations?game=${game}&brand=${brand}`).outcome !== "declined") continue;
      const data = await load(game, brand);
      const html = section("shown", data);
      seen.add(data.response.decline?.reason ?? "");
      assert.ok(html.includes("data-decline") && text(html).includes("declined"), `${game} on ${brand}`);
      assert.ok(html.includes(`<code>${data.response.decline?.reason}</code>`));
      assert.ok(text(html).includes("A player would see nothing."));
      assert.ok(!html.includes("data-results") && !html.includes('class="label green">result<'), `${game} on ${brand} shows results beside a decline`);
      assert.ok(!html.includes('class="label red"'), "a decline is shown as a failure");
    }
  }
  assert.deepEqual([...seen].sort(), ["anchor_not_available", "insufficient_data", "nothing_above_floor", "unknown_game"]);
});

test("UI-2: an address that names a game the index does not hold shows the unknown-game decline, not a missing-parameter message", async () => {
  const brand = brands[0] as string;
  // The picker keeps the game the address asked for, so the request goes out as asked.
  const options = gameOptions(catalogue, brand, "nope-00000");
  assert.deepEqual(options[0], { value: "nope-00000", label: "nope-00000", note: "not in the index" });
  assert.equal(options.length, games.length + 1);
  // A game the index holds adds no option, and no address adds none.
  assert.equal(gameOptions(catalogue, brand, games[0]).length, games.length);
  assert.equal(gameOptions(catalogue, brand, null).length, games.length);
  assert.deepEqual(readAddress("?game=nope-00000&brand=" + brand, catalogue).problems, []);
  const { get, asked } = getter();
  const data = await loadRequest(get, { game: "nope-00000", brand, version: served }, catalogue);
  assert.ok(asked[0]?.includes("game=nope-00000"));
  const html = section("shown", data);
  assert.ok(html.includes("<code>unknown_game</code>") && text(html).includes("declined"));
  assert.ok(!text(html).includes("is required"));
  // The other sections say what they cannot show, and do not fail.
  assert.ok(text(section("added", data)).includes("The index holds no record for nope-00000"));
  assert.ok(text(section("removed", data)).includes("declined before any filter ran"));
});

test("UI-3: the page is served, and for every brand, game and version every section renders, with its evidence", async () => {
  const page = route(service, "GET", "/");
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('id="root"') && page.body.includes("<title>"));
  const assets = [...page.body.matchAll(/(?:src|href)="(\/console\/[^"]+)"/g)].map((match) => match[1] as string);
  assert.deepEqual(assets.sort(), ["/console/app.js", "/console/console.css"]);
  for (const asset of assets) assert.equal(route(service, "GET", asset).body, readFileSync(`src/console/dist/${asset.split("/").at(-1)}`, "utf8"), asset);
  // The page asks for nothing outside this service: no address of another host in the page, and none it would fetch in its files.
  assert.ok(!/(?:src|href)="(?:https?:)?\/\//.test(page.body), "the page loads something from another host");
  assert.ok(!/url\(\s*["']?(?:https?:)?\/\//.test(route(service, "GET", "/console/console.css").body), "the stylesheet loads something from another host");
  assert.ok(!/@import/.test(route(service, "GET", "/console/console.css").body), "the stylesheet imports another sheet at run time");

  let rendered = 0;
  for (const { brand } of catalogue.brands) {
    for (const { game_id: game } of catalogue.games) {
      for (const version of catalogue.versions) {
        const data = await load(game, brand, version);
        for (const tab of TABS) assert.ok(section(tab.id, data).includes(`data-section="${tab.id}"`), `${game} on ${brand} in ${version}: no ${tab.id}`);
        if (data.response.results.length > 0) for (const id of ["scores", "provenance", "steps", "raw-record", "versions"] as const) assert.ok(evidence(id, data).length > 200, `${game} on ${brand} in ${version}: no ${id}`);
        rendered += 1;
      }
    }
  }
  assert.equal(rendered, catalogue.brands.length * catalogue.games.length * catalogue.versions.length);
  for (const id of ["gate", "measures"] as const) assert.ok(evidence(id, null).length > 500, id);
  for (const id of PART_IDS.filter((id) => id !== "what-if")) assert.ok(part(id).length > 200, id);
});

test("UI-4: the what-if panel says the gate reads only the committed file, shows the committed mark, and moving a mark flips pass and fail without touching a file", async () => {
  const before = { thresholds: readFileSync("eval/thresholds.json"), verdict: readFileSync("eval/results/verdict.json") };
  const { get, asked } = getter();
  const panel = async (url: string): Promise<string> => render(h(WhatIfView, { evaluation, whatIf: (await get(url)) as WhatIf }));
  const committed = await panel("/api/what-if");
  assert.ok(text(committed).includes("The release gate reads only the committed file eval/thresholds.json ."));
  assert.ok(text(committed).includes("Moving a slider changes no file"));
  const marks = JSON.parse(before.thresholds.toString("utf8")) as { enrichment: Record<string, number>; matching: Record<string, number> };
  for (const [key, value] of [...Object.entries(marks.enrichment), ...Object.entries(marks.matching)]) {
    assert.ok(committed.includes(`name="${key}" value="${value}"`), `no slider for ${key} at ${value}`);
    assert.ok(text(committed).includes(`committed: ${value}`));
  }
  assert.equal(committed.split('class="tick"').length - 1, Object.keys(marks.enrichment).length + Object.keys(marks.matching).length + 1);
  assert.ok(text(committed).includes(`would ship: ${versionName(service.verdict.ships ?? "")}`));

  const moved = await panel("/api/what-if?min_pairwise_accuracy=0.99");
  assert.ok(text(moved).includes("nothing would ship"));
  assert.ok(moved.split('class="label red">fail<').length > committed.split('class="label red">fail<').length);
  assert.ok(moved.includes('class="label amber">moved<') && !committed.includes('class="label amber">moved<'));
  assert.ok(asked.every((url) => url.startsWith("/api/what-if")));
  assert.deepEqual(readFileSync("eval/thresholds.json"), before.thresholds);
  assert.deepEqual(readFileSync("eval/results/verdict.json"), before.verdict);
});

test("UI-5: text from the catalogue and from a model reaches the page as text, never as markup", async () => {
  // Responses in which every string is hostile.
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const poison = (value: unknown): unknown => {
    if (typeof value === "string") return hostile;
    if (Array.isArray(value)) return value.map(poison);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poison(item)]));
    return value;
  };
  const real = await load(games.find((id) => ask(`/api/inspect?game=${id}&brand=${home}&version=model_everywhere`).results.length > 0) as string, home, "model_everywhere");
  const keep = { outcome: real.response.outcome, served: real.response.served };
  const response = { ...(poison(real.response) as Answer), ...keep };
  const data: Loaded = { response, neighbours: Object.fromEntries(Object.keys(real.neighbours).map((id) => [id, response])), versions: Object.fromEntries(VERSIONS.map((version) => [version, response])) };
  const bad = { ...(poison(evaluation) as Evaluation), marks: evaluation.marks };
  const pages = [
    ...TABS.map((tab) => render(h(SECTIONS[tab.id], { data, evaluation: bad }))),
    ...(Object.keys(EVIDENCE) as EvidenceId[]).map((id) => render(h(Evidence, { id, data, evaluation: bad }))),
    ...PART_IDS.filter((id) => id !== "what-if" && id !== "limits").map((id) => part(id, bad)),
    render(h(AddressProblems, { problems: readAddress(`?brand=${encodeURIComponent(hostile)}&game=${encodeURIComponent(hostile)}`, catalogue).problems })),
  ];
  for (const [index, html] of pages.entries()) {
    assert.ok(!html.includes("<script") && !html.includes("<img"), `page ${index}: hostile text reached the page as markup`);
    // The fourth section draws the evaluation's numbers and the versions' own names: it has no free text to carry.
    if (index !== TABS.findIndex((tab) => tab.id === "worth")) assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), `page ${index}: the hostile text is not on the page as text`);
  }
  // The records that carry markup or a planted instruction render with their text escaped.
  const marked = service.index.records.filter((record) => /<p>|&amp;|&#39;/.test(record.canonical.description_as_delivered ?? ""));
  assert.ok(marked.length > 0);
  for (const record of marked) {
    const html = evidence("raw-record", await load(record.game_id, brands[0] as string, "raw"));
    const delivered = record.canonical.description_as_delivered ?? "";
    assert.ok(!html.includes(delivered), `${record.game_id}: the delivered description reached the page unescaped`);
    assert.ok(html.includes(esc(delivered)), `${record.game_id}: the delivered description is not on the page`);
  }
});

test("UI-6: for a game whose tag contradicts its description, the page shows the conflict and how each version handled it", async () => {
  const conflicts = service.index.records.filter((record) => record.conflict !== null);
  assert.ok(conflicts.length > 0, "the index holds no conflict to show");
  for (const record of conflicts) {
    const brand = brands.find((candidate) => service.offerings.statusByBrand.get(candidate)?.get(record.game_id) === "live") ?? (brands[0] as string);
    const table = await load(record.game_id, brand, "table");
    const model = await load(record.game_id, brand, "model_everywhere");
    for (const data of [table, model]) {
      const added = section("added", data);
      assert.ok(added.includes(`<span class="tag contradicted">${esc(record.conflict?.tag ?? "")}</span>`), `${record.game_id}: the contradicted tag is not marked`);
      assert.ok(text(added).includes(`a supplier tag says ${record.conflict?.tag_asserts.replaceAll("_", " ")} but the description says`) && text(added).includes("so the lookup table asserts no mechanic"));
      const steps = text(evidence("steps", data));
      assert.ok(steps.includes(`The tag ${record.conflict?.tag} asserts`), `${record.game_id}: the contradicted tag is not named`);
      assert.ok(steps.includes("the table version asserts no mechanic"));
    }
    assert.ok(text(section("added", table)).includes("Mechanics conflicting"), `${record.game_id}: the table version does not show its mechanics as conflicting`);
    const used = record.versions.model_everywhere.mechanics?.labels ?? [];
    if (record.conflict?.model_reading_used === true) {
      assert.ok(used.length > 0 && !text(section("added", model)).includes("Mechanics conflicting"));
      for (const label of used) assert.ok(text(evidence("steps", model)).includes(`“${label.quote}”`), `${record.game_id}: the quote behind ${label.label} is not shown`);
    } else {
      assert.ok(text(evidence("steps", model)).includes("the field stays empty in every version"));
    }
    // Side by side: one column per version, the table's cell says conflicting and a resolved model cell lists labels.
    const compare = render(h(Compare, { versions: table.versions, served, shown: "table" }));
    const cells = (compare.split('<tr data-row="mechanics">')[1] ?? "").split("</tr>")[0]?.split("<td>").slice(1) ?? [];
    assert.equal(cells.length, VERSIONS.length);
    assert.ok((cells[VERSIONS.indexOf("table")] ?? "").includes("conflicting"));
    if (record.conflict?.model_reading_used === true) assert.ok((cells[VERSIONS.indexOf("model_where_thin")] ?? "").includes('class="tag model"'));
  }
});

test("UI-7: a quote is marked where it sits in the record's own text, a quote that cannot be placed is said, and a bar is as long as the number the response carries", async () => {
  const marksIn = (html: string): string[] => [...html.matchAll(/<mark>(.*?)<\/mark>/g)].map((match) => match[1] as string);
  const plain = (html: string): string => html.replaceAll(/<sup class="ref">[^<]*<\/sup>/g, "").replaceAll(/<\/?mark>/g, "");
  let quotesSeen = 0;
  for (const game of games) {
    const data = await load(game, home, "model_everywhere");
    const anchor = data.response.trace?.anchor;
    assert.ok(anchor, `${game}: no record in the trace`);
    const html = section("added", data);
    const texts = [...html.matchAll(/<p class="copy">(.*?)<\/p>/g)].map((match) => match[1] as string);
    for (const field of ["title", "description"] as const) {
      const text = anchor.steps.cleaned[field];
      const quotes = held(data.response).filter((entry) => entry.source_field === field).map((entry) => entry.quote);
      if (typeof text !== "string") {
        assert.equal(quotes.length, 0, `${game}: a label quotes a ${field} the record does not have`);
        continue;
      }
      // The text shown is the record's own, with nothing added but the marks and their numbers.
      const shown = texts.find((candidate) => plain(candidate) === esc(text));
      assert.ok(shown !== undefined, `${game}: the cleaned ${field} is not shown`);
      for (const quote of quotes) assert.ok(marksIn(shown).some((marked) => marked.includes(esc(quote))), `${game}: "${quote}" is not marked in the ${field}`);
      quotesSeen += quotes.length;
    }
    assert.ok(!html.includes("words not found in the record"), `${game}: a stored quote could not be placed`);
  }
  assert.ok(quotesSeen > 0, "no quote was checked");

  // A quote that is not in the text is said, not dropped; and a bar follows the number in the response.
  let busy: Loaded | undefined;
  for (const game of games) {
    const data = await load(game, home, "model_everywhere");
    if (data.response.results.length > 0 && held(data.response).some((entry) => entry.method === "model" && entry.source_field === "description")) busy = structuredClone(data);
    if (busy) break;
  }
  assert.ok(busy?.response.trace?.anchor?.fields && busy.response.trace.scores[0] !== undefined);
  const { fields } = busy.response.trace.anchor;
  const lost = [...fields.themes.labels, ...fields.mechanics.labels].find((entry) => entry.method === "model" && entry.source_field === "description");
  assert.ok(lost);
  lost.quote = "words that are nowhere in this record";
  busy.response.trace.scores[0].score = 0.4321;
  busy.response.trace.floor = 0.1234;
  assert.equal(section("added", busy).split("words not found in the record").length - 1, 1);
  const scores = evidence("scores", busy);
  assert.ok(scores.includes("width:43.21%"), "the bar is not as long as the score");
  assert.ok(scores.includes('style="left:12.34%"'), "the tick is not at the floor");
});

test("UI-8: each section states one question with one short line, answers it in one sentence, and keeps everything else out of sight under at most three named buttons", async () => {
  let results = 0;
  let declines = 0;
  for (const brand of brands) {
    for (const game of games) {
      const data = await load(game, brand);
      for (const tab of TABS) {
        const html = section(tab.id, data);
        const where = `${game} on ${brand}, ${tab.id}`;
        for (const marker of ["data-question", "data-answer"]) assert.equal(html.split(`${marker}=""`).length - 1, 1, `${where}: not exactly one ${marker}`);
        assert.ok(html.includes('data-first=""'), `${where}: nothing is marked as the first thing of the answer`);
        // The left: the question, which is a question, and one short line. Nothing else.
        const left = /<div class="question">(.*?)<\/div><div class="answer">/.exec(html)?.[1] ?? "";
        assert.match(left, /^<h2 data-question="">.*?<\/h2><p class="why">[^<]{20,110}<\/p>$/, `${where}: the left holds more than a question and one short line`);
        assert.match(text(/<h2 data-question="">(.*?)<\/h2>/.exec(html)?.[1] ?? ""), /\?$/, `${where}: the question is not a question`);
        // What is true and not the answer is not drawn: no table of scores, no raw record, no step-by-step, no pass marks, no other version's list.
        for (const hidden of ['class="scores"', 'class="raw"', 'class="steps"', 'class="measures"', 'class="matrix"', "data-what-if", 'class="gallery"', "data-others", "<details"]) assert.ok(!html.includes(hidden), `${where}: ${hidden} is on screen before it is asked for`);
        const offered = html.split("data-evidence=").length - 1;
        assert.ok(offered >= 1 && offered <= 3, `${where}: ${offered} evidence buttons`);
        // No boxed note on the surface, unless the request calls for one: a decline, a failure the evaluation found, or a game pointed at.
        const boxes = html.split('class="callout').length - 1;
        const due = html.split("data-decline").length - 1 + (html.split("data-failure").length - 1);
        assert.equal(boxes, due, `${where}: ${boxes} boxed notes for ${due} reasons`);
      }
      const shown = section("shown", data);
      if (shown.includes("data-results")) {
        results += 1;
        assert.match(text(shown), /Given .+ on .+, the service returns \d+ games? that scored above the similarity floor and (is|are) live there, closest first\./, `${game} on ${brand}`);
      } else {
        declines += 1;
        assert.match(text(shown), /Given .+ on .+, the service recommends nothing, and says why\./);
      }
    }
  }
  assert.ok(results > 0 && declines > 0);
  // Every piece of evidence is offered by a section under its own name, the name says what it opens, and it opens.
  const data = await load(games.find((id) => ask(`/api/recommendations?game=${id}&brand=${home}`).results.length > 0) as string, home);
  const offered = TABS.flatMap((tab) => [...section(tab.id, data).matchAll(/<button type="button" class="chip" data-evidence="([^"]+)">(.*?)<\/button>/g)].map((match) => [match[1] as EvidenceId, text(match[2] as string)] as const));
  assert.deepEqual([...new Set(offered.map(([id]) => id))].sort(), Object.keys(EVIDENCE).sort(), "a piece of evidence is offered by no section");
  const names = [...Object.values(EVIDENCE), ...Object.values(PARTS.gate), ...Object.values(PARTS.measures)];
  for (const [id, name] of offered) assert.equal(name.trim(), EVIDENCE[id], `${id} is offered under another name`);
  for (const name of names) assert.ok(name.length > 20 && !/^(show )?(more|details)$/i.test(name), `"${name}" does not say what it opens`);
  assert.equal(new Set(names).size, names.length, "two pieces of evidence carry the same name");
  // A piece with several parts names each of them, and opens on the first.
  for (const id of ["gate", "measures"] as const) for (const name of Object.values(PARTS[id])) assert.ok(text(evidence(id, data)).includes(name), `${id} does not name its part "${name}"`);
  // A version other than the served one says so wherever it is shown, with the way back.
  const inspected = await load(data.response.request.game_id, home, "raw");
  for (const tab of ["shown", "added", "removed"] as const) assert.ok(section(tab, inspected).includes("data-inspection") && text(section(tab, inspected)).includes(`This is Raw text, shown for comparison. Players are served ${versionName(served)}. Back to the served version`));
  assert.ok(!section("shown", data).includes("data-inspection"));
});

test("UI-9: what a result is said to have in common with the game played is held by both, and it is never offered as the cause of the score", async () => {
  let cards = 0;
  for (const game of games) {
    const data = await load(game, home);
    const { response } = data;
    if (response.outcome !== "results") continue;
    const html = section("shown", data);
    const mine = held(response);
    const items = (html.split('<ol class="results" data-results="">')[1] ?? "").split("</ol>")[0]?.split(/<li[ >]/).slice(1) ?? [];
    assert.equal(items.length, response.results.length);
    for (const [index, result] of response.results.entries()) {
      const theirs = held(ask(`/api/inspect?game=${result.game_id}&brand=${home}&version=${served}`));
      const expected = mine.filter((label) => theirs.some((other) => other.field === label.field && other.label === label.label)).map((label) => label.label.replaceAll("_", " "));
      const shown = [...(items[index] ?? "").matchAll(/<span class="tag (?:model|table)"[^>]*>(.*?)<\/span>/g)].map((match) => match[1] as string);
      assert.deepEqual(shown, expected.map((label) => esc(label)), `${game}: what ${result.game_id} has in common is not what both hold`);
      if (expected.length === 0) assert.ok(text(items[index] ?? "").includes("No label in common"), `${game}: ${result.game_id} shows no reason and does not say so`);
      cards += 1;
    }
    assert.ok(text(html).includes("cannot be traced to single labels") && text(html).includes("not as the cause of its score"));
    assert.ok(!/because (it|they) share|ranked (first|higher) because/i.test(text(html)));
  }
  assert.ok(cards > 100, `only ${cards} results were checked`);
});

test("UI-10: the other versions' answers are counted as the service gave them, the measured numbers are the report's, a cost reads as an estimate, and a different list is not called better", async () => {
  const { matching } = evaluation.report;
  let differing = 0;
  for (const game of games) {
    const html = evidence("versions", await load(game, home));
    const mine = ask(`/api/recommendations?game=${game}&brand=${home}`).results.map((entry) => entry.game_id);
    const lines = (html.split('data-others="">')[1] ?? "").split("</ul>")[0]?.split("<li>").slice(1) ?? [];
    const others = VERSIONS.filter((version) => version !== served);
    assert.equal(lines.length, others.length);
    for (const [index, version] of others.entries()) {
      const other = ask(`/api/inspect?game=${game}&brand=${home}&version=${version}`);
      const theirs = other.results.map((entry) => entry.game_id);
      const same = theirs.filter((id) => mine.includes(id)).length;
      const line = text(lines[index] ?? "");
      assert.ok(line.includes(versionName(version)), `${game}: no line for ${version}`);
      assert.ok(line.includes(matching[version].cost.model_calls === 0 ? "no model" : " model "), `${game}: ${version} is not marked by how it was built`);
      if (other.outcome === "declined") assert.ok(line.includes("declines"), `${game}: ${version} declines and the line does not say so`);
      else if (mine.length === 0) assert.ok(line.includes(`returns ${theirs.length} game`));
      else if (same === mine.length && theirs.length === same) assert.ok(line.includes("the same games"), `${game}: ${version} returns the same games`);
      else {
        differing += 1;
        assert.ok(line.includes(`${same} of these ${mine.length}`), `${game}: ${version} shares ${same} of ${mine.length}, the line says "${line}"`);
        if (theirs.length > same) assert.ok(line.includes(`and ${theirs.length - same} other`), `${game}: ${version} returns ${theirs.length - same} other game(s)`);
      }
    }
    assert.ok(text(html).includes("A different list is not a better list."));
  }
  assert.ok(differing > 0, "no version ever differed, so the differing case was not checked");
  // Looking at another version, the others are counted against the list on screen.
  const raw = await load(games.find((id) => ask(`/api/inspect?game=${id}&brand=${home}&version=raw`).results.length > 0) as string, home, "raw");
  assert.ok(text(evidence("versions", raw)).includes("Against the list of Raw text") && !(evidence("versions", raw).split('data-others="">')[1] ?? "").split("</ul>")[0]?.includes(">Raw text"));

  const html = section("worth", await load(games[0] as string, home));
  const measured = (html.split('data-measured="">')[1] ?? "").split("</table>")[0] ?? "";
  for (const version of VERSIONS) {
    const row = matching[version];
    assert.ok(text(measured).includes(`${((row.pairwise.pooled.rate ?? 0) * 100).toFixed(1)}%`) && text(measured).includes(estimate(row.cost.estimated_usd)), `${version}: its measured numbers are not in the answer`);
  }
  // Each bar is as long as its rate, from zero: a difference is not drawn larger than it is.
  const widths = [...measured.matchAll(/data-slot="meter-indicator" style="[^"]*width:([\d.]+)%/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, VERSIONS.length);
  for (const [index, version] of VERSIONS.entries()) assert.ok(Math.abs((widths[index] ?? -1) - (matching[version].pairwise.pooled.rate ?? 0) * 100) < 0.01, `${version}: its bar is ${widths[index]}% long, its rate is ${matching[version].pairwise.pooled.rate}`);
  assert.ok(measured.includes(`left:${(evaluation.thresholds.matching.min_pairwise_accuracy * 100).toFixed(2)}%`), "the tick is not at the pass mark");
  // The answer is said in one sentence, from the report: the served version, the best version built the other way, and both rates.
  const answer = text(/<p class="lede" data-answer="">(.*?)<\/p>/.exec(html)?.[1] ?? "");
  const plain = VERSIONS.filter((version) => matching[version].cost.model_calls === 0).sort((a, b) => (matching[b].pairwise.pooled.rate ?? 0) - (matching[a].pairwise.pooled.rate ?? 0))[0] as Version;
  assert.ok(matching[served].cost.model_calls > 0, "the served version is built without the model, so this proof needs another sentence");
  for (const piece of [`${versionName(served)} is served`, versionName(plain), `${((matching[served].pairwise.pooled.rate ?? 0) * 100).toFixed(1)}%`, `${((matching[plain].pairwise.pooled.rate ?? 0) * 100).toFixed(1)}%`, "the best version built without the model"]) assert.ok(answer.includes(piece), `the answer does not say ${piece}: ${answer}`);
  assert.ok(answer.includes(`${Math.abs(((matching[served].pairwise.pooled.rate ?? 0) - (matching[plain].pairwise.pooled.rate ?? 0)) * 100).toFixed(1)} points ${(matching[served].pairwise.pooled.rate ?? 0) > (matching[plain].pairwise.pooled.rate ?? 0) ? "more" : "fewer"}`), answer);
  // A cost is an estimate and reads as one: never a figure to four places, in the answer or in its table.
  assert.ok(!/\$\d+\.\d{3,}/.test(html), "a cost is shown to more places than an estimate has");
  assert.ok(answer.includes("for an estimated $") && text(html).includes("Estimated cost of a build") && html.includes("An estimate from the model calls each build made, not a bill."));
  assert.equal(estimate(0.115985), "about $0.12");
  assert.equal(estimate(0.000148), "under $0.01");
  // The one limit that stays on the surface is true on its own; what "ranked right" measures is a hover away and written out with the numbers.
  assert.ok(/<p class="small" data-limits="">A fictional catalogue, scored against its generator(&#x27;|')s own answer key: these numbers show direction, not how real players would judge a list\.<\/p>/.test(html));
  assert.ok(html.includes(esc(RANKED_RIGHT)) && text(part("numbers")).includes(RANKED_RIGHT));
});

test("UI-11: the path shows the trace's own counts in the trace's order, availability first, as three different things, and points out a game where it was removed", async () => {
  let limited = 0;
  let floored = 0;
  for (const brand of brands) {
    for (const game of games) {
      const data = await load(game, brand);
      const { response } = data;
      const filters = response.trace?.filters ?? [];
      if (filters.length === 0) continue;
      const path = section("removed", data);
      const counts = [...path.matchAll(/<span class="n num">([^<]*)<\/span><span class="name">([^<]*)<\/span>/g)].map((match) => [match[1], match[2]]);
      const first = filters[0];
      assert.ok(first !== undefined && first.filter === "not_live_on_brand", `${game} on ${brand}: availability is not the first filter`);
      assert.deepEqual(counts[0], [String(first.removed.length + first.remaining), "In the catalogue"]);
      assert.deepEqual(counts[1], [String(first.remaining), "Live on this brand"]);
      assert.deepEqual(counts.slice(1, -1).map((entry) => entry[0]), filters.map((step) => String(step.remaining)), `${game} on ${brand}: the counts are not the trace's`);
      assert.deepEqual(counts.at(-1), [String(response.results.length), "Shown"]);
      // Each step says which of three different things it decides, in this order. A request that ends at the floor has no third.
      const kinds = [...path.matchAll(/data-group="(\w+)"[^>]*><span class="kind">(\w+)<\/span>/g)].map((match) => `${match[1]}:${match[2]}`);
      const stages = [...new Set(kinds)];
      assert.deepEqual(stages, ["eligible:rule", "similar:score", "limit:limit"].slice(0, stages.length), `${game} on ${brand}`);
      assert.equal(kinds.length, filters.length);
      assert.ok(stages.length >= 2 && (response.outcome !== "results" || stages.length === 3), `${game} on ${brand}: ${stages.join(", ")}`);
      // The answer counts what the rules removed before anything was scored, from the trace.
      const byRules = filters.filter((step) => ["not_live_on_brand", "anchor_or_duplicate", "insufficient_data"].includes(step.filter)).reduce((sum, step) => sum + step.removed.length, 0);
      assert.ok(text(path).includes(`${byRules} ${byRules === 1 ? "was" : "were"} removed by rules before anything was scored.`), `${game} on ${brand}: the answer does not count the ${byRules} removed by rules`);
      assert.ok(!path.includes('aria-expanded="true"') && !path.includes("data-focus") && !path.includes("step-panel"), "a step is open though nothing was pointed out");
      // Opened, a step says what kind of thing it decided. The floor is a point in the spread of scores, never evidence of relevance.
      const opened = (filter: string): string | null => {
        const gone = filters.find((step) => step.filter === filter)?.removed[0];
        return gone === undefined ? null : text(section("removed", data, { focus: gone.game_id }));
      };
      const rule = opened("not_live_on_brand");
      if (rule !== null) assert.ok(rule.includes("A rule, not a score. A game that is not live on the brand is removed before anything is scored."), `${game} on ${brand}`);
      const floor = opened("below_floor");
      if (floor !== null) {
        floored += 1;
        assert.ok(floor.includes(`The floor is ${response.trace?.floor}.`) && floor.includes("It is a point in the spread of scores: it says a game is closer than most pairs are, not that a player would find it relevant."), `${game} on ${brand}`);
      }
      // A game that cleared the floor and is not shown is named, with the reason the trace gives.
      const cut = filters.filter((step) => step.filter === "family_cap" || step.filter === "over_limit").flatMap((step) => step.removed);
      if (stages.length < 3) assert.equal(cut.length, 0);
      else if (cut[0] !== undefined) {
        limited += 1;
        const limit = section("removed", data, { focus: cut[0].game_id });
        assert.ok(text(limit).includes("A limit, not a score. Cleared the floor and not shown:"));
        for (const entry of cut) assert.ok(limit.includes(`<strong>${esc(entry.title)}</strong> (${esc(entry.why.replaceAll("_", " "))})`), `${game} on ${brand}: ${entry.game_id} cleared the floor, is not shown, and is not named`);
      }
    }
  }
  assert.ok(limited > 0 && floored > 100, `the limit was checked on ${limited} requests and the floor on ${floored}`);
  // Pointed at a game the first filter removed, the page opens that step and marks the game.
  let withRemoved: Loaded | undefined;
  for (const game of games) {
    const data = await load(game, home);
    if ((data.response.trace?.filters[0]?.removed.length ?? 0) > 0) withRemoved = data;
    if (withRemoved) break;
  }
  const gone = withRemoved?.response.trace?.filters[0]?.removed[0];
  assert.ok(withRemoved && gone);
  const pointed = section("removed", withRemoved, { focus: gone.game_id });
  assert.ok(pointed.includes("data-focus") && pointed.includes(`<strong>${esc(gone.title)}</strong> was taken out at the step “Live on this brand”`));
  assert.equal(pointed.split('aria-expanded="true"').length - 1, 1);
  assert.equal(pointed.split('<li class="focus">').length - 1, 1);
});

test("UI-12: the examples are found in the data, each shows what it says, and they follow the data when it changes", async () => {
  const { get, asked } = getter();
  const examples = await findExamples(get, catalogue, evaluation);
  assert.ok(asked.every((url) => /^\/api\/(recommendations|inspect)\?/.test(url)));
  assert.deepEqual(examples.map((example) => example.kind), ["thin", "plain", "conflict", "filter", "decline", "versions", "failure"]);
  for (const example of examples) assert.ok(example.found && example.note.length > 20 && example.href?.startsWith("/?game="), `${example.kind}: ${example.note}`);
  const of = async (kind: string) => {
    const example = examples.find((entry) => entry.kind === kind);
    assert.ok(example?.game !== undefined && example.brand !== undefined && example.tab !== undefined);
    const data = await load(example.game, example.brand, example.version ?? served);
    return { ...example, game: example.game, brand: example.brand, tab: example.tab, data, response: data.response };
  };
  // Each example is checked against the service, not against what the finder says about itself.
  const thin = await of("thin");
  assert.ok(thin.response.trace?.anchor?.thin === true && thin.response.outcome === "results" && held(thin.response).some((label) => label.method === "model"));
  // The numbers its line gives are the service's: what the table read, what the model added, and no other thin game on that brand gained more.
  const fromModel = (response: Recommendation): number => held(response).filter((label) => label.method === "model").length;
  const tableFound = (thin.response.trace?.anchor?.steps.table.themes.length ?? 0) + (thin.response.trace?.anchor?.steps.table.mechanics.length ?? 0);
  assert.ok(thin.note.includes(tableFound === 0 ? "read no label from the supplier's tags" : `read ${tableFound} label`), thin.note);
  assert.ok(thin.note.includes(`the model added ${fromModel(thin.response)} from the text`), thin.note);
  const gains = catalogue.games.filter((game) => game.thin).map((game) => ask(`/api/recommendations?game=${game.game_id}&brand=${thin.brand}&trace=1`)).filter((response) => response.outcome === "results").map(fromModel);
  assert.equal(fromModel(thin.response), Math.max(...gains), "another thin game gained more labels than the example");
  const plain = await of("plain");
  assert.ok(plain.response.trace?.anchor?.thin === false && held(plain.response).length > 0 && held(plain.response).every((label) => label.method !== "model"));
  assert.ok(plain.note.includes(`already gave ${held(plain.response).length} label`), plain.note);
  const conflict = await of("conflict");
  assert.ok(conflict.response.trace?.anchor?.steps.conflict !== null);
  const filter = await of("filter");
  assert.ok(filter.focus !== undefined && filter.response.trace?.filters[0]?.removed.some((entry) => entry.game_id === filter.focus));
  assert.ok(brands.some((brand) => ask(`/api/recommendations?game=${filter.game}&brand=${brand}`).results[0]?.game_id === filter.focus), "the removed game is the closest match on no brand");
  assert.equal((await of("decline")).response.outcome, "declined");
  const versions = await of("versions");
  assert.ok(new Set(VERSIONS.map((version) => ask(`/api/inspect?game=${versions.game}&brand=${versions.brand}&version=${version}`).results.map((entry) => entry.game_id).join(" "))).size > 1);
  // Opened, the failure is said in the section the example opens, in the evaluation's own words.
  const failure = await of("failure");
  const listed = evaluation.report.gallery.real.filter((entry) => entry.game_id === failure.game);
  assert.ok(listed.length > 0);
  const opened = section(failure.tab, failure.data);
  assert.ok(opened.includes("data-failure") && listed.some((entry) => opened.includes(esc(entry.what))));
  // Each example opens the section that shows it.
  assert.deepEqual(examples.map((example) => example.tab), ["added", "added", "added", "removed", "shown", "worth", failure.tab]);
  for (const example of examples) assert.equal(example.href, addressOf({ game: example.game as string, brand: example.brand as string, version: example.version, tab: example.tab, focus: example.focus }, served));

  // No game is named in the page's own files.
  const sources = [...readdirSync("src/console").filter((file) => /\.(ts|html|css)$/.test(file) && !file.endsWith(".test.ts"))].map((file) => readFileSync(`src/console/${file}`, "utf8")).join("\n");
  assert.ok(sources.length > 50000);
  for (const game of catalogue.games) assert.ok(!sources.includes(game.game_id) && !sources.includes(game.title), `${game.game_id} is named in the page's files`);

  // The data changed: without the game it chose, the example is another true one, and with no thin record there is none to show.
  const without = await findExamples(get, { ...catalogue, games: catalogue.games.filter((game) => game.game_id !== thin.game) }, evaluation);
  const other = without.find((example) => example.kind === "thin");
  assert.ok(other?.found && other.game !== undefined && other.brand !== undefined && other.game !== thin.game, "the thin example does not follow the catalogue");
  const otherAnswer = ask(`/api/recommendations?game=${other.game}&brand=${other.brand}&trace=1`);
  assert.ok(otherAnswer.trace?.anchor?.thin === true && held(otherAnswer).some((label) => label.method === "model"));
  const none = await findExamples(get, { ...catalogue, games: catalogue.games.filter((game) => !game.thin) }, evaluation);
  const missing = none.find((example) => example.kind === "thin");
  assert.ok(missing !== undefined && !missing.found && missing.href === undefined && missing.note === "No game in this catalogue shows it.");
});

test("UI-14: the script and the stylesheet the service serves are what the source builds, are in the repository, and carry the notices of what is inside them", async (t) => {
  const built = await buildConsole();
  assert.deepEqual(drift(built), [], 'src/console/dist differs from a fresh build: run "npm run build" and commit the result');
  // A clone has to hold them: a built file that an ignore rule keeps out of the repository serves nothing after "npm install".
  const root = new URL("../../", import.meta.url);
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }).status !== 0) t.diagnostic("not a git checkout: whether the built files are in the repository was not checked");
  else {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ...[...built.keys()].map((name) => `src/console/dist/${name}`)], { cwd: root, encoding: "utf8" });
    assert.equal(tracked.status, 0, `a built file is not in the repository: ${tracked.stderr.trim()}`);
  }
  const notices = built.get("THIRD-PARTY-NOTICES.txt") ?? "";
  for (const name of ["react ", "react-dom ", "scheduler ", "@ui-sdk/react ", "@ui-sdk/core ", "metal-fx "]) assert.ok(notices.includes(`\n${name}`), `no notice for ${name}`);
  for (const licence of ["MIT License", "Apache License", "Paper Design"]) assert.ok(notices.includes(licence), `the notices do not carry: ${licence}`);
  // The built script reaches nothing but this service: every address it could fetch is a path of its own.
  const script = built.get("app.js") ?? "";
  assert.ok(script.includes("/api/recommendations") && script.includes("/api/what-if"));
  assert.ok(!/fetch\(\s*["'`]https?:/.test(script) && !/import\(\s*["'`]https?:/.test(script), "the built script fetches from another host");
});

test("UI-15: a returned game is described as above the similarity floor and live on the brand, and is never called related", async () => {
  let checked = 0;
  for (const brand of brands) {
    for (const game of games) {
      for (const version of VERSIONS) {
        const data = await load(game, brand, version);
        // The page's own words. A failure is quoted from the evaluation, which says "related" of what its answer key decides.
        const shown = text(section("shown", data).replaceAll(/<p class="callout amber" data-failure="">.*?<\/p>/g, ""));
        assert.ok(!/related/i.test(shown), `${game} on ${brand} in ${version}: the section calls a game related`);
        assert.ok(!/related/i.test(text(section("removed", data))), `${game} on ${brand} in ${version}: the path calls a game related`);
        if (data.response.results.length > 0) {
          checked += 1;
          assert.ok(shown.includes("scored above the similarity floor"));
        }
      }
    }
  }
  assert.ok(checked > 300);
  // The one place the word stands is the evaluation's own measure, where the answer key decides it.
  assert.ok(RANKED_RIGHT.includes("a game the answer key calls related scores above one it calls unrelated") && section("worth", await load(games[0] as string, home)).includes(esc(RANKED_RIGHT)));
});

test("UI-16: what the page says the lookup table and the model found is read from the record, in every version", async () => {
  let withLabels = 0;
  let without = 0;
  for (const game of games) {
    for (const version of VERSIONS) {
      const data = await load(game, home, version);
      const anchor = data.response.trace?.anchor;
      assert.ok(anchor);
      const said = text(/data-story="">(.*?)<\/p>/.exec(section("added", data))?.[1] ?? "");
      const found = anchor.steps.table.themes.length + anchor.steps.table.mechanics.length;
      const mine = held(data.response);
      const fromModel = mine.filter((label) => label.method === "model").length;
      const where = `${game} in ${version}: "${said}"`;
      const lower = said.toLowerCase();
      if (anchor.steps.conflict === null) {
        if (found === 0) {
          without += 1;
          assert.ok(lower.includes("the lookup table found no label in the supplier's tags;"), where);
        } else {
          withLabels += 1;
          assert.ok(lower.includes(`the lookup table read ${found} label${found === 1 ? "" : "s"} from the supplier's tags;`) && !lower.includes("found no label"), where);
        }
      } else assert.ok(lower.includes("so the lookup table asserts no mechanic;"), where);
      assert.equal(said.trim().startsWith("A thin record:"), anchor.thin, where);
      if (anchor.fields === null) assert.ok(said.includes("holds no labels"), where);
      else if (!anchor.steps.model.used) assert.ok(said.includes(`does not use the model for this record and holds ${mine.length - fromModel} label`), where);
      else if (fromModel === 0) assert.ok(said.includes("holds no label from it"), where);
      else assert.ok(said.includes(`holds ${fromModel} label${fromModel === 1 ? "" : "s"} the model read from the text`), where);
      // One sentence.
      assert.equal(said.trim().split(". ").length, 1, where);
    }
  }
  assert.ok(withLabels > 100 && without > 0, `the table found labels on ${withLabels} pages and none on ${without}`);
});

test("UI-17: a failure the evaluation found is shown where it happened, and nowhere else", async () => {
  const { real } = evaluation.report.gallery;
  assert.ok(real.length > 0, "the evaluation lists no failure, so nothing was checked");
  const seen = new Map<string, string[]>(real.map((entry) => [entry.what, []]));
  for (const brand of brands) {
    for (const game of games) {
      for (const version of VERSIONS) {
        const data = await load(game, brand, version);
        const { response } = data;
        const drawn = `${section("shown", data)}${section("added", data)}`;
        const here = failuresHere(evaluation, response);
        assert.equal(drawn.split("data-failure").length - 1, here.length, `${game} on ${brand} in ${version}: the page does not draw the failures that happened there`);
        for (const entry of here) {
          seen.get(entry.what)?.push(`${brand} ${version}`);
          const detail = entry.detail as { brand?: string; result?: { game_id: string } };
          assert.equal(entry.game_id, game);
          assert.ok(entry.version === null || entry.version === version, `${game} on ${brand}: a failure of ${entry.version} is shown in ${version}`);
          if (detail.brand !== undefined) assert.equal(detail.brand, brand, `${game}: a failure found on ${detail.brand} is shown on ${brand}`);
          if (detail.result !== undefined) assert.ok(response.results.some((result) => result.game_id === detail.result?.game_id), `${game} on ${brand}: the failure is about a result that is not on screen`);
          if (/declined/.test(entry.kind)) assert.equal(response.outcome, "declined", `${game} on ${brand}: a failure about a decline is shown beside results`);
          if (!entry.kind.startsWith("label_") && response.outcome === "declined") assert.notEqual(response.decline?.reason, "anchor_not_available", `${game} on ${brand}: a failure is shown beside a decline for another reason`);
        }
      }
    }
  }
  // Every failure the evaluation lists is shown on a request, so the rule is not passing by showing nothing. The one exception
  // is a failure of the ranking for a game the service declines on every brand: no request shows a ranking for it.
  let onRequests = 0;
  for (const entry of real) {
    assert.ok(text(part("gallery")).includes(entry.what), `the failure "${entry.kind}" is not in the list of failures`);
    if ((seen.get(entry.what) ?? []).length > 0) onRequests += 1;
    else for (const brand of brands) assert.equal((await load(entry.game_id, brand, entry.version ?? served)).response.trace?.scores.length ?? 0, 0, `the failure "${entry.kind}" on ${entry.game_id} is shown on no page, though ${brand} shows a ranking for it`);
  }
  assert.ok(onRequests >= 3, `only ${onRequests} of the ${real.length} failures are shown on a request`);
  // The one a reviewer found: a decline recorded on one brand is not shown under the same game on another.
  const declined = real.find((entry) => typeof (entry.detail as { brand?: unknown }).brand === "string");
  assert.ok(declined, "the evaluation lists no failure that names a brand, so the case was not checked");
  const there = (declined.detail as { brand: string }).brand;
  for (const brand of brands) {
    const html = section("shown", await load(declined.game_id, brand, declined.version ?? served));
    assert.equal(html.includes(esc(declined.what)), brand === there, `${declined.game_id} on ${brand}`);
  }
});

test("UI-18: a late answer is never shown for another request", async () => {
  const latest = latestOnly();
  const after = (ms: number, value: string): Promise<string> => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const [first, second] = await Promise.all([latest(() => after(40, "the first game")), latest(() => after(5, "the second game"))]);
  assert.equal(first, null, "the answer to the first request was kept though a second request had been made");
  assert.deepEqual(second, { value: "the second game" });
  // In order, each is kept.
  assert.deepEqual(await latest(() => after(1, "the third")), { value: "the third" });
});

test("UI-19: a brand, a version, a section or a parameter the page does not know is reported for what it is, and nothing is replaced in silence", () => {
  const brand = brands[0] as string;
  const game = games[0] as string;
  const clean = readAddress(`?game=${game}&brand=${brand}&version=raw&tab=worth&focus=${games[1]}`, catalogue);
  assert.deepEqual(clean, { game, brand, version: "raw", tab: "worth", focus: games[1], empty: false, problems: [] });
  assert.deepEqual(readAddress("", catalogue), { game: null, brand: null, version: served, tab: "shown", focus: null, empty: true, problems: [] });

  const one = (search: string): string => {
    const { problems } = readAddress(search, catalogue);
    assert.equal(problems.length, 1, `${search}: ${problems.join(" | ")}`);
    assert.ok(!/required|missing/i.test(problems[0] as string), `${search} is reported as a missing parameter: ${problems[0]}`);
    return problems[0] as string;
  };
  // A brand in the wrong case is an unknown brand, said with the brands there are.
  const miscased = one(`?game=${game}&brand=${brand.toUpperCase()}`);
  assert.ok(miscased.includes(`"${brand.toUpperCase()}"`) && miscased.includes(brands.join(", ")) && miscased.includes("must match exactly"));
  assert.equal(readAddress(`?game=${game}&brand=${brand.toUpperCase()}`, catalogue).brand, null);
  const version = one(`?game=${game}&brand=${brand}&version=RAW`);
  assert.ok(version.includes('"RAW"') && version.includes(VERSIONS.join(", ")));
  assert.ok(one(`?game=${game}&brand=${brand}&tab=nope`).includes('"nope"'));
  assert.ok(one(`?game=${game}&brand=${brand}&show=added`).includes('"show"'));
  // A brand with no game keeps the brand, and says a game is needed.
  const alone = readAddress(`?brand=${brand}`, catalogue);
  assert.equal(alone.brand, brand);
  assert.equal(alone.empty, false);
  assert.ok(one(`?brand=${brand}`).includes(`names the brand "${brand}" and no game`));
  assert.ok(one(`?game=${game}`).includes("and no brand"));
  // The page draws each problem, as text.
  const drawn = render(h(AddressProblems, { problems: [miscased, version] }));
  assert.ok(drawn.includes("data-address-problem") && drawn.includes(esc(miscased)) && drawn.includes(esc(version)));
  assert.equal(render(h(AddressProblems, { problems: [] })), "");
});

test("UI-20: the split by record condition is not offered as the model's work, the limits are the plan's, and the held-back answers are described as they are", () => {
  const { report } = evaluation;
  const numbers = text(part("numbers"));
  assert.ok(!/where the model helps/i.test(numbers), "the split is still offered as where the model helps");
  // A version that calls the model for only some records is said to, with the report's own counts.
  const partial = VERSIONS.filter((version) => report.matching[version].cost.model_calls > 0 && report.matching[version].cost.model_calls < report.games);
  assert.ok(partial.length > 0, "no version calls the model for only some records, so the note was not checked");
  for (const version of partial) assert.ok(numbers.includes(`${versionName(version)} called the model for ${report.matching[version].cost.model_calls} of the ${report.games} records.`));
  assert.ok(numbers.includes("a gap on a row is not evidence that the model read those records well"));
  // The limits: the answer key is the generator's plan, and the text was written by the model that enriches it. Both are checked against the code.
  assert.ok(LIMITS.includes("Its answer key is the generator's own plan") && LIMITS.includes("its text was written by the same model that does the enrichment"));
  assert.equal(CATALOGUE_TEXT_MODEL, ENRICHMENT_MODEL, "the catalogue text and the enrichment no longer come from one model, so the limits text is wrong");
  assert.equal(report.models.enrichment, ENRICHMENT_MODEL);
  assert.ok(!/answer key[^.]*one vendor/i.test(LIMITS));
  assert.ok(text(part("limits")).includes(LIMITS) && text(evidence("measures", null)).includes(PARTS.measures.limits));
  // While the owner's check is outstanding the page says what is held back and where it is, and shows none of it.
  const measures = part("enrichment");
  if (report.owner_check.status === "outstanding") {
    assert.ok(measures.includes("data-held-back") && text(measures).includes(`${report.reviewer.held_back} of the reviewer's ${report.reviewer.questions} answers`));
    assert.ok(text(measures).includes("kept out of the working tree and out of every count on this page"));
    assert.ok(text(measures).includes("They are not out of reach: the repository's history still holds them"));
    assert.ok(!/not in the repository/i.test(text(measures)), "the page still says the answers are not in the repository");
    assert.ok(!measures.includes("The owner&#x27;s check</caption>"));
    // It points a reader at no commit and no file that holds them.
    assert.ok(!/held-back\.json|[0-9a-f]{7,40}\b.*held/i.test(text(measures)));
  }
});
