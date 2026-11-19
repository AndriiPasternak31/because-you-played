/**
 * Proofs of the service's invariants (docs/features/service.md). Each test name starts with
 * the invariant it proves. Where the domain is small the whole of it is checked: every game,
 * on every brand, in every version of the index.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Index, IndexRecord } from "../pipeline/index-store.ts";
import { VERSIONS, type Version } from "../pipeline/versions.ts";
import { createService, route } from "./http.ts";
import { parseOfferings, type Offerings } from "./offerings.ts";
import { DECLINE_REASONS, buildState, recommend, similarityFloor, type Recommendation } from "./recommend.ts";
import { DEFAULT_PATHS, NotServing, loadService, type ServicePaths } from "./state.ts";

const service = loadService();
const { index, offerings } = service;

/** Availability as the test reads it from the file itself, not through the service's reader. */
const liveInFile = new Set(
  readFileSync(DEFAULT_PATHS.offeringsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { game_id: string; brand: string; status: string })
    .filter((row) => row.status === "live")
    .map((row) => `${row.brand}|${row.game_id}`),
);

/** Test subjects are found by asking the service, not written down, so that a rebuilt index does not strand them. */
const resultsOn = (gameId: string, brand: string): number => recommend(service.served, { gameId, brand }).results.length;
const BUSY = (() => {
  for (const record of index.records) {
    const brands = offerings.brands.filter((brand) => resultsOn(record.game_id, brand) >= 3);
    const [first, second] = brands;
    if (first !== undefined && second !== undefined) return { anchor: record.game_id, brandA: first, brandB: second };
  }
  throw new Error("no game has three results on two brands, so the tests have no subject");
})();
const ANCHOR = BUSY.anchor;
const BRAND_A = BUSY.brandA;
const BRAND_B = BUSY.brandB;
/** A thin record with a description and no delivered tag the table maps: everything it holds, the model added. */
const THIN = (() => {
  const found = index.records.find(
    (record) =>
      record.thin &&
      record.canonical.description !== null &&
      record.table.themes.length + record.table.mechanics.length === 0 &&
      record.model.themes.length + record.model.mechanics.length >= 3 &&
      recommend(service.byVersion.model_where_thin, { gameId: record.game_id, brand: BRAND_A }).outcome === "results",
  );
  if (found === undefined) throw new Error("no thin record with a description and no mapped tag is live, so the trace test has no subject");
  return found.game_id;
})();

function everyRequest(visit: (response: Recommendation, version: Version, brand: string, record: IndexRecord) => void): number {
  let count = 0;
  for (const version of VERSIONS) {
    for (const brand of offerings.brands) {
      for (const record of index.records) {
        visit(recommend(service.byVersion[version], { gameId: record.game_id, brand, limit: 10, trace: true }), version, brand, record);
        count += 1;
      }
    }
  }
  return count;
}

/** A copy of the index in memory with some records changed, and vectors chosen by the test. */
function alteredIndex(change: (records: IndexRecord[]) => void, vectors?: Float32Array): Index {
  const records = structuredClone(index.records) as IndexRecord[];
  change(records);
  const all = vectors ?? index.vectors.model_where_thin;
  return { ...index, records, vectors: { raw: all, table: all, model_where_thin: all, model_everywhere: all } };
}

const everyoneLive = (brand: string): Offerings =>
  parseOfferings(index.records.map((record) => JSON.stringify({ game_id: record.game_id, brand, jurisdiction: "GB", status: "live" })).join("\n"), "test offerings");

test("SV-1: for every game on every brand in every version, no result and no scored candidate is a game that is not live there", () => {
  let results = 0;
  let scored = 0;
  const requests = everyRequest((response, version, brand) => {
    for (const result of response.results) {
      results += 1;
      assert.ok(liveInFile.has(`${brand}|${result.game_id}`), `${version}: ${result.game_id} was returned on ${brand}, where it is not live`);
    }
    for (const candidate of response.trace?.scores ?? []) {
      scored += 1;
      assert.ok(liveInFile.has(`${brand}|${candidate.game_id}`), `${version}: ${candidate.game_id} was scored for ${brand}, where it is not live`);
    }
  });
  assert.equal(requests, VERSIONS.length * offerings.brands.length * index.records.length);
  // The check is not vacuous: results were returned, and some games are not live on each brand.
  assert.ok(results > 1000 && scored > results);
  for (const brand of offerings.brands) assert.ok(index.records.some((record) => !liveInFile.has(`${brand}|${record.game_id}`)));
});

