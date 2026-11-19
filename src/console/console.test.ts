/**
 * Proofs of the console's invariants (docs/features/interface.md). The console's views are plain
 * functions from the service's responses to HTML, so they are run here against the real service
 * for every game on every brand. What needs a browser (clicking, the slider's thumb) is not proved here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSIONS } from "../pipeline/versions.ts";
import { route } from "../service/http.ts";
import type { Recommendation } from "../service/recommend.ts";
import { loadService } from "../service/state.ts";
import { addressRequest, brandOptions, compareView, esc, findExamples, gameOptions, renderEvaluation, renderExamples, renderTabs, renderTrace, SECTIONS, traceView, turns, versionName, versionOptions, whatIfView } from "./view.js";

const service = loadService();
const games = service.index.records.map((record) => record.game_id);
const { brands } = service.offerings;

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

const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("UI-1: every view asks only this service's own routes, and shows the numbers the response carries", async () => {
  const { get, asked } = getter();
  const evaluation = await get("/api/evaluation");
  const [game, brand] = [games[0] as string, brands[0] as string];
  await traceView(get, { game, brand, version: service.served.version, served: service.served.version });
  await traceView(get, { game, brand, version: "raw", served: service.served.version });
  await compareView(get, { game, brand, versions: VERSIONS, served: service.served.version });
  await whatIfView(get, evaluation, {});
  await whatIfView(get, evaluation, { min_precision: "0.9" });
  assert.ok(asked.length >= 8);
  for (const url of asked) assert.match(url, /^\/api\/(recommendations|inspect|evaluation|what-if)(\?|$)/, url);

  // A view computes nothing: change a score, a floor and a decline reason in the response, and the page shows the changed values.
  const busy = games.map((id) => JSON.parse(route(service, "GET", `/api/recommendations?game=${id}&brand=${brand}&trace=1`).body) as Recommendation).find((response) => response.results.length > 0);
  assert.ok(busy?.trace !== undefined && busy.results[0] !== undefined && busy.trace.scores[0] !== undefined);
  busy.results[0].score = 0.123456;
  busy.trace.scores[0].score = 0.654321;
  busy.trace.floor = 0.111111;
  const html = renderTrace(busy);
  for (const value of ["0.123456", "0.654321", "0.111111"]) assert.ok(html.includes(value), `${value} is not on the page`);
});

test("UI-2: every declined request shows its reason, the word declined and no results, and never a failure label", () => {
  const seen = new Set<string>();
  for (const brand of brands) {
    for (const game of [...games, "no-such-game"]) {
      const response = JSON.parse(route(service, "GET", `/api/recommendations?game=${game}&brand=${brand}&trace=1`).body) as Recommendation;
      if (response.outcome !== "declined") continue;
      const html = renderTrace(response);
      seen.add(response.decline?.reason ?? "");
      assert.ok(html.includes("data-decline") && text(html).includes("declined"), `${game} on ${brand}`);
      assert.ok(html.includes(`<code>${response.decline?.reason}</code>`));
      assert.ok(text(html).includes("A player would see nothing."));
      assert.ok(!html.includes("data-results") && !html.includes('class="label green">result<'), `${game} on ${brand} shows results beside a decline`);
      assert.ok(!html.includes('class="label red"'), "a decline is shown as a failure");
    }
  }
  assert.deepEqual([...seen].sort(), ["anchor_not_available", "insufficient_data", "nothing_above_floor", "unknown_game"]);
});

test("UI-2: a link that names a game the index does not hold shows the unknown-game decline, not a missing-parameter message", async () => {
  const { get, asked } = getter();
  const catalogue = await get("/api/catalogue");
  const brand = brands[0] as string;
  // The picker keeps the game the link asked for, so the request goes out as asked.
  const options = gameOptions(catalogue, brand, "nope-00000");
  assert.deepEqual(options[0], { value: "nope-00000", text: "nope-00000 · not in the index" });
  assert.equal(options.length, games.length + 1);
  // A game the index holds adds no option, and no link adds none.
  assert.equal(gameOptions(catalogue, brand, games[0]).length, games.length);
  assert.equal(gameOptions(catalogue, brand, null).length, games.length);
  const html = await traceView(get, { game: options[0]?.value as string, brand, version: service.served.version, served: service.served.version });
  assert.ok(asked.at(-1)?.includes("game=nope-00000"));
  assert.ok(html.includes("<code>unknown_game</code>") && text(html).includes("declined"));
  assert.ok(!text(html).includes("is required"));
});

test("UI-3: the page is served, and for every brand and game in its pickers the trace renders, in every version", async () => {
  const page = route(service, "GET", "/");
  assert.equal(page.status, 200);
  for (const id of ['id="brand"', 'id="game"', 'id="version"', 'id="trace"', 'id="compare"', 'id="evaluation-body"', "<h1"]) assert.ok(page.body.includes(id), id);
  for (const asset of [...page.body.matchAll(/(?:src|href)="(\/console\/[^"]+)"/g)].map((match) => match[1] as string)) assert.equal(route(service, "GET", asset).status, 200, asset);
  // app.js imports the views from the path the service serves them at.
  assert.ok(route(service, "GET", "/console/app.js").body.includes('from "/console/view.js"'));
  assert.equal(route(service, "GET", "/console/view.js").body, readFileSync("src/console/view.js", "utf8"));

  const catalogue = JSON.parse(route(service, "GET", "/api/catalogue").body) as { brands: { brand: string }[]; games: { game_id: string }[]; versions: string[] };
  assert.equal(catalogue.games.length, games.length);
  const { get } = getter();
  let rendered = 0;
  for (const { brand } of catalogue.brands) {
    for (const { game_id: game } of catalogue.games) {
      for (const version of catalogue.versions) {
        const html = await traceView(get, { game, brand, version, served: service.served.version });
        assert.ok(html.includes('id="outcome"'), `${game} on ${brand} in ${version} has no outcome`);
        if (html.includes("data-results")) for (const part of ["raw-record", "enrichment", "removals", "scores"]) assert.ok(html.includes(`id="${part}"`), `${game} on ${brand}: no ${part}`);
        rendered += 1;
      }
      const compare = await compareView(get, { game, brand, versions: catalogue.versions, served: service.served.version });
      assert.equal(compare.split("<td>").length - 1, 4 * catalogue.versions.length);
    }
  }
  assert.equal(rendered, catalogue.brands.length * catalogue.games.length * catalogue.versions.length);
  const evaluation = renderEvaluation(await get("/api/evaluation"));
  for (const part of ["race", "where-it-helps", "enrichment-measures", "gallery", "what-if-open"]) assert.ok(evaluation.includes(`id="${part}"`), part);
  // While the owner's check is outstanding the panel says what is held back, and shows none of the six.
  const report = service.report as { owner_check: { status: string; questions: unknown[] }; reviewer: { held_back: number } };
  if (report.owner_check.status === "outstanding") {
    assert.ok(evaluation.includes("data-held-back") && text(evaluation).includes(`${report.reviewer.held_back} of the reviewer's`));
    // They are out of the working tree, not out of the repository: the page says the first and never the second.
    assert.ok(text(evaluation).includes("held out of the working tree, not erased from the repository's history, and are in no count on this page"));
    assert.ok(!text(evaluation).includes("not in the repository"));
    assert.ok(!evaluation.includes("The owner's check</caption>"));
  }
});

test("UI-4: the what-if panel says the gate reads only the committed file, shows the committed mark, and moving a mark flips pass and fail without touching a file", async () => {
  const before = { thresholds: readFileSync("eval/thresholds.json"), verdict: readFileSync("eval/results/verdict.json") };
  const { get, asked } = getter();
  const evaluation = await get("/api/evaluation");
  const committed = await whatIfView(get, evaluation, {});
  assert.ok(text(committed).includes("The release gate reads only the committed file eval/thresholds.json"));
  assert.ok(text(committed).includes("Moving a slider changes no file"));
  const marks = JSON.parse(before.thresholds.toString("utf8")) as { enrichment: Record<string, number>; matching: Record<string, number> };
  for (const [key, value] of [...Object.entries(marks.enrichment), ...Object.entries(marks.matching)]) {
    assert.ok(committed.includes(`name="${key}"`) && committed.includes(`value="${value}"`), `no slider for ${key} at ${value}`);
    assert.ok(text(committed).includes(`committed: ${value}`));
  }
  assert.equal(committed.split('class="tick"').length - 1, Object.keys(marks.enrichment).length + Object.keys(marks.matching).length + 1);
  assert.ok(text(committed).includes(`would ship: ${versionName(service.verdict.ships ?? "")}`));

  const moved = await whatIfView(get, evaluation, { min_pairwise_accuracy: "0.99" });
  assert.ok(text(moved).includes("nothing would ship"));
  assert.ok(moved.split('class="label red">fail<').length > committed.split('class="label red">fail<').length);
  assert.ok(moved.includes('class="label amber">moved<') && !committed.includes('class="label amber">moved<'));
  assert.ok(asked.every((url) => url.startsWith("/api/")));
  assert.deepEqual(readFileSync("eval/thresholds.json"), before.thresholds);
  assert.deepEqual(readFileSync("eval/results/verdict.json"), before.verdict);
});

test("UI-5: text from the catalogue and from a model reaches the page as text, never as markup", async () => {
  // A response in which every string is hostile.
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const poison = (value: unknown): unknown => {
    if (typeof value === "string") return hostile;
    if (Array.isArray(value)) return value.map(poison);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poison(item)]));
    return value;
  };
  const { get } = getter();
  const real = JSON.parse(route(service, "GET", `/api/inspect?game=${games[0]}&brand=${brands[0]}&version=model_everywhere`).body) as Recommendation;
  const keep = { outcome: real.outcome, served: real.served };
  for (const html of [
    renderTrace({ ...(poison(real) as object), ...keep }),
    renderEvaluation({ ...(poison(await get("/api/evaluation")) as { report: object }), thresholds_file: hostile }),
  ]) {
    assert.ok(!html.includes("<script") && !html.includes("<img"), "hostile text reached the page as markup");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  }
  // The records that carry markup or a planted instruction render with their text escaped.
  const marked = service.index.records.filter((record) => /<p>|&amp;|&#39;/.test(record.canonical.description_as_delivered ?? ""));
  assert.ok(marked.length > 0);
  for (const record of marked) {
    const html = await traceView(get, { game: record.game_id, brand: brands[0] as string, version: "raw", served: service.served.version });
    const delivered = record.canonical.description_as_delivered ?? "";
    assert.ok(!html.includes(delivered), `${record.game_id}: the delivered description reached the page unescaped`);
    assert.ok(html.includes(esc(delivered)), `${record.game_id}: the delivered description is not on the page`);
  }
});

test("UI-6: for a game whose tag contradicts its description, the page shows the conflict and how each version handled it", async () => {
  const { get } = getter();
  const conflicts = service.index.records.filter((record) => record.conflict !== null);
  assert.ok(conflicts.length > 0, "the index holds no conflict to show");
  for (const record of conflicts) {
    const brand = brands.find((candidate) => service.offerings.statusByBrand.get(candidate)?.get(record.game_id) === "live") ?? (brands[0] as string);
    const page = async (version: string): Promise<string> => text(await traceView(get, { game: record.game_id, brand, version, served: service.served.version }));
    const table = await page("table");
    const model = await page("model_everywhere");
    for (const html of [table, model]) {
      assert.ok(html.includes(`The tag ${record.conflict?.tag} asserts`), `${record.game_id}: the contradicted tag is not named`);
      assert.ok(html.includes("the table version asserts no mechanic"));
    }
    assert.ok(table.includes("Mechanics conflicting"), `${record.game_id}: the table version does not show its mechanics as conflicting`);
    const used = record.versions.model_everywhere.mechanics?.labels ?? [];
    if (record.conflict?.model_reading_used === true) {
      assert.ok(used.length > 0 && !model.includes("Mechanics conflicting"));
      for (const label of used) assert.ok(model.includes(`“${label.quote}”`), `${record.game_id}: the quote behind ${label.label} is not shown`);
    } else {
      assert.ok(model.includes("the field stays empty in every version"));
    }
    // Side by side: one column per version, the table's cell says conflicting and a resolved model cell lists labels.
    const compare = await compareView(get, { game: record.game_id, brand, versions: VERSIONS, served: service.served.version });
    const mechanics = compare.split("<tr>").find((row) => row.includes(">Mechanics</th>")) ?? "";
    const cells = mechanics.split("<td>").slice(1);
    assert.equal(cells.length, VERSIONS.length);
    assert.ok((cells[VERSIONS.indexOf("table")] ?? "").includes("conflicting"));
    if (record.conflict?.model_reading_used === true) assert.ok((cells[VERSIONS.indexOf("model_where_thin")] ?? "").includes('class="tag model"'));
  }
});

/** One request as the service answers it. */
const ask = (path: string): Recommendation => JSON.parse(route(service, "GET", path).body) as Recommendation;
/** The brand with the most live games, as the catalogue route counts them. */
const home = ((JSON.parse(route(service, "GET", "/api/catalogue").body) as { brands: { brand: string; live: number }[] }).brands.sort((a, b) => b.live - a.live)[0] as { brand: string }).brand;
type Held = { label: string; method: string; quote: string; source_field: string };
const held = (response: Recommendation): (Held & { field: string })[] => {
  const fields = response.trace?.anchor?.fields;
  if (!fields) return [];
  return (["themes", "mechanics"] as const).flatMap((field) => (fields[field]?.labels ?? []).map((label) => ({ ...(label as Held), field })));
};

