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
import { compareView, esc, renderEvaluation, renderTrace, traceView, versionName, whatIfView } from "./view.js";

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

test("UI-7: a quote is marked where it sits in the record's own text, and a bar is as long as the number the response carries", () => {
  const brand = brands[0] as string;
  const marksIn = (html: string): string[] => [...html.matchAll(/<mark>(.*?)<\/mark>/g)].map((match) => match[1] as string);
  let quotesSeen = 0;
  for (const game of games) {
    const response = JSON.parse(route(service, "GET", `/api/inspect?game=${game}&brand=${brand}&version=model_everywhere`).body) as Recommendation;
    const anchor = response.trace?.anchor;
    assert.ok(anchor, `${game}: no record in the trace`);
    const html = renderTrace(response);
    const contexts = [...html.matchAll(/<p class="copy">(.*?)<\/p>/g)].map((match) => match[1] as string);
    const model = [...anchor.steps.model.themes, ...anchor.steps.model.mechanics];
    for (const field of ["title", "description"] as const) {
      const quotes = model.filter((entry) => entry.source_field === field).map((entry) => entry.quote);
      if (quotes.length === 0) continue;
      const text = anchor.steps.cleaned[field];
      assert.ok(typeof text === "string", `${game}: a quote names a ${field} the record does not have`);
      // The words in place are the record's own text, with nothing added but the marks.
      const context = contexts.find((candidate) => candidate.replaceAll(/<\/?mark>/g, "") === esc(text));
      assert.ok(context !== undefined, `${game}: the cleaned ${field} is not shown with its quotes in place`);
      for (const quote of quotes) assert.ok(marksIn(context).some((marked) => marked.includes(esc(quote))), `${game}: "${quote}" is not marked in the ${field}`);
      quotesSeen += quotes.length;
    }
    assert.ok(!html.includes("not found in this text"), `${game}: a stored quote could not be placed`);
  }
  assert.ok(quotesSeen > 0, "no model quote was checked");

  // A quote that is not in the text is said, not dropped; and a bar follows the number in the response.
  const busy = games.map((id) => JSON.parse(route(service, "GET", `/api/inspect?game=${id}&brand=${brand}&version=model_everywhere`).body) as Recommendation).find((response) => response.results.length > 0 && (response.trace?.anchor?.steps.model.mechanics.length ?? 0) > 0);
  assert.ok(busy?.trace?.anchor && busy.trace.scores[0] !== undefined && busy.trace.anchor.steps.model.mechanics[0] !== undefined);
  busy.trace.anchor.steps.model.mechanics[0].source_field = "description";
  busy.trace.anchor.steps.model.mechanics[0].quote = "words that are nowhere in this record";
  busy.trace.scores[0].score = 0.4321;
  busy.trace.floor = 0.1234;
  const changed = renderTrace(busy);
  assert.ok(text(changed).includes("1 not found in this text"));
  assert.ok(changed.includes('style="width:43.21%"'), "the bar is not as long as the score");
  assert.ok(changed.includes('style="left:12.34%"'), "the tick is not at the floor");
});