test("SV-1: a game that would rank first is removed before it is scored when it is not live", () => {
  const anchor = ANCHOR;
  const open = recommend(buildState(index, everyoneLive("anybrand"), "model_where_thin"), { gameId: anchor, brand: "anybrand", trace: true });
  const best = open.results[0];
  assert.ok(best !== undefined);
  const withdrawn = parseOfferings(
    index.records.map((record) => JSON.stringify({ game_id: record.game_id, brand: "anybrand", jurisdiction: "GB", status: record.game_id === best.game_id ? "withdrawn" : "live" })).join("\n"),
    "test offerings",
  );
  const closed = recommend(buildState(index, withdrawn, "model_where_thin"), { gameId: anchor, brand: "anybrand", trace: true });
  assert.ok(!closed.results.some((result) => result.game_id === best.game_id));
  assert.ok(!closed.trace?.scores.some((candidate) => candidate.game_id === best.game_id), "a withdrawn game has a score");
  assert.deepEqual(closed.trace?.filters[0]?.removed.map((removal) => [removal.game_id, removal.why]), [[best.game_id, "withdrawn"]]);
  assert.equal(closed.trace?.filters[0]?.filter, "not_live_on_brand");
  // Every status but "live" is removed, and so is a game with no row for the brand.
  const absent = (index.records.find((record) => record.game_id !== anchor && record.game_id !== best.game_id) as IndexRecord).game_id;
  for (const status of ["coming_soon", "disabled", "withdrawn"]) {
    const one = parseOfferings(
      index.records
        .filter((record) => record.game_id !== absent)
        .map((record) => JSON.stringify({ game_id: record.game_id, brand: "b", jurisdiction: "GB", status: record.game_id === best.game_id ? status : "live" }))
        .join("\n"),
      "test offerings",
    );
    const response = recommend(buildState(index, one, "model_where_thin"), { gameId: anchor, brand: "b", limit: 10, trace: true });
    const why = new Map(response.trace?.filters[0]?.removed.map((removal) => [removal.game_id, removal.why]));
    assert.equal(why.get(best.game_id), status);
    assert.equal(why.get(absent), "not_offered");
  }
});

test("SV-2: answering every game on every brand opens no connection, resolves no name and calls no fetch, with no key set", async () => {
  const outbound: string[] = [];
  const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, lookup: dns.lookup, key: process.env["OPENAI_API_KEY"] };
  delete process.env["OPENAI_API_KEY"];
  globalThis.fetch = (() => {
    outbound.push("fetch");
    throw new Error("tripwire: fetch was called");
  }) as typeof fetch;
  net.Socket.prototype.connect = function tripwire(): never {
    outbound.push("connect");
    throw new Error("tripwire: a socket was opened");
  } as unknown as typeof net.Socket.prototype.connect;
  dns.lookup = ((): never => {
    outbound.push("lookup");
    throw new Error("tripwire: a name was resolved");
  }) as unknown as typeof dns.lookup;
  try {
    let answered = 0;
    for (const brand of offerings.brands) {
      for (const record of index.records) {
        const reply = route(service, "GET", `/api/recommendations?game=${record.game_id}&brand=${brand}&trace=1`);
        assert.equal(reply.status, 200);
        for (const version of VERSIONS) assert.equal(route(service, "GET", `/api/inspect?game=${record.game_id}&brand=${brand}&version=${version}`).status, 200);
        answered += 1;
      }
    }
    for (const path of ["/api/catalogue", "/api/evaluation", "/api/what-if?min_precision=0.99", "/"]) assert.equal(route(service, "GET", path).status, 200);
    assert.equal(answered, offerings.brands.length * index.records.length);
    assert.deepEqual(outbound, []);
    // The tripwires do fire when something reaches out.
    await assert.rejects(async () => fetch("https://example.invalid/"), /tripwire/);
    assert.throws(() => net.connect(443, "example.invalid"), /tripwire/);
    assert.deepEqual(outbound, ["fetch", "connect"]);
  } finally {
    globalThis.fetch = original.fetch;
    net.Socket.prototype.connect = original.connect;
    dns.lookup = original.lookup;
    if (original.key !== undefined) process.env["OPENAI_API_KEY"] = original.key;
  }
});