test("UI-7: a quote is marked where it sits in the record's own text, and a bar is as long as the number the response carries", () => {
  const marksIn = (html: string): string[] => [...html.matchAll(/<mark>(.*?)<\/mark>/g)].map((match) => match[1] as string);
  const plain = (html: string): string => html.replaceAll(/<sup class="ref">[^<]*<\/sup>/g, "").replaceAll(/<\/?mark>/g, "");
  let quotesSeen = 0;
  for (const game of games) {
    const response = ask(`/api/inspect?game=${game}&brand=${home}&version=model_everywhere`);
    const anchor = response.trace?.anchor;
    assert.ok(anchor, `${game}: no record in the trace`);
    const html = renderTrace(response);
    const texts = [...html.matchAll(/<p class="copy">(.*?)<\/p>/g)].map((match) => match[1] as string);
    for (const field of ["title", "description"] as const) {
      const text = anchor.steps.cleaned[field];
      const quotes = held(response).filter((entry) => entry.source_field === field).map((entry) => entry.quote);
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
    // The one phrase shown on its own is a quote of a label the model added and this version holds.
    const phrase = /<blockquote data-phrase>“(.*?)”<\/blockquote>/.exec(html)?.[1];
    const fromModel = held(response).filter((entry) => entry.method === "model");
    if (fromModel.length === 0) assert.equal(phrase, undefined, `${game}: a phrase is shown though the model added nothing`);
    else assert.ok(fromModel.some((entry) => esc(entry.quote) === phrase), `${game}: the phrase shown is not one the model quoted`);
  }
  assert.ok(quotesSeen > 0, "no quote was checked");

  // A quote that is not in the text is said, not dropped; and a bar follows the number in the response.
  const busy = games.map((id) => ask(`/api/inspect?game=${id}&brand=${home}&version=model_everywhere`)).find((response) => response.results.length > 0 && held(response).some((entry) => entry.method === "model" && entry.source_field === "description"));
  assert.ok(busy?.trace?.anchor?.fields && busy.trace.scores[0] !== undefined);
  const lost = [...busy.trace.anchor.fields.themes.labels, ...busy.trace.anchor.fields.mechanics.labels].find((entry) => entry.method === "model" && entry.source_field === "description");
  assert.ok(lost);
  lost.quote = "words that are nowhere in this record";
  busy.trace.scores[0].score = 0.4321;
  busy.trace.floor = 0.1234;
  const changed = renderTrace(busy);
  assert.equal(changed.split("words not found in the record").length - 1, 1);
  assert.ok(changed.includes('style="width:43.21%"'), "the bar is not as long as the score");
  assert.ok(changed.includes('style="left:12.34%"'), "the tick is not at the floor");
});

test("UI-8: the page is four sections in a fixed order, one open at a time; each states its question, why it matters and a sentence that answers it, with the detail folded away", async () => {
  const { get } = getter();
  const evaluation = await get("/api/evaluation");
  assert.deepEqual(SECTIONS.map((section) => section.id), ["shown", "added", "removed", "worth"]);
  let results = 0;
  let declines = 0;
  for (const brand of brands) {
    for (const game of [...games, "no-such-game"]) {
      const html = await traceView(get, { game, brand, version: service.served.version, served: service.served.version, versions: VERSIONS, evaluation });
      // The first section is the outcome, and it is the one open unless another is asked for.
      assert.equal(html.indexOf('<section id="outcome"'), 0, `${game} on ${brand}: the page does not start with the outcome`);
      const panes = html.split(/(?=<section id="[a-z]+" class="pane")/);
      assert.deepEqual(panes.map((pane) => /data-section="([a-z]+)"/.exec(pane)?.[1]), ["shown", "added", "removed", "worth"], `${game} on ${brand}`);
      for (const [index, pane] of panes.entries()) {
        const section = SECTIONS[index];
        assert.ok(section !== undefined);
        assert.equal(/^<section [^>]*hidden>/.test(pane), index !== 0, `${game} on ${brand}: ${section.id} is ${index === 0 ? "hidden" : "open"} on arrival`);
        assert.ok(pane.includes(`<h2 data-question>${esc(section.question)}</h2>`) && pane.includes(esc(section.why)), `${game} on ${brand}: ${section.id} does not state its question`);
        const answer = /<div class="says" data-answer>(.*?)<\/div>/s.exec(pane)?.[1] ?? "";
        assert.ok(text(answer).trim().length > 40, `${game} on ${brand}: ${section.id} has no sentence that answers its question`);
        // The question comes before its answer.
        assert.ok(pane.indexOf("data-question") < pane.indexOf("data-answer"));
      }
      const first = panes[0] ?? "";
      if (first.includes("data-results")) results += 1;
      else {
        declines += 1;
        assert.ok(first.includes("data-decline"), `${game} on ${brand}: neither a result nor a decline`);
        assert.match(text(first), /Given .+ on .+, the service recommends nothing, and says why\./);
      }
      // What is true and not first is on the page, closed, each under its own named control.
      assert.ok(!/<details[^>]* open/.test(html), `${game} on ${brand}: a drawer starts open`);
      // A reader never sees the word for the program's own part: it is "the page".
      assert.ok(!/\bconsole\b/i.test(text(html)), `${game} on ${brand}: the page calls itself a console`);
    }
  }
  assert.ok(results > 0 && declines > 0);
  // Asked for another section, that one is open and no other.
  const third = await traceView(get, { game: games[0] as string, brand: home, served: service.served.version, section: "removed" });
  assert.deepEqual([...third.matchAll(/<section id="[a-z]+" class="pane" data-section="([a-z]+)"[^>]*?( hidden)?>/g)].filter((match) => match[2] === undefined).map((match) => match[1]), ["removed"]);
  const summaries = [...(await traceView(get, { game: games[0] as string, brand: home, served: service.served.version })).matchAll(/<summary>(.*?)<\/summary>/g)].map((match) => text(match[1] as string).trim());
  assert.equal(new Set(summaries).size, summaries.length, "two controls carry the same name");
  for (const summary of summaries) assert.ok(summary.length > 20 && !/^(show )?(more|details)$/i.test(summary), `"${summary}" does not say what it opens`);
  // The links that switch sections carry the request and the section, so the address opens the same view.
  const tabs = renderTabs("added", { game: "a b", brand: home, version: "raw" });
  assert.deepEqual([...tabs.matchAll(/href="([^"]+)" data-tab="([a-z]+)"( aria-current="true")?/g)].map((match) => [match[1], match[2], match[3] !== undefined]), SECTIONS.map((section) => [`/?game=a+b&amp;brand=${home}&amp;version=raw&amp;section=${section.id}`, section.id, section.id === "added"]));
  for (const section of SECTIONS) assert.equal(addressRequest(`?game=x&brand=${home}&section=${section.id}`, await get("/api/catalogue")).section, section.id);
  assert.equal(addressRequest("?section=nonsense", await get("/api/catalogue")).section, "shown");
});

test("UI-9: what a result is said to have in common with the game played is held by both, and it is never offered as the cause of the score", async () => {
  const { get } = getter();
  let cards = 0;
  for (const game of games) {
    const response = ask(`/api/recommendations?game=${game}&brand=${home}&trace=1`);
    if (response.outcome !== "results") continue;
    const html = await traceView(get, { game, brand: home, version: service.served.version, served: service.served.version });
    const mine = held(response);
    const items = (html.split('<ol class="results" data-results>')[1] ?? "").split("</ol>")[0]?.split("<li ").slice(1) ?? [];
    assert.equal(items.length, response.results.length);
    for (const [index, result] of response.results.entries()) {
      const theirs = held(ask(`/api/inspect?game=${result.game_id}&brand=${home}&version=${service.served.version}`));
      const expected = mine.filter((label) => theirs.some((other) => other.field === label.field && other.label === label.label)).map((label) => label.label.replaceAll("_", " "));
      const shown = [...(items[index] ?? "").matchAll(/<span class="tag (?:model|table)">(.*?)<\/span>/g)].map((match) => match[1] as string);
      assert.deepEqual(shown, expected.map((label) => esc(label)), `${game}: what ${result.game_id} has in common is not what both hold`);
      if (expected.length === 0) assert.ok(text(items[index] ?? "").includes("No label in common"), `${game}: ${result.game_id} shows no reason and does not say so`);
      cards += 1;
    }
    assert.ok(text(html).includes("cannot be traced to single labels") && text(html).includes("not as the cause of its score"));
    assert.ok(!/because (it|they) share|ranked (first|higher) because/i.test(text(html)));
  }
  assert.ok(cards > 100, `only ${cards} results were checked`);
});

test("UI-10: beside the result, the other versions' answers are counted as the service gave them and the measured numbers are the report's; a different list is not called better", async () => {
  const { get } = getter();
  const evaluation = (await get("/api/evaluation")) as { report: { matching: Record<string, { pairwise: { pooled: { rate: number } }; cost: { estimated_usd: number; model_calls: number } }> } };
  let differing = 0;
  for (const game of games) {
    const html = await traceView(get, { game, brand: home, version: service.served.version, served: service.served.version, versions: VERSIONS, evaluation });
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    const worth = html.slice(html.indexOf('<section id="worth"'));
    assert.ok(aside.length > 0 && worth.includes("<aside") && worth.indexOf("data-answer") < worth.indexOf("<aside"), `${game}: the measured numbers are not in the fourth section, under its answer`);
    const mine = ask(`/api/recommendations?game=${game}&brand=${home}`).results.map((entry) => entry.game_id);
    const lines = (aside.split("data-others>")[1] ?? "").split("</ul>")[0]?.split("<li>").slice(1) ?? [];
    const others = VERSIONS.filter((version) => version !== service.served.version);
    assert.equal(lines.length, others.length);
    for (const [index, version] of others.entries()) {
      const other = ask(`/api/inspect?game=${game}&brand=${home}&version=${version}`);
      const theirs = other.results.map((entry) => entry.game_id);
      const same = theirs.filter((id) => mine.includes(id)).length;
      const line = text(lines[index] ?? "");
      assert.ok(line.includes(versionName(version)), `${game}: no line for ${version}`);
      assert.ok(line.includes(evaluation.report.matching[version]?.cost.model_calls === 0 ? "no model" : "model"), `${game}: ${version} is not marked by how it was built`);
      if (other.outcome === "declined") assert.ok(line.includes("declines"), `${game}: ${version} declines and the line does not say so`);
      else if (mine.length === 0) assert.ok(line.includes(`returns ${theirs.length} game`));
      else if (same === mine.length && theirs.length === same) assert.ok(line.includes("the same games"), `${game}: ${version} returns the same games`);
      else {
        differing += 1;
        assert.ok(line.includes(`${same} of these ${mine.length}`), `${game}: ${version} shares ${same} of ${mine.length}, the line says "${line}"`);
        if (theirs.length > same) assert.ok(line.includes(`and ${theirs.length - same} other`), `${game}: ${version} returns ${theirs.length - same} other game(s)`);
      }
    }
    assert.ok(text(aside).includes("A different list is not a better list."));
  }
  assert.ok(differing > 0, "no version ever differed, so the differing case was not checked");
  const html = await traceView(get, { game: games[0] as string, brand: home, served: service.served.version, versions: VERSIONS, evaluation });
  const measured = (html.split("data-measured>")[1] ?? "").split("</table>")[0] ?? "";
  for (const version of VERSIONS) {
    const row = evaluation.report.matching[version];
    assert.ok(row !== undefined && text(measured).includes(`${(row.pairwise.pooled.rate * 100).toFixed(1)}%`) && measured.includes(`$${row.cost.estimated_usd.toFixed(4)}`), `${version}: its measured numbers are not beside the result`);
  }
  assert.ok(text(html).includes("It shows direction, not how real players would judge a list."));
  assert.ok(renderEvaluation(evaluation).includes("data-limits"));
});

test("UI-11: the path shows the trace's own counts in the trace's order, availability first, as three different things, and points out a game where it was removed", () => {
  let limited = 0;
  for (const brand of brands) {
    for (const game of games) {
      const response = ask(`/api/recommendations?game=${game}&brand=${brand}&trace=1`);
      const filters = response.trace?.filters ?? [];
      if (filters.length === 0) continue;
      const html = renderTrace(response);
      const path = html.slice(html.indexOf('<section id="removals"'), html.indexOf('<details id="scores"') === -1 ? html.indexOf('<section id="removals"') + 100000 : html.indexOf('<details id="scores"'));
      const counts = [...path.matchAll(/<span class="n num">([^<]*)<\/span><span class="name">([^<]*)<\/span>/g)].map((match) => [match[1], match[2]]);
      const first = filters[0];
      assert.ok(first !== undefined && first.filter === "not_live_on_brand", `${game} on ${brand}: availability is not the first filter`);
      assert.deepEqual(counts[0], [String(first.removed.length + first.remaining), "In the catalogue"]);
      assert.deepEqual(counts[1], [String(first.remaining), "Live on this brand"]);
      assert.deepEqual(counts.slice(1, -1).map((entry) => entry[0]), filters.map((step) => String(step.remaining)), `${game} on ${brand}: the counts are not the trace's`);
      assert.deepEqual(counts.at(-1), [String(response.results.length), "Shown"]);
      const stages = [...path.matchAll(/<div class="stage (\w+)">/g)].map((match) => match[1]);
      // Three different things, in this order. A request that ends at the floor has no third.
      assert.deepEqual(stages, ["eligible", "similar", "limit"].slice(0, stages.length), `${game} on ${brand}`);
      assert.ok(stages.length >= 2 && (response.outcome !== "results" || stages.length === 3), `${game} on ${brand}: ${stages.join(", ")}`);
      assert.ok(text(path).includes("Rules, not scores.") && text(path).includes("not that a player would find it relevant"));
      // A game that cleared the floor and is not shown is named, with the reason the trace gives.
      const cut = filters.filter((step) => step.filter === "family_cap" || step.filter === "over_limit").flatMap((step) => step.removed);
      if (stages.length < 3) assert.equal(cut.length, 0);
      else if (cut.length === 0) assert.ok(text(path).includes("Every game that cleared the floor is shown."));
      else if (cut.length <= 3) {
        limited += 1;
        for (const entry of cut) assert.ok(path.includes(`<strong>${esc(entry.title)}</strong> (${esc(entry.why.replaceAll("_", " "))})`), `${game} on ${brand}: ${entry.game_id} cleared the floor, is not shown, and is not named`);
      }
      assert.ok(!path.includes('aria-expanded="true"') && !path.includes("data-focus"), "a step is open though nothing was pointed out");
    }
  }
  assert.ok(limited > 0, "no game was ever cut by the limit, so that sentence was not checked");
  // Pointed at a game the first filter removed, the page opens that step and marks the game.
  const withRemoved = games.map((game) => ask(`/api/recommendations?game=${game}&brand=${home}&trace=1`)).find((response) => (response.trace?.filters[0]?.removed.length ?? 0) > 0);
  const gone = withRemoved?.trace?.filters[0]?.removed[0];
  assert.ok(withRemoved && gone);
  const pointed = renderTrace(withRemoved, { focus: gone.game_id });
  assert.ok(pointed.includes("data-focus") && pointed.includes(`<strong>${esc(gone.title)}</strong> was taken out at the step “Live on this brand”`));
  assert.equal(pointed.split('aria-expanded="true"').length - 1, 1);
  assert.ok(pointed.includes('<div id="step-0" class="step-panel">') && pointed.includes('<li class="focus">'));
});

test("UI-12: the examples are found in the data, each shows what it says, and they follow the data when it changes", async () => {
  const { get, asked } = getter();
  const catalogue = (await get("/api/catalogue")) as { games: { game_id: string; title: string; thin: boolean }[]; served: { version: string } };
  const evaluation = (await get("/api/evaluation")) as { report: { gallery: { real: { game_id: string; what: string }[] } } };
  const examples = await findExamples(get, catalogue, evaluation);
  assert.ok(asked.every((url) => /^\/api\/(catalogue|recommendations|inspect|evaluation)(\?|$)/.test(url)));
  assert.deepEqual(examples.map((example) => example.kind), ["thin", "plain", "conflict", "filter", "decline", "versions", "failure"]);
  for (const example of examples) assert.ok(example.found && example.note.length > 20 && example.href?.startsWith("/?game=") && SECTIONS.some((section) => example.href?.endsWith(`section=${section.id}`) || example.href?.includes(`section=${section.id}&`)), `${example.kind}: ${example.note}`);
  const of = (kind: string) => {
    const example = examples.find((entry) => entry.kind === kind);
    assert.ok(example?.game !== undefined && example.brand !== undefined);
    return { ...example, game: example.game, brand: example.brand, response: ask(`/api/recommendations?game=${example.game}&brand=${example.brand}&trace=1`) };
  };
  // Each example is checked against the service, not against what the finder says about itself.
  const thin = of("thin");
  assert.ok(thin.response.trace?.anchor?.thin === true && thin.response.outcome === "results" && held(thin.response).some((label) => label.method === "model"));
  // The number its line gives is the service's, and no other thin game on that brand gained more.
  const fromModel = (response: Recommendation): number => held(response).filter((label) => label.method === "model").length;
  assert.ok(thin.note.includes(`the model added ${fromModel(thin.response)} from the text`), thin.note);
  const gains = catalogue.games.filter((game) => game.thin).map((game) => ask(`/api/recommendations?game=${game.game_id}&brand=${thin.brand}&trace=1`)).filter((response) => response.outcome === "results").map(fromModel);
  assert.equal(fromModel(thin.response), Math.max(...gains), "another thin game gained more labels than the example");
  const plain = of("plain");
  assert.ok(plain.response.trace?.anchor?.thin === false && held(plain.response).length > 0 && held(plain.response).every((label) => label.method !== "model"));
  assert.ok(plain.note.includes(`already gave ${held(plain.response).length} label`), plain.note);
  const conflict = of("conflict");
  assert.ok(conflict.response.trace?.anchor?.steps.conflict !== null);
  const filter = of("filter");
  assert.ok(filter.focus !== undefined && filter.response.trace?.filters[0]?.removed.some((entry) => entry.game_id === filter.focus));
  assert.ok(brands.some((brand) => ask(`/api/recommendations?game=${filter.game}&brand=${brand}`).results[0]?.game_id === filter.focus), "the removed game is the best match on no brand");
  assert.equal(of("decline").response.outcome, "declined");
  const versions = of("versions");
  assert.ok(new Set(VERSIONS.map((version) => ask(`/api/inspect?game=${versions.game}&brand=${versions.brand}&version=${version}`).results.map((entry) => entry.game_id).join(" "))).size > 1);
  const failure = of("failure");
  assert.ok(evaluation.report.gallery.real.some((entry) => entry.game_id === failure.game));
  // Opened, the failure is said on the first screen in the evaluation's own words.
  const opened = await traceView(get, { game: failure.game, brand: failure.brand, served: service.served.version, evaluation });
  const said = evaluation.report.gallery.real.find((entry) => entry.game_id === failure.game)?.what ?? "";
  assert.ok(opened.includes("data-failure") && opened.indexOf("data-failure") < opened.indexOf("</section>") && opened.includes(esc(said)));

  // No game is named in the console's own files.
  const sources = ["view.js", "app.js", "index.html", "console.css"].map((file) => readFileSync(`src/console/${file}`, "utf8")).join("\n");
  for (const game of catalogue.games) assert.ok(!sources.includes(game.game_id) && !sources.includes(game.title), `${game.game_id} is named in the console`);

  // The data changed: without the game it chose, the example is another true one, and with no thin record there is none to show.
  const without = await findExamples(get, { ...catalogue, games: catalogue.games.filter((game) => game.game_id !== thin.game) }, evaluation);
  const other = without.find((example) => example.kind === "thin");
  assert.ok(other?.found && other.game !== thin.game, "the thin example does not follow the catalogue");
  const otherAnswer = ask(`/api/recommendations?game=${other.game}&brand=${other.brand}&trace=1`);
  assert.ok(otherAnswer.trace?.anchor?.thin === true && held(otherAnswer).some((label) => label.method === "model"));
  const none = await findExamples(get, { ...catalogue, games: catalogue.games.filter((game) => !game.thin) }, evaluation);
  const missing = none.find((example) => example.kind === "thin");
  assert.ok(missing !== undefined && !missing.found && missing.href === undefined);
  const drawn = renderExamples(none);
  assert.ok(drawn.includes('<li class="missing">') && text(drawn).includes("No game in this catalogue shows it."));
  // The open example is marked, and its line is shown above the result.
  assert.equal(renderExamples(examples, { game: thin.game, brand: thin.brand }).split('aria-current="true"').length - 1, 1);
  assert.equal(thin.section, "added");
  const pointed = renderTrace(thin.response, { look: { note: thin.note, section: thin.section } });
  const where = pointed.slice(pointed.indexOf('<section id="enrichment"'), pointed.indexOf('<section id="removals"'));
  assert.equal(pointed.split("data-look").length - 1, 1);
  assert.ok(where.includes("data-look") && where.includes(esc(thin.note)), "the example's line is not in the section that shows it");
});

test("UI-14: the sentence over the results claims only what the service guarantees: live on the brand and above the floor, never that the games are related", async () => {
  const { get } = getter();
  const catalogue = (await get("/api/catalogue")) as { games: { game_id: string; status: Record<string, string> }[] };
  const evaluation = (await get("/api/evaluation")) as { report: { check_games: { brand: string; results: Record<string, { anchor: string; results: { grade: string }[] }[]> } } };
  const status = new Map(catalogue.games.map((game) => [game.game_id, game.status]));
  let pages = 0;
  for (const brand of brands) {
    for (const game of games) {
      const response = ask(`/api/recommendations?game=${game}&brand=${brand}&trace=1`);
      if (response.outcome !== "results") continue;
      const first = renderTrace(response, { evaluation }).split('<section id="enrichment"')[0] ?? "";
      const said = text(first);
      assert.match(said, /Given .+ on .+, the service returns \d+ games? that (is|are) live there and cleared the similarity floor, highest score first\. It promises nothing more about them\./, `${game} on ${brand}`);
      assert.ok(!/\brelated\b|\bbest match\b/i.test(said.replace(/a failure the evaluation found.*$/i, "")), `${game} on ${brand}: the first section calls its results related`);
      // What the sentence does claim is true of every game under it.
      for (const result of response.results) {
        assert.equal(status.get(result.game_id)?.[brand], "live", `${result.game_id} is shown on ${brand} and is not live there`);
        assert.ok(response.trace !== undefined && result.score >= response.trace.floor, `${result.game_id} is shown below the floor`);
      }
      pages += 1;
    }
  }
  assert.ok(pages > 100);
  // The evaluation's own rule grades some served results weak or unrelated, which is why "related" cannot be claimed.
  const grades = (evaluation.report.check_games.results[service.served.version] ?? []).flatMap((entry) => entry.results.map((result) => result.grade));
  assert.ok(grades.some((grade) => grade === "unrelated" || grade === "weak"), "no served result is graded weak or unrelated, so this proof has nothing to stand on");
});

test("UI-15: every sentence about what happened to a record follows from that record's own data, in every version", () => {
  let lookedAt = 0;
  let tableFoundAndNotHeld = 0;
  for (const version of VERSIONS) {
    for (const game of games) {
      const response = ask(`/api/inspect?game=${game}&brand=${home}&version=${version}`);
      const anchor = response.trace?.anchor;
      if (!anchor || anchor.fields === null) continue;
      const story = text(/<p class="lede" data-story>(.*?)<\/p>/s.exec(renderTrace(response))?.[1] ?? "");
      assert.ok(story.length > 0, `${game} in ${version}: no sentence`);
      const found = anchor.steps.table.themes.length + anchor.steps.table.mechanics.length;
      const fromModel = held(response).filter((label) => label.method === "model").length;
      const fromTable = held(response).length - fromModel;
      const where = `${game} in ${version}: "${story}"`;
      if (anchor.steps.conflict === null) {
        assert.equal(story.includes("gave the lookup table no usable label"), found === 0, where);
        if (found > 0) assert.ok(story.includes(`The lookup table read ${found} label`), where);
        if (found > 0 && fromTable === 0) {
          tableFoundAndNotHeld += 1;
          assert.ok(story.includes("this version holds none of them"), where);
        }
      }
      assert.equal(story.includes("counts as thin"), anchor.thin && anchor.steps.conflict === null, where);
      const added = /added (\d+) labels?/.exec(story)?.[1];
      assert.equal(added === undefined ? 0 : Number(added), fromModel, where);
      assert.equal(story.includes("The model is not used for this record in this version."), fromModel === 0 && !anchor.steps.model.used, where);
      lookedAt += 1;
    }
  }
  assert.ok(lookedAt > 200);
  assert.ok(tableFoundAndNotHeld > 0, "no record has table labels that its version does not hold, so that sentence was not checked");
});

test("UI-16: a failure the evaluation found is said only where it was found: in that version, and on that brand when it is about a request", async () => {
  const { get } = getter();
  const evaluation = (await get("/api/evaluation")) as { report: { check_games: { brand: string }; gallery: { real: { game_id: string; what: string; version?: string; detail?: { brand?: string; result?: { game_id: string } } }[] } } };
  let shownSomewhere = 0;
  let withheldSomewhere = 0;
  for (const entry of evaluation.report.gallery.real) {
    for (const brand of brands) {
      for (const version of VERSIONS) {
        const response = ask(`/api/inspect?game=${entry.game_id}&brand=${brand}&version=${version}`);
        const html = renderTrace(response, { evaluation });
        const said = html.includes("data-failure") && html.includes(esc(entry.what));
        const about = entry.detail?.brand ?? (entry.detail?.result ? evaluation.report.check_games.brand : null);
        const here = version === entry.version && (about === null || about === brand) && (entry.detail?.result === undefined || response.results.some((result) => result.game_id === entry.detail?.result?.game_id));
        assert.equal(said, here, `${entry.game_id} on ${brand} in ${version}: the failure is ${said ? "said" : "not said"}`);
        if (said) shownSomewhere += 1;
        else withheldSomewhere += 1;
        // A failure about a decline is never said beside a decline for another reason.
        if (said && entry.detail?.brand !== undefined && response.outcome === "declined") assert.equal(response.decline?.reason, ask(`/api/inspect?game=${entry.game_id}&brand=${entry.detail.brand}&version=${entry.version ?? version}`).decline?.reason);
      }
    }
  }
  assert.ok(shownSomewhere >= evaluation.report.gallery.real.length && withheldSomewhere > 0);
  // Without the evaluation the page says nothing of the kind.
  assert.ok(!renderTrace(ask(`/api/recommendations?game=${evaluation.report.gallery.real[0]?.game_id}&brand=${home}&trace=1`)).includes("data-failure"));
});

test("UI-17: an answer that arrives after a newer request began is not the latest, so the page does not show it", async () => {
  const begin = turns();
  const place = {};
  const shown: string[] = [];
  // The page's own rule: write the answer only if no later work began for the same place.
  const show = async (answer: string, after: number): Promise<void> => {
    const latest = begin(place);
    await new Promise((resolve) => setTimeout(resolve, after));
    if (latest()) shown.push(answer);
  };
  // The first request is slow and the second is fast: the first answer arrives last.
  await Promise.all([show("first request", 30), show("second request", 5)]);
  assert.deepEqual(shown, ["second request"]);
  // Work for another place does not make this one stale.
  const one = begin(place);
  const other = begin({});
  assert.ok(one() && other());
});

test("UI-18: a brand or a version an address names is sent as written, so the service says what is wrong with it; a brand with no game is kept", async () => {
  const { get, asked } = getter();
  const catalogue = (await get("/api/catalogue")) as { brands: { brand: string }[]; versions: string[]; served: { version: string } };
  const loud = home.toUpperCase();
  assert.notEqual(loud, home);
  // A brand in the wrong case: the picker keeps it, the request carries it, and the service names it.
  const wrongBrand = addressRequest(`?game=${games[0]}&brand=${loud}`, catalogue);
  assert.deepEqual([wrongBrand.game, wrongBrand.brand, wrongBrand.version], [games[0], loud, catalogue.served.version]);
  assert.deepEqual(brandOptions(catalogue, loud)[0], { value: loud, text: `${loud} · not a brand of this catalogue` });
  assert.equal(brandOptions(catalogue, home).length, catalogue.brands.length);
  await assert.rejects(traceView(get, { game: wrongBrand.game as string, brand: wrongBrand.brand as string, version: wrongBrand.version as string, served: catalogue.served.version }), (error: Error) => error.message.includes("unknown brand") && error.message.includes(loud) && !error.message.includes("is required"));
  assert.ok(asked.at(-1)?.includes(`brand=${loud}`));
  // A version in the wrong case, the same way.
  const wrongVersion = addressRequest(`?game=${games[0]}&brand=${home}&version=RAW`, catalogue);
  assert.equal(wrongVersion.version, "RAW");
  assert.deepEqual(versionOptions(catalogue, "RAW")[0], { value: "RAW", text: "RAW · not a version of this index" });
  assert.equal(versionOptions(catalogue, "raw").length, catalogue.versions.length);
  await assert.rejects(traceView(get, { game: games[0] as string, brand: home, version: "RAW", served: catalogue.served.version }), (error: Error) => error.message.includes("unknown version") && !error.message.includes("is required"));
  // A brand and no game: the brand is kept, and the game is the first the picker offers for it.
  const other = catalogue.brands.at(-1)?.brand as string;
  const brandOnly = addressRequest(`?brand=${other}`, catalogue);
  assert.equal(brandOnly.brand, other);
  assert.equal(brandOnly.game, gameOptions(catalogue, other, null)[0]?.value);
  // A game and no brand keeps the game. An address that names no request names none.
  assert.equal(addressRequest(`?game=${games[3]}`, catalogue).game, games[3]);
  assert.deepEqual([addressRequest("", catalogue).game, addressRequest("?section=worth", catalogue).game], [null, null]);
});