test("SV-2: the service starts and answers from a tree that holds no hidden truth and no model response", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv2-"));
  cpSync("data/index", join(dir, "index"), { recursive: true });
  cpSync("data/catalogue.raw.jsonl", join(dir, "catalogue.raw.jsonl"));
  cpSync("data/offerings.jsonl", join(dir, "offerings.jsonl"));
  cpSync("eval/results", join(dir, "results"), { recursive: true });
  cpSync("eval/thresholds.json", join(dir, "thresholds.json"));
  const apart = loadService({
    indexDir: join(dir, "index"),
    cataloguePath: join(dir, "catalogue.raw.jsonl"),
    offeringsPath: join(dir, "offerings.jsonl"),
    verdictPath: join(dir, "results", "verdict.json"),
    thresholdsPath: join(dir, "thresholds.json"),
  });
  const here = recommend(service.served, { gameId: ANCHOR, brand: BRAND_A });
  assert.deepEqual(recommend(apart.served, { gameId: ANCHOR, brand: BRAND_A }).results, here.results);
  assert.ok(here.results.length > 0);
});

test("SV-3: on the real index no result is the anchor or a second record of it, and at most one is of the anchor's family", () => {
  everyRequest((response, version, _brand, record) => {
    assert.ok(!response.results.some((result) => result.game_id === record.game_id), `${version}: ${record.game_id} was recommended from itself`);
    const sameGame = response.results.filter((result) => result.provider === record.canonical.provider && result.title.toLowerCase() === record.canonical.title.toLowerCase());
    assert.deepEqual(sameGame, []);
    if (record.canonical.family_id !== null) {
      assert.ok(response.results.filter((result) => result.family_id === record.canonical.family_id).length <= 1);
    }
  });
});

test("SV-3: when three games of the anchor's family clear the floor, only the best one is returned", () => {
  const anchor = ANCHOR;
  const brand = "anybrand";
  const plain = recommend(buildState(index, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand, limit: 5 });
  const [first, second, third] = plain.results;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  const family = [anchor, first.game_id, second.game_id, third.game_id];
  const altered = alteredIndex((records) => {
    for (const record of records) if (family.includes(record.game_id)) record.canonical.family_id = "fam-test";
  });
  const capped = recommend(buildState(altered, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand, limit: 5, trace: true });
  assert.deepEqual(capped.results.filter((result) => result.family_id === "fam-test").map((result) => result.game_id), [first.game_id]);
  const cap = capped.trace?.filters.find((step) => step.filter === "family_cap");
  assert.deepEqual(cap?.removed.map((removal) => removal.game_id), [second.game_id, third.game_id]);
  // The freed places go to the next games in rank order, not to nothing.
  assert.equal(capped.results.length, 5);
  // A family other than the anchor's is not capped.
  const others = alteredIndex((records) => {
    for (const record of records) if ([first.game_id, second.game_id].includes(record.game_id)) record.canonical.family_id = "fam-other";
  });
  const uncapped = recommend(buildState(others, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand, limit: 5 });
  assert.deepEqual(uncapped.results.map((result) => result.game_id), plain.results.map((result) => result.game_id));
});

test("SV-3: a second record of the anchor, same studio and same title under another id, is never returned", () => {
  const anchor = ANCHOR;
  const brand = "anybrand";
  const plain = recommend(buildState(index, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand });
  const twin = plain.results[0];
  assert.ok(twin !== undefined);
  const anchorRecord = index.records.find((record) => record.game_id === anchor) as IndexRecord;
  const altered = alteredIndex((records) => {
    const record = records.find((candidate) => candidate.game_id === twin.game_id) as IndexRecord;
    record.canonical.title = anchorRecord.canonical.title.toUpperCase();
    record.canonical.provider = anchorRecord.canonical.provider;
  });
  const response = recommend(buildState(altered, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand, limit: 10, trace: true });
  assert.ok(!response.results.some((result) => result.game_id === twin.game_id));
  assert.ok(!response.trace?.scores.some((candidate) => candidate.game_id === twin.game_id));
  const removed = response.trace?.filters.find((step) => step.filter === "anchor_or_duplicate")?.removed.map((removal) => removal.game_id);
  assert.deepEqual(removed?.sort(), [anchor, twin.game_id].sort());
  // The same title from another studio is a different game and stays.
  const otherStudio = alteredIndex((records) => {
    const record = records.find((candidate) => candidate.game_id === twin.game_id) as IndexRecord;
    record.canonical.title = anchorRecord.canonical.title;
    record.canonical.provider = "Another Studio";
  });
  assert.ok(recommend(buildState(otherStudio, everyoneLive(brand), "model_where_thin"), { gameId: anchor, brand }).results.some((result) => result.game_id === twin.game_id));
});

/** The first game and brand the served version declines for each reason, found by asking, not written down. */
function firstDecline(reason: (typeof DECLINE_REASONS)[number]): { gameId: string; brand: string } {
  for (const brand of offerings.brands) {
    for (const record of index.records) {
      if (recommend(service.served, { gameId: record.game_id, brand }).decline?.reason === reason) return { gameId: record.game_id, brand };
    }
  }
  throw new Error(`no request on this index is declined as ${reason}, so that reason cannot be shown`);
}

test("SV-4: each reason for declining is returned with its code and no results", () => {
  const ask = (gameId: string, brand: string): Recommendation => recommend(service.served, { gameId, brand, trace: true });
  const cases = {
    unknown_game: { gameId: "no-such-game", brand: offerings.brands[0] as string },
    anchor_not_available: firstDecline("anchor_not_available"),
    insufficient_data: firstDecline("insufficient_data"),
    nothing_above_floor: firstDecline("nothing_above_floor"),
  } satisfies Record<(typeof DECLINE_REASONS)[number], { gameId: string; brand: string }>;
  for (const reason of DECLINE_REASONS) {
    const { gameId, brand } = cases[reason];
    const response = ask(gameId, brand);
    assert.equal(response.outcome, "declined", `${gameId} on ${brand}`);
    assert.equal(response.decline?.reason, reason);
    assert.ok((response.decline?.detail.length ?? 0) > 20);
    assert.deepEqual(response.results, []);
  }
  // Not available: the game exists and its status on the brand is not "live".
  assert.ok(!liveInFile.has(`${cases.anchor_not_available.brand}|${cases.anchor_not_available.gameId}`));
  // Too little data is about the record: it is live there, and has no description and no tag the table maps.
  assert.ok(liveInFile.has(`${cases.insufficient_data.brand}|${cases.insufficient_data.gameId}`));
  assert.equal(index.records.find((record) => record.game_id === cases.insufficient_data.gameId)?.evidence, "none");
  // Nothing above the floor: candidates were scored, and every one of them is below it.
  const low = ask(cases.nothing_above_floor.gameId, cases.nothing_above_floor.brand);
  assert.ok((low.trace?.scores.length ?? 0) > 0);
  assert.ok(low.trace?.scores.every((candidate) => candidate.score < service.served.floor));
});

test("SV-4: over every request, a result clears the floor, results are in score order, and a decline carries a reason and nothing else", () => {
  const seen = new Set<string>();
  everyRequest((response, version) => {
    const { floor } = service.byVersion[version];
    if (response.outcome === "declined") {
      assert.ok(response.decline !== null && (DECLINE_REASONS as readonly string[]).includes(response.decline.reason));
      assert.deepEqual(response.results, []);
      seen.add(response.decline.reason);
      return;
    }
    assert.equal(response.decline, null);
    assert.ok(response.results.length >= 1 && response.results.length <= 10);
    response.results.forEach((result, position) => {
      assert.ok(result.score >= floor, `${version}: ${result.game_id} scored ${result.score}, below the floor ${floor}`);
      if (position > 0) assert.ok((response.results[position - 1]?.score ?? 0) >= result.score);
    });
    // Nothing that cleared the floor was dropped except by the family cap or the limit.
    const cleared = response.trace?.scores.filter((candidate) => candidate.score >= floor).length ?? 0;
    const dropped = response.trace?.filters.filter((step) => step.filter === "family_cap" || step.filter === "over_limit").reduce((sum, step) => sum + step.removed.length, 0) ?? 0;
    assert.equal(response.results.length, cleared - dropped);
  });
  assert.deepEqual([...seen].sort(), ["anchor_not_available", "insufficient_data", "nothing_above_floor"]);
});

test("SV-4: the floor is the stated share of all pairs, and a record with too little data is never a candidate", () => {
  for (const version of VERSIONS) {
    const state = service.byVersion[version];
    const scores: number[] = [];
    for (let a = 0; a < index.records.length; a += 1) {
      for (let b = a + 1; b < index.records.length; b += 1) {
        let sum = 0;
        for (let column = 0; column < state.dimensions; column += 1) sum += (state.vectors[a * state.dimensions + column] as number) * (state.vectors[b * state.dimensions + column] as number);
        scores.push(Math.round(sum * 1e6) / 1e6);
      }
    }
    const below = scores.filter((score) => score < state.floor).length;
    assert.ok(Math.abs(below / scores.length - 0.9) < 0.001, `${version}: ${below} of ${scores.length} pairs are below the floor`);
    assert.equal(similarityFloor(state.vectors, state.dimensions, index.records.length), state.floor);
  }
  const thin = new Set(index.records.filter((record) => record.evidence === "none").map((record) => record.game_id));
  assert.ok(thin.size > 0);
  everyRequest((response) => {
    assert.ok(!response.trace?.scores.some((candidate) => thin.has(candidate.game_id)));
  });
});

/** A scratch copy of everything the service loads, so that a test can break one part of it. */
function scratch(): ServicePaths & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sv5-"));
  cpSync("data/index", join(dir, "index"), { recursive: true });
  cpSync("data/catalogue.raw.jsonl", join(dir, "catalogue.raw.jsonl"));
  cpSync("data/offerings.jsonl", join(dir, "offerings.jsonl"));
  cpSync("eval/results", join(dir, "results"), { recursive: true });
  cpSync("eval/thresholds.json", join(dir, "thresholds.json"));
  return {
    dir,
    indexDir: join(dir, "index"),
    cataloguePath: join(dir, "catalogue.raw.jsonl"),
    offeringsPath: join(dir, "offerings.jsonl"),
    verdictPath: join(dir, "results", "verdict.json"),
    thresholdsPath: join(dir, "thresholds.json"),
  };
}

function editVerdict(paths: ServicePaths, change: (verdict: Record<string, unknown>) => void): void {
  const verdict = JSON.parse(readFileSync(paths.verdictPath, "utf8")) as Record<string, unknown>;
  change(verdict);
  writeFileSync(paths.verdictPath, JSON.stringify(verdict));
}

test("SV-5: the service serves the version the verdict chose, and refuses a missing, failed, foreign or stale verdict", () => {
  assert.equal(service.served.version, service.verdict.ships);
  assert.equal(loadService(scratch()).served.version, service.verdict.ships);

  const refused = (paths: ServicePaths, pattern: RegExp): void => {
    assert.throws(() => loadService(paths), (error: unknown) => error instanceof NotServing && pattern.test(error.message), `expected a refusal matching ${pattern}`);
  };
  const missing = scratch();
  writeFileSync(missing.verdictPath, "");
  refused({ ...missing, verdictPath: join(missing.dir, "results", "no-verdict.json") }, /no evaluation verdict/);
  refused(missing, /not valid JSON/);

  const failed = scratch();
  editVerdict(failed, (verdict) => Object.assign(verdict, { passed: false, ships: null, reason: "No version passes its marks." }));
  refused(failed, /does not pass: No version passes/);

  // "passed" decides, whatever version the file goes on to name.
  const failedButNamed = scratch();
  editVerdict(failedButNamed, (verdict) => Object.assign(verdict, { passed: false, reason: "A mark failed." }));
  refused(failedButNamed, /does not pass: A mark failed/);

  const contradicts = scratch();
  editVerdict(contradicts, (verdict) => Object.assign(verdict, { ships: "table" }));
  refused(contradicts, /ships table, which it also records as not passing/);

  const foreign = scratch();
  editVerdict(foreign, (verdict) => Object.assign(verdict, { index_hash: "0".repeat(64) }));
  refused(foreign, /is for index 0000/);

  const otherMarks = scratch();
  writeFileSync(otherMarks.thresholdsPath, readFileSync(otherMarks.thresholdsPath, "utf8").replace("0.85", "0.5"));
  refused(otherMarks, /other pass marks/);

  const otherFloor = scratch();
  editVerdict(otherFloor, (verdict) => {
    (verdict["serving"] as { floors: Record<string, number> }).floors["model_where_thin"] = 0.1;
  });
  refused(otherFloor, /judged the serving rule/);

  const otherReport = scratch();
  writeFileSync(join(otherReport.dir, "results", service.verdict.report.path), "{}");
  refused(otherReport, /does not match its report/);

  const malformed = scratch();
  editVerdict(malformed, (verdict) => Object.assign(verdict, { passed: "yes" }));
  refused(malformed, /is not a verdict/);
});

test("SV-5: the service refuses to start on an invalid index, and the command exits non-zero with the reason", () => {
  const broken = scratch();
  const vectors = join(broken.indexDir, "vectors.model_where_thin.f32");
  const bytes = readFileSync(vectors);
  bytes[100] = (bytes[100] ?? 0) ^ 0xff;
  writeFileSync(vectors, bytes);
  assert.throws(() => loadService(broken), (error: unknown) => error instanceof NotServing && /invalid index.*hash mismatch/.test(error.message));

  const otherCatalogue = scratch();
  writeFileSync(otherCatalogue.cataloguePath, `${readFileSync(otherCatalogue.cataloguePath, "utf8")}\n`);
  assert.throws(() => loadService(otherCatalogue), (error: unknown) => error instanceof NotServing && /Rebuild the index/.test(error.message));

  const run = (paths: ServicePaths) =>
    spawnSync(process.execPath, ["src/service/serve.ts", "--port", "0", "--index", paths.indexDir, "--catalogue", paths.cataloguePath, "--offerings", paths.offeringsPath, "--verdict", paths.verdictPath, "--thresholds", paths.thresholdsPath], {
      encoding: "utf8",
      timeout: 20_000,
    });
  const invalid = run(broken);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not serving: invalid index/);
  const noVerdict = scratch();
  const unjudged = run({ ...noVerdict, verdictPath: join(noVerdict.dir, "nothing.json") });
  assert.equal(unjudged.status, 1);
  assert.match(unjudged.stderr, /not serving: there is no evaluation verdict/);
  assert.equal(unjudged.stdout, "");
});

test("SV-6: a game withdrawn in the offerings file is gone after a restart, and other results are still served", () => {
  const brand = BRAND_B;
  const anchor = ANCHOR;
  const before = recommend(service.served, { gameId: anchor, brand });
  const gone = before.results[0];
  assert.ok(gone !== undefined && before.results.length >= 3);
  const paths = scratch();
  const lines = readFileSync(paths.offeringsPath, "utf8").split("\n");
  const edited = lines.map((line) => {
    if (line.length === 0) return line;
    const row = JSON.parse(line) as { game_id: string; brand: string; status: string };
    return row.game_id === gone.game_id && row.brand === brand ? JSON.stringify({ ...row, status: "withdrawn" }) : line;
  });
  assert.notDeepEqual(edited, lines);
  writeFileSync(paths.offeringsPath, edited.join("\n"));
  const restarted = loadService(paths);
  for (const record of index.records) {
    const response = recommend(restarted.served, { gameId: record.game_id, brand, limit: 10 });
    assert.ok(!response.results.some((result) => result.game_id === gone.game_id), `${gone.game_id} is still recommended from ${record.game_id}`);
  }
  const after = recommend(restarted.served, { gameId: anchor, brand });
  assert.equal(after.outcome, "results");
  assert.deepEqual(after.results.slice(0, 2).map((result) => result.game_id), before.results.slice(1, 3).map((result) => result.game_id));
  // On the other brand nothing changed.
  assert.deepEqual(recommend(restarted.served, { gameId: anchor, brand: BRAND_A }), recommend(service.served, { gameId: anchor, brand: BRAND_A }));
  // And the withdrawn game itself is now declined as an anchor.
  assert.equal(recommend(restarted.served, { gameId: gone.game_id, brand }).decline?.reason, "anchor_not_available");
});

test("SV-6: an offerings file that is empty, malformed or ambiguous stops the start and names the line", () => {
  assert.throws(() => parseOfferings("", "offerings"), /holds no offering/);
  assert.throws(() => parseOfferings('{"game_id":"a","brand":"b","jurisdiction":"GB","status":"live"}\nnot json', "offerings"), /offerings line 2 is not valid JSON/);
  assert.throws(() => parseOfferings('{"game_id":"a","brand":"b","jurisdiction":"GB","status":"available"}', "offerings"), /offerings line 1 is not an offering/);
  const twice = '{"game_id":"a","brand":"b","jurisdiction":"GB","status":"live"}\n{"game_id":"a","brand":"b","jurisdiction":"GB","status":"withdrawn"}';
  assert.throws(() => parseOfferings(twice, "offerings"), /line 2 repeats a on b/);
});

test("SV-7: a trace carries the record, what each step added with its quote, every filter in order, the scores, the floor, the outcome and the timings", () => {
  const response = recommend(service.byVersion.model_where_thin, { gameId: THIN, brand: BRAND_A, trace: true });
  const trace = response.trace;
  assert.ok(trace !== undefined && trace.anchor !== null);
  const record = index.records.find((candidate) => candidate.game_id === THIN) as IndexRecord;
  // The record as delivered, and what the table and the model each added.
  assert.equal(trace.anchor.delivered.title, record.canonical.title_as_delivered);
  assert.equal(trace.anchor.delivered.description, record.canonical.description_as_delivered);
  assert.equal(trace.anchor.thin, true);
  assert.deepEqual(trace.anchor.steps.table.themes, []);
  assert.equal(trace.anchor.steps.model.used, true);
  const labels = [...(trace.anchor.fields?.themes.labels ?? []), ...(trace.anchor.fields?.mechanics.labels ?? [])];
  assert.ok(labels.length >= 3);
  for (const label of labels) {
    assert.equal(label.method, "model");
    const field = label.source_field === "title" ? record.canonical.title : (record.canonical.description ?? "");
    assert.ok(field.includes(label.quote), `the quote ${label.quote} is not in the record's ${label.source_field}`);
  }
  assert.deepEqual(trace.filters.map((step) => step.filter), ["not_live_on_brand", "anchor_or_duplicate", "insufficient_data", "below_floor", "family_cap", "over_limit"]);
  // The counts add up from one filter to the next.
  assert.equal(trace.filters[0]?.remaining, index.records.length - (trace.filters[0]?.removed.length ?? 0));
  assert.equal(trace.scores.length, trace.filters[2]?.remaining);
  assert.equal(trace.floor, service.byVersion.model_where_thin.floor);
  assert.equal(response.results.length, trace.filters.at(-1)?.remaining);
  for (const stage of ["lookup", "availability", "exclusions", "scoring", "floor_and_caps", "total"]) assert.equal(typeof trace.timings_ms[stage], "number", stage);
  // Without the flag there is no trace, and the answer is the same.
  const plain = recommend(service.byVersion.model_where_thin, { gameId: THIN, brand: BRAND_A });
  assert.equal(plain.trace, undefined);
  assert.deepEqual(plain.results, response.results);
  // In the table version the model's labels were not used for this record.
  const table = recommend(service.byVersion.table, { gameId: THIN, brand: BRAND_A, trace: true });
  assert.equal(table.trace?.anchor?.steps.model.used, false);
  assert.equal(table.trace?.anchor?.fields?.themes.status, "abstained");
});

test("SV-8: bad input is a 400 that says what was wrong, a decline is a 200, and nothing but GET is answered", () => {
  const status = (path: string, method = "GET") => route(service, method, path);
  const bad: [string, RegExp][] = [
    ["/api/recommendations", /"game" is required/],
    [`/api/recommendations?game=${ANCHOR}`, /"brand" is required/],
    [`/api/recommendations?game=&brand=${BRAND_A}`, /"game" is required/],
    [`/api/recommendations?game=${ANCHOR}&brand=nowhere`, /unknown brand "nowhere"/],
    [`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}&limit=0`, /limit must be/],
    [`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}&limit=11`, /limit must be/],
    [`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}&limit=2.5`, /limit must be/],
    [`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}&trace=yes`, /trace must be 0 or 1/],
    [`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}&version=raw`, /unknown parameter "version"/],
    [`/api/recommendations?game=${ANCHOR}&game=x&brand=${BRAND_A}`, /more than once/],
    [`/api/inspect?game=${ANCHOR}&brand=${BRAND_A}&version=best`, /unknown version/],
    ["/api/what-if?min_precision=high", /must be a number/],
    ["/api/what-if?min_speed=1", /unknown parameter/],
  ];
  for (const [path, message] of bad) {
    const reply = status(path);
    assert.equal(reply.status, 400, path);
    assert.match((JSON.parse(reply.body) as { message: string }).message, message);
  }
  const decline = status(`/api/recommendations?game=no-such-game&brand=${BRAND_A}`);
  assert.equal(decline.status, 200);
  assert.equal((JSON.parse(decline.body) as Recommendation).decline?.reason, "unknown_game");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(status(`/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}`, method).status, 405);
  assert.equal(status("/api/nothing").status, 404);
  assert.equal(status("/../package.json").status, 404);
});

test("SV-8: over a real socket the wrapper returns what the core returns", async () => {
  const server = createService(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}`);
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as Recommendation).results, recommend(service.served, { gameId: ANCHOR, brand: BRAND_A }).results);
    assert.equal((await fetch(`${base}/api/recommendations?brand=${BRAND_A}`)).status, 400);
    assert.equal((await fetch(`${base}/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}`, { method: "POST" })).status, 405);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("SV-5: what-if marks change nothing that is served and no file", () => {
  const paths = scratch();
  mkdirSync(paths.dir, { recursive: true });
  const before = { thresholds: readFileSync("eval/thresholds.json", "utf8"), verdict: readFileSync("eval/results/verdict.json", "utf8") };
  const strict = JSON.parse(route(service, "GET", "/api/what-if?min_pairwise_accuracy=0.99").body) as { what_if: boolean; decision: { passed: boolean; ships: string | null } };
  assert.equal(strict.what_if, true);
  assert.equal(strict.decision.passed, false);
  assert.equal(strict.decision.ships, null);
  // The service still serves, from the committed verdict, and the files are as they were.
  assert.equal(route(service, "GET", `/api/recommendations?game=${ANCHOR}&brand=${BRAND_A}`).status, 200);
  assert.equal(service.served.version, service.verdict.ships);
  assert.equal(readFileSync("eval/thresholds.json", "utf8"), before.thresholds);
  assert.equal(readFileSync("eval/results/verdict.json", "utf8"), before.verdict);
  // With the committed marks, the what-if gate gives the committed verdict.
  const same = JSON.parse(route(service, "GET", "/api/what-if").body) as { decision: { ships: string | null } };
  assert.equal(same.decision.ships, service.verdict.ships);
});
