// Each test name starts with the invariant it proves (docs/features/pipeline.md), so that
// `npm test -- PL-4` runs the proof of one invariant.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RawRecord } from "../dataset/model.ts";
import { MECHANICS, THEMES } from "../dataset/vocabulary.ts";
import { assembleRecord, paths, runBuild } from "./build.ts";
import { FACT_KEYS, canonicaliseCatalogue, readRawCatalogue, type CanonicalRecord } from "./canonical.ts";
import { Budget, PRICES, SpendLimitReached, type Live, type Transport } from "./costs.ts";
import { DIMENSIONS, EMBEDDING_MODEL, embeddingPath, readEmbeddingFile } from "./embed.ts";
import {
  ENRICHMENT_MODEL,
  PROMPT_VERSION,
  buildRequest,
  enrichmentDir,
  interpretResponse,
  obtainEnrichment,
  readEnrichmentFile,
  type ModelOutput,
} from "./enrich.ts";
import { loadIndex, sealManifest, type Index, type IndexRecord, type Manifest } from "./index-store.ts";
import { readText, sha256 } from "./io.ts";
import { buildReport, storedSpend } from "./report.ts";
import { applyTable, labelsInTable, type Label } from "./synonyms.ts";
import { THIN_RULE, VERSIONS, type Version } from "./versions.ts";

const REPO = join(import.meta.dirname, "..", "..");
const DATA = join(REPO, "data");
const COMMITTED = paths(DATA);
const DESCRIBED: readonly Exclude<Version, "raw">[] = ["table", "model_where_thin", "model_everywhere"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A scratch data directory with what the build reads: the catalogue and the stored responses. No hidden truth. */
function scratchData(withResponses = true): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-"));
  cpSync(COMMITTED.catalogue, paths(dir).catalogue);
  if (withResponses) cpSync(COMMITTED.responses, paths(dir).responses, { recursive: true });
  return dir;
}

/** Runs the build as `npm run pipeline` does, with no key in its environment. */
function rebuild(dataDir: string): { status: number | null; stderr: string } {
  const env = { ...process.env };
  delete env["OPENAI_API_KEY"];
  return spawnSync(process.execPath, [join(REPO, "src", "pipeline", "build.ts"), "--data-dir", dataDir], { cwd: REPO, env, encoding: "utf8" });
}

function indexFiles(dir: string): Map<string, Buffer> {
  return new Map(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name))]));
}

/** One canonical record, made by the real canonicaliser from a raw row. */
function recordFrom(payload: Partial<RawRecord["payload"]> = {}): CanonicalRecord {
  const row: RawRecord = {
    source_system: "supplier-feed",
    source_record_id: "rec-test",
    fetched_at: "2026-11-02T03:00:00Z",
    payload: { game_code: "tst-1", name: "Cowboys of Testvale", provider: "Test Studio", category: "Slots", ...payload },
  };
  const [record] = canonicaliseCatalogue([row]);
  assert.ok(record);
  return record;
}

/** A completed model response carrying `answer` as its text. A string is sent as it is; anything else as JSON. */
function completed(answer: unknown): unknown {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] }],
    usage: { input_tokens: 1000, output_tokens: 100 },
  };
}

const REFUSAL = { status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }], usage: { input_tokens: 1000, output_tokens: 5 } };
const CUT_SHORT = {
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [{ type: "message", content: [{ type: "output_text", text: '{"themes":[{"label":"west' }] }],
  usage: { input_tokens: 1000, output_tokens: 2000 },
};

/** Stands in for the credential in tests. Made up, and shaped so that it cannot be mistaken for a real one. */
const STAND_IN = "stand-in-for-the-credential";

/** A transport that answers both endpoints without a network, and counts what it was asked. */
function fakeTransport(enrichmentBodies: (call: number) => { status: number; body: unknown }): { transport: Transport; calls: { enrichment: number; embedding: number } } {
  const calls = { enrichment: 0, embedding: 0 };
  const vector = Buffer.alloc(DIMENSIONS * 4);
  for (let column = 0; column < DIMENSIONS; column += 1) vector.writeFloatLE(column % 7 === 0 ? 0.25 : 0.01, column * 4);
  const transport: Transport = async (url, apiKey, body) => {
    assert.equal(apiKey, STAND_IN);
    if (url.endsWith("/embeddings")) {
      calls.embedding += 1;
      const { input } = body as { input: string[] };
      return {
        status: 200,
        body: {
          model: EMBEDDING_MODEL,
          data: input.map((_, index) => ({ index, embedding: vector.toString("base64") })),
          usage: { prompt_tokens: 10 * input.length, total_tokens: 10 * input.length },
        },
      };
    }
    calls.enrichment += 1;
    return enrichmentBodies(calls.enrichment);
  };
  return { transport, calls };
}

function liveWith(transport: Transport, maxUsd = 5, alreadySpent = 0): Live {
  return { apiKey: STAND_IN, budget: new Budget(maxUsd, alreadySpent), transport, retryDelayMs: 1 };
}

const quiet = (): void => {};
const NO_LABELS: ModelOutput = { outcome: "accepted", themes: [], mechanics: [], stripped: [] };

function modelLabel(label: Label["label"], quote: string, sourceField: Label["source_field"]): Label {
  return { label, quote, source_field: sourceField, method: "model", model: ENRICHMENT_MODEL, prompt_version: PROMPT_VERSION };
}

let built: Promise<Index> | undefined;

/**
 * The index as the code under test builds it now: a keyless rebuild in a scratch directory, loaded
 * through the validating loader. PL-9 shows the committed index is these same bytes.
 */
function currentIndex(): Promise<Index> {
  built ??= (async () => {
    const dataDir = scratchData();
    try {
      await runBuild({ dataDir, live: null, log: quiet });
      return loadIndex(paths(dataDir).index, { cataloguePath: paths(dataDir).catalogue });
    } finally {
      rmSync(dataDir, { recursive: true });
    }
  })();
  return built;
}

/** Every asserted label of a record in one version, both fields. */
function labelsOf(record: IndexRecord, version: Version): Label[] {
  return [...(record.versions[version].themes?.labels ?? []), ...(record.versions[version].mechanics?.labels ?? [])];
}

// ---------------------------------------------------------------------------
// PL-1: facts and availability are out of the model's reach
// ---------------------------------------------------------------------------

test("PL-1: an answer that tries to write a fact or an availability status is rejected whole", () => {
  const record = recordFrom({ description: "Cowboys ride into a frontier saloon." });
  const good = { themes: [{ label: "western", quote: "frontier saloon", source_field: "description" }], mechanics: [] };
  assert.equal(interpretResponse(completed(good), record).outcome, "ok", "the control answer must pass, or the rejections below prove nothing");

  const attempts: [string, unknown][] = [
    ["rtp", { ...good, rtp: "99%" }],
    ["volatility", { ...good, facts: { volatility: "low" } }],
    ["status", { ...good, themes: [{ ...good.themes[0], status: "live" }] }],
    ["availability", { ...good, availability: [{ brand: "copperjay", status: "live" }] }],
  ];
  for (const [key, answer] of attempts) {
    const result = interpretResponse(completed(answer), record);
    assert.equal(result.outcome, "invalid_output", `an answer with "${key}" must be rejected`);
    assert.match(result.outcome === "invalid_output" ? result.reason : "", /[Uu]nrecognized key|facts|status|availability|rtp/);
  }

  // The shape the model is asked for is closed in the same way.
  const { schema } = (buildRequest(record)["text"] as { format: { schema: { properties: object; additionalProperties: boolean } } }).format;
  assert.deepEqual(Object.keys(schema.properties), ["themes", "mechanics"]);
  assert.equal(schema.additionalProperties, false);
});

test("PL-1: every canonical record in the index is what code alone makes of the raw rows, whatever the model answered", async () => {
  const rows = readRawCatalogue(COMMITTED.catalogue);
  const canonical = canonicaliseCatalogue(rows);
  const { records } = await currentIndex();
  assert.equal(records.length, 100);
  assert.deepEqual(records.map((record) => record.canonical), canonical);

  // Facts are the delivered values, untouched, from the row that won.
  const rowById = new Map(rows.map((row) => [row.source_record_id, row]));
  for (const record of records) {
    const row = rowById.get(record.canonical.source.record_id);
    assert.ok(row);
    for (const key of FACT_KEYS) assert.deepEqual(record.canonical.facts[key], row.payload[key], `${record.game_id} ${key}`);
  }

  // And the same canonical record comes out beside two very different model answers.
  const loud: ModelOutput = { ...NO_LABELS, themes: [modelLabel("sci_fi", "x", "title")], mechanics: [modelLabel("ways", "x", "title")] };
  for (const record of canonical) {
    assert.deepEqual(assembleRecord(record, loud).canonical, assembleRecord(record, NO_LABELS).canonical);
  }
});

test("PL-1: of two rows for one game the later one wins, and rows fetched at the same time stop the build", () => {
  const older = { source_system: "s", source_record_id: "rec-a", fetched_at: "2026-11-02T03:00:00Z", payload: { game_code: "tst-1", name: "Old Name™", provider: "p", category: "c" } };
  const newer = { ...older, source_record_id: "rec-b", fetched_at: "2026-11-09T03:00:00Z", payload: { ...older.payload, name: "New Name™" } };
  const [record] = canonicaliseCatalogue([newer, older]);
  assert.equal(record?.title, "New Name");
  assert.deepEqual(record?.source, { system: "s", record_id: "rec-b", fetched_at: newer.fetched_at, superseded_record_ids: ["rec-a"] });
  assert.throws(() => canonicaliseCatalogue([older, { ...newer, fetched_at: older.fetched_at }]), /fetched at the same time \(rec-a, rec-b\)/);
});

// ---------------------------------------------------------------------------
// PL-2: every label is a vocabulary term with a verbatim quote and provenance
// ---------------------------------------------------------------------------

test("PL-2: a label outside the list, a quote that is not in the record and a repeated label are stripped and counted", () => {
  const record = recordFrom({
    description: "<p>Cowboys ride into a frontier saloon.</p><p>Wins pay on 25 fixed paylines.</p>",
    features: ["Free Spins", "Wild West Bonus"],
  });
  const answer = {
    themes: [
      { label: "western", quote: "frontier saloon. Wins pay", source_field: "description" }, // kept: crosses the paragraph break of the cleaned text
      { label: "pirates", quote: "frontier saloon", source_field: "description" }, // not a label
      { label: "paylines", quote: "25 fixed paylines", source_field: "description" }, // a mechanic in the themes field
      { label: "horror", quote: "a haunted saloon", source_field: "description" }, // invented
      { label: "adventure", quote: "frontier saloon", source_field: "title" }, // real words, wrong field
      { label: "western", quote: "Cowboys", source_field: "title" }, // repeated
    ],
    mechanics: [
      { label: "paylines", quote: "25 fixed paylines", source_field: "description" }, // kept
      { label: "free_spins", quote: "Free Spins", source_field: "features" }, // kept: a whole tag
      { label: "pick_bonus", quote: "Bonus", source_field: "features" }, // part of a tag is not a tag
      { label: "multipliers", quote: " ", source_field: "description" }, // nothing quoted
    ],
  };
  const result = interpretResponse(completed(answer), record);
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.deepEqual(result.themes.map((label) => label.label), ["western"]);
  assert.deepEqual(result.mechanics.map((label) => label.label), ["paylines", "free_spins"]);
  assert.deepEqual(result.themes[0], {
    label: "western",
    quote: "frontier saloon. Wins pay",
    source_field: "description",
    method: "model",
    model: ENRICHMENT_MODEL,
    prompt_version: PROMPT_VERSION,
  });
  assert.deepEqual(
    result.stripped.map((entry) => `${entry.field}:${entry.label}:${entry.reason}`),
    [
      "themes:pirates:label_outside_list",
      "themes:paylines:label_outside_list",
      "themes:horror:invented_quote",
      "themes:adventure:invented_quote",
      "themes:western:duplicate_label",
      "mechanics:pick_bonus:invented_quote",
      "mechanics:multipliers:invented_quote",
    ],
  );
  // Counted: the report adds them up by reason.
  const report = buildReport(1, [assembleRecord(record, { outcome: "accepted", themes: result.themes, mechanics: result.mechanics, stripped: result.stripped })], new Map());
  assert.deepEqual(report.enrichment.labels_stripped, { label_outside_list: 2, invented_quote: 4, duplicate_label: 1 });
  assert.equal(report.enrichment.labels_kept, 3);
});

test("PL-2: every label in the built index is a vocabulary term whose quote is word for word in its source field", async () => {
  const { records } = await currentIndex();
  let checked = 0;
  let fromModel = 0;
  for (const record of records) {
    for (const version of DESCRIBED) {
      for (const field of ["themes", "mechanics"] as const) {
        const vocabulary: readonly string[] = field === "themes" ? THEMES : MECHANICS;
        for (const label of record.versions[version][field]?.labels ?? []) {
          const where = `${record.game_id} ${version} ${label.label}`;
          assert.ok(vocabulary.includes(label.label), `${where}: not a ${field} label`);
          // Checked here without the pipeline's own quote check, so that a fault in it cannot hide.
          const { canonical } = record;
          const source =
            label.source_field === "title" ? [canonical.title]
            : label.source_field === "description" ? [canonical.description ?? ""]
            : canonical.source_tags[label.source_field];
          assert.ok(label.quote.trim().length >= 2 && source.some((text) => text.includes(label.quote)), `${where}: quote "${label.quote}" not found`);
          if (label.method === "model") {
            assert.deepEqual([label.model, label.prompt_version], [ENRICHMENT_MODEL, PROMPT_VERSION], where);
            fromModel += 1;
          } else {
            assert.deepEqual([label.model, label.prompt_version], [null, null], where);
            assert.ok(label.source_field === "features" || label.source_field === "themes", where);
          }
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 500 && fromModel > 100, `only ${checked} labels were checked, ${fromModel} from the model`);
});

// ---------------------------------------------------------------------------
// PL-3: bad output is rejected under its own name, and never repaired
// ---------------------------------------------------------------------------

test("PL-3: a refusal, a cut-short answer and malformed output are each rejected under their own name, and none is repaired", () => {
  const record = recordFrom({ description: "Cowboys ride into a frontier saloon." });
  const answer = { themes: [{ label: "western", quote: "frontier saloon", source_field: "description" }], mechanics: [] };
  assert.equal(interpretResponse(completed(answer), record).outcome, "ok");

  assert.equal(interpretResponse(REFUSAL, record).outcome, "refusal");
  const cutShort = interpretResponse(CUT_SHORT, record);
  assert.deepEqual(cutShort, { outcome: "incomplete", reason: 'status "incomplete": max_output_tokens' });

  // Each of these could be "fixed" by a lenient reader. None is.
  const malformed: [string, unknown][] = [
    ["a code fence around valid JSON", completed(`\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)],
    ["a trailing comma", completed('{"themes":[],"mechanics":[],}')],
    ["prose after the JSON", completed(`${JSON.stringify(answer)}\nHope this helps.`)],
    ["a missing field", completed({ themes: [] })],
    ["a label entry without a quote", completed({ themes: [{ label: "western", source_field: "title" }], mechanics: [] })],
    ["a source field that does not exist", completed({ themes: [{ label: "western", quote: "Cowboys", source_field: "tags" }], mechanics: [] })],
    ["a string where a list belongs", completed({ themes: "western", mechanics: [] })],
    ["no text part at all", { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 } }],
    ["not a response at all", { hello: "world" }],
  ];
  for (const [what, body] of malformed) assert.equal(interpretResponse(body, record).outcome, "invalid_output", what);
});

test("PL-3: rejected answers and API errors are stored and counted apart, and after two rejected answers the record gets no labels", async () => {
  const dataDir = scratchData(false);
  const { responses } = paths(dataDir);
  const record = recordFrom({ description: "Cowboys ride into a frontier saloon." });
  const path = join(enrichmentDir(responses), "tst-1.json");
  try {
    // A server error, then a refusal, then a cut-short answer.
    const script = [{ status: 503, body: { error: { type: "server_error", message: `echo ${STAND_IN}` } } }, { status: 200, body: REFUSAL }, { status: 200, body: CUT_SHORT }];
    const { transport, calls } = fakeTransport((call) => script[call - 1] ?? assert.fail("a fourth call was made"));
    const { output, file } = await obtainEnrichment(record, { responsesDir: responses, live: liveWith(transport), log: quiet });
    assert.equal(calls.enrichment, 3);
    assert.deepEqual(output, { outcome: "no_accepted_response", themes: [], mechanics: [], stripped: [] });
    assert.deepEqual(file.attempts.map((attempt) => attempt.outcome), ["api_error", "refusal", "incomplete"]);
    assert.equal(file.attempts[0]?.body, null, "the body of a failed call is never kept");
    assert.equal(file.attempts[0]?.reason, "http 503 type=server_error code=? param=?");
    assert.ok(!readFileSync(path, "utf8").includes(STAND_IN), "a key echoed in an error message must not reach the disk");

    // Counted under each outcome, and the record is listed as having no accepted answer.
    const report = buildReport(1, [assembleRecord(record, output)], new Map([[record.game_id, file]]));
    assert.deepEqual(report.enrichment.calls_by_outcome, { ok: 0, invalid_output: 0, refusal: 1, incomplete: 1, api_error: 1 });
    assert.deepEqual(report.enrichment.records_without_an_accepted_answer, ["tst-1"]);

    // A rebuild with no key reads the same verdict from the stored attempts and calls nothing.
    const replayed = await obtainEnrichment(record, { responsesDir: responses, live: null, log: quiet });
    assert.deepEqual(replayed.output, output);

    // An error that a retry cannot cure stops at once; errors that keep coming stop after three.
    rmSync(path);
    const denied = fakeTransport(() => ({ status: 401, body: { error: { type: "invalid_request_error", code: "invalid_api_key" } } }));
    await assert.rejects(obtainEnrichment(record, { responsesDir: responses, live: liveWith(denied.transport), log: quiet }), /kept failing/);
    assert.equal(denied.calls.enrichment, 1);
    rmSync(path);
    const down = fakeTransport(() => {
      throw new TypeError(`fetch failed for ${STAND_IN}`);
    });
    await assert.rejects(obtainEnrichment(record, { responsesDir: responses, live: liveWith(down.transport), log: quiet }), /kept failing/);
    assert.equal(down.calls.enrichment, 3);
    assert.deepEqual(readEnrichmentFile(path).attempts.map((attempt) => attempt.reason), Array(3).fill("transport failure: TypeError"));
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// PL-4: a corrupted index does not load
// ---------------------------------------------------------------------------

/** Rewrites the manifest of a copied index so that its hashes match the files again, leaving only the deeper fault. */
function reseal(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  for (const name of Object.keys(manifest.files)) {
    const content = readFileSync(join(dir, name));
    manifest.files[name] = { sha256: sha256(content), bytes: content.length };
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(sealManifest(manifest), null, 2)}\n`);
}

test("PL-4: loading fails, naming the fault, on each kind of corrupted copy of the index", () => {
  const corruptions: { name: string; expect: RegExp; corrupt: (dir: string) => void }[] = [
    {
      name: "one flipped byte in a vector file",
      expect: /hash mismatch: vectors\.raw\.f32/,
      corrupt: (dir) => {
        const bytes = readFileSync(join(dir, "vectors.raw.f32"));
        bytes[1000] = (bytes[1000] ?? 0) ^ 0xff;
        writeFileSync(join(dir, "vectors.raw.f32"), bytes);
      },
    },
    {
      name: "a non-finite value, with the hashes brought up to date",
      expect: /vectors\.table\.f32 has a non-finite value in vector 3, dimension 7/,
      corrupt: (dir) => {
        const bytes = readFileSync(join(dir, "vectors.table.f32"));
        bytes.writeFloatLE(Number.NaN, (3 * DIMENSIONS + 7) * 4);
        writeFileSync(join(dir, "vectors.table.f32"), bytes);
        reseal(dir);
      },
    },
    {
      name: "a vector file one value short, with the hashes brought up to date",
      expect: /wrong dimension: vectors\.model_everywhere\.f32 holds 614396 bytes/,
      corrupt: (dir) => {
        const bytes = readFileSync(join(dir, "vectors.model_everywhere.f32"));
        writeFileSync(join(dir, "vectors.model_everywhere.f32"), bytes.subarray(0, bytes.length - 4));
        reseal(dir);
      },
    },
    {
      name: "two records swapped, so rows no longer line up with the vectors",
      expect: /misaligned ids: .*row 0 is/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        [lines[0], lines[1]] = [lines[1] ?? "", lines[0] ?? ""];
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    {
      name: "a record dropped",
      expect: /misaligned ids: records\.jsonl has 99 games and the manifest 100/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        writeFileSync(join(dir, "records.jsonl"), lines.slice(0, 99).join("\n") + "\n");
        reseal(dir);
      },
    },
    {
      name: "the thin rule edited in the manifest",
      expect: /manifest\.json does not match its own index hash/,
      corrupt: (dir) => {
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
        manifest.thin_rule.rule = "Every record is thin.";
        writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
    {
      name: "a quote altered, with the hashes brought up to date",
      expect: /the quote for "\w+" in table is not in its (features|themes)/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        const position = lines.findIndex((line) => line.length > 0 && (JSON.parse(line) as IndexRecord).table.themes.length > 0);
        const record = JSON.parse(lines[position] ?? "") as IndexRecord;
        const label = record.versions.table.themes?.labels[0];
        assert.ok(label);
        label.quote = "words that were never delivered";
        lines[position] = JSON.stringify(record);
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    {
      name: "a text changed without its hash",
      expect: /the raw text does not match its hash/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        const record = JSON.parse(lines[0] ?? "") as IndexRecord;
        record.versions.raw.text += " and more";
        lines[0] = JSON.stringify(record);
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    { name: "a file missing", expect: /ledger\.json is missing/, corrupt: (dir) => rmSync(join(dir, "ledger.json")) },
  ];
  for (const { name, expect, corrupt } of corruptions) {
    const dir = mkdtempSync(join(tmpdir(), "index-"));
    try {
      cpSync(COMMITTED.index, dir, { recursive: true });
      assert.doesNotThrow(() => loadIndex(dir), `${name}: the copy must load before it is corrupted`);
      corrupt(dir);
      assert.throws(() => loadIndex(dir), expect, name);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test("PL-4: the index carries its version, model ids, prompt version, dimensions, catalogue hash and thin rule, and refuses another catalogue", async () => {
  const { manifest, records, vectors } = await currentIndex();
  assert.equal(manifest.format_version, 1);
  assert.match(manifest.index_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.models, { enrichment: ENRICHMENT_MODEL, embedding: EMBEDDING_MODEL });
  assert.equal(manifest.prompt_version, PROMPT_VERSION);
  assert.equal(manifest.dimensions, DIMENSIONS);
  assert.deepEqual(manifest.thin_rule, THIN_RULE);
  assert.equal(manifest.catalogue.sha256, sha256(readFileSync(COMMITTED.catalogue)));
  assert.deepEqual(manifest.game_ids, records.map((record) => record.game_id));
  for (const version of VERSIONS) assert.equal(vectors[version].length, records.length * DIMENSIONS);

  const dataDir = scratchData(false);
  try {
    writeFileSync(paths(dataDir).catalogue, readFileSync(COMMITTED.catalogue, "utf8").replace("Cowboys", "Cowhands"));
    assert.throws(() => loadIndex(COMMITTED.index, { cataloguePath: paths(dataDir).catalogue }), /was built from a catalogue with hash/);
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// PL-5: the synonym table
// ---------------------------------------------------------------------------

test("PL-5: a tag the table does not know is listed and counted and gives no label; non-attribute and merchandising tags are dropped", () => {
  const record = recordFrom({
    features: ["Megaways", "Free Spinz", "FREE-SPINS", "High Volatility", "Hold & Respin", "Freespins"],
    themes: ["Pirates", "Egyptian", "New Games", "Egypt themed"],
    tags: [{ name: "Hot" }, { name: "Free Spins" }],
  });
  const output = applyTable(record);
  assert.deepEqual(output.mechanics.map((label) => [label.label, label.quote, label.source_field, label.method]), [
    ["free_spins", "FREE-SPINS", "features", "synonym_table"],
    ["hold_and_respin", "Hold & Respin", "features", "synonym_table"],
  ]);
  assert.deepEqual(output.themes.map((label) => [label.label, label.quote]), [["ancient_egypt", "Egyptian"]]);
  // Close spellings are not guessed at.
  assert.deepEqual(output.unknown, [
    { tag: "Megaways", source_field: "features" },
    { tag: "Free Spinz", source_field: "features" },
    { tag: "Pirates", source_field: "themes" },
    { tag: "Egypt themed", source_field: "themes" },
  ]);
  assert.deepEqual(output.dropped, [
    { tag: "High Volatility", source_field: "features", reason: "non_attribute" },
    { tag: "New Games", source_field: "themes", reason: "non_attribute" },
    // The merchandising list is dropped whole, even an entry that would map elsewhere.
    { tag: "Hot", source_field: "tags", reason: "merchandising" },
    { tag: "Free Spins", source_field: "tags", reason: "merchandising" },
  ]);
  const report = buildReport(1, [assembleRecord(record, NO_LABELS)], new Map());
  assert.equal(report.table.unknown, 4);
  assert.deepEqual(report.table.unknown_tags.map((entry) => `${entry.tag}@${entry.game_ids.join()}`), [
    "Egypt themed@tst-1",
    "Free Spinz@tst-1",
    "Megaways@tst-1",
    "Pirates@tst-1",
  ]);
  assert.deepEqual(
    [report.table.tags_seen, report.table.mapped_to_a_label, report.table.dropped_non_attribute, report.table.dropped_merchandising],
    [12, 4, 2, 2],
  );
});

test("PL-5: the table reaches all 24 labels, and every tag of the catalogue is mapped, dropped or listed as unknown", async () => {
  assert.deepEqual([...labelsInTable()].sort(), [...THEMES, ...MECHANICS].sort());
  const { records, report } = await currentIndex();
  const delivered = records.reduce(
    (sum, record) => sum + record.canonical.source_tags.features.length + record.canonical.source_tags.themes.length + record.canonical.merchandising_tags.length,
    0,
  );
  const { table } = report;
  assert.ok(delivered > 400);
  assert.equal(table.tags_seen, delivered);
  assert.equal(table.mapped_to_a_label + table.dropped_non_attribute + table.dropped_merchandising + table.unknown, delivered);
  assert.equal(table.unknown, table.unknown_tags.reduce((sum, entry) => sum + entry.game_ids.length, 0));
});

// ---------------------------------------------------------------------------
// PL-6: the model reaches only the versions, and the records, it is meant to
// ---------------------------------------------------------------------------

test("PL-6: changing every model answer leaves the raw and table versions alone, and changes the thin version on thin records only", () => {
  const canonical = canonicaliseCatalogue(readRawCatalogue(COMMITTED.catalogue));
  const loud: ModelOutput = { ...NO_LABELS, themes: [modelLabel("sci_fi", "x", "title")], mechanics: [modelLabel("progressive_jackpot", "x", "title")] };
  let thinChanged = 0;
  let thin = 0;
  for (const record of canonical) {
    const silent = assembleRecord(record, NO_LABELS);
    const noisy = assembleRecord(record, loud);
    assert.deepEqual(noisy.versions.raw, silent.versions.raw, `${record.game_id} raw`);
    assert.deepEqual(noisy.versions.table, silent.versions.table, `${record.game_id} table`);
    assert.equal(noisy.thin, silent.thin);
    if (silent.thin) {
      thin += 1;
      if (noisy.versions.model_where_thin.text !== silent.versions.model_where_thin.text) thinChanged += 1;
    } else {
      assert.deepEqual(noisy.versions.model_where_thin, silent.versions.table, `${record.game_id}: a record that is not thin must carry the table's version`);
    }
    assert.notEqual(noisy.versions.model_everywhere.text, silent.versions.model_everywhere.text, `${record.game_id} model_everywhere`);
  }
  assert.ok(thin > 0 && thin < canonical.length, `${thin} thin records of ${canonical.length} cannot tell the versions apart`);
  assert.equal(thinChanged, thin, "the model's labels must reach every thin record");
});

test("PL-6: the thin rule is recorded in the index, every record's flag follows it, and the model's labels appear only where it allows", async () => {
  const { manifest, records, ledger } = await currentIndex();
  assert.deepEqual(manifest.thin_rule, THIN_RULE);
  let thin = 0;
  for (const record of records) {
    // The rule, restated from the raw record and the table's output only.
    const expected = record.table.themes.length === 0 || record.table.mechanics.length === 0 || record.conflict !== null;
    assert.equal(record.thin, expected, record.game_id);
    assert.ok(labelsOf(record, "table").every((label) => label.method === "synonym_table"), `${record.game_id}: a model label in the table version`);
    assert.ok(labelsOf(record, "model_everywhere").every((label) => label.method === "model"), `${record.game_id}: a table label in the model version`);
    if (record.thin) thin += 1;
    else assert.deepEqual(record.versions.model_where_thin, record.versions.table, record.game_id);
  }
  assert.ok(thin > 0 && thin < records.length);
  assert.ok(records.some((record) => labelsOf(record, "model_where_thin").some((label) => label.method === "model")));
  // The cost on record for the thin version is the cost of the thin records.
  assert.equal(ledger.versions.model_where_thin.enrichment.records, thin);
  assert.equal(ledger.versions.model_everywhere.enrichment.records, records.length);
});

// ---------------------------------------------------------------------------
// PL-7: a field in conflict adds nothing to the text
// ---------------------------------------------------------------------------

test("PL-7: when a win-system tag contradicts the description, the mechanics field adds nothing to any version's text", () => {
  const model: ModelOutput = {
    ...NO_LABELS,
    themes: [modelLabel("western", "frontier saloon", "description")],
    mechanics: [modelLabel("ways", "243 ways to win", "description"), modelLabel("free_spins", "Free Spins", "features")],
  };
  const payload = { features: ["Paylines", "Free Spins"], themes: ["Wild West"] };
  const agreeing = assembleRecord(recordFrom({ ...payload, description: "A frontier saloon with 25 fixed paylines." }), model);
  const conflicting = assembleRecord(recordFrom({ ...payload, description: "A frontier saloon with 243 ways to win." }), model);

  assert.equal(agreeing.conflict, null);
  assert.deepEqual(conflicting.conflict, { tag: "Paylines", tag_asserts: "paylines", description_states: ["ways"], description_quote: "243 ways" });
  assert.equal(conflicting.thin, true);
  for (const version of DESCRIBED) {
    // Control: without the contradiction the same tags do reach the text.
    assert.match(agreeing.versions[version].text, /\nMechanics: /, `${version} control`);
    assert.deepEqual(conflicting.versions[version].mechanics, { status: "conflict", conflict_reason: "tag_contradicts_description", labels: [] });
    assert.doesNotMatch(conflicting.versions[version].text, /Mechanics:|paylines\b(?! to win)|free spins/i, version);
    // The other field is untouched.
    assert.match(conflicting.versions[version].text, /\nThemes: western$/, version);
  }

  // Two win systems asserted for one game cannot both be right either.
  const both = assembleRecord(recordFrom({ features: ["Paylines", "Cluster Pays", "Free Spins"] }), NO_LABELS);
  assert.deepEqual(both.versions.table.mechanics, { status: "conflict", conflict_reason: "more_than_one_win_system", labels: [] });
  assert.doesNotMatch(both.versions.table.text, /Mechanics:/);
});

test("PL-7: in the built index no field in conflict has a label or a line in the text, and an abstaining field has neither", async () => {
  const { records } = await currentIndex();
  const seen = { conflict: 0, abstained: 0, asserted: 0 };
  for (const record of records) {
    for (const version of DESCRIBED) {
      const { text, themes, mechanics } = record.versions[version];
      for (const [line, field] of [["Themes", themes], ["Mechanics", mechanics]] as const) {
        assert.ok(field);
        seen[field.status] += 1;
        const hasLine = text.split("\n").some((row) => row.startsWith(`${line}: `));
        assert.equal(hasLine, field.status === "asserted", `${record.game_id} ${version} ${line}`);
        assert.equal(field.labels.length > 0, field.status === "asserted", `${record.game_id} ${version} ${line}`);
      }
      assert.equal(mechanics?.status === "conflict", record.conflict !== null || mechanics?.conflict_reason === "more_than_one_win_system");
    }
  }
  assert.ok(seen.conflict > 0 && seen.abstained > 0 && seen.asserted > 0, JSON.stringify(seen));
});

// ---------------------------------------------------------------------------
// PL-8: embeddings for every version of every game, from one model
// ---------------------------------------------------------------------------

test("PL-8: all four versions of every game have an embedding of 1,536 dimensions from the same model", async () => {
  const { manifest, records, vectors } = await currentIndex();
  assert.equal(records.length, 100);
  for (const version of VERSIONS) {
    const stored = readEmbeddingFile(embeddingPath(COMMITTED.responses, version));
    const body = stored.body as { model: string; data: { embedding: string }[] };
    assert.deepEqual([stored.model, body.model, stored.dimensions], [EMBEDDING_MODEL, EMBEDDING_MODEL, DIMENSIONS], version);
    assert.equal(manifest.models.embedding, body.model);
    assert.equal(body.data.length, records.length);
    for (let row = 0; row < records.length; row += 1) {
      const vector = vectors[version].subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS);
      assert.equal(vector.length, DIMENSIONS);
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `${version} row ${row} has length ${norm}`);
      // The index holds exactly the stored answer for this text, row for row.
      assert.equal(Buffer.from(body.data[row]?.embedding ?? "", "base64").readFloatLE(0), vector[0], `${version} row ${row}`);
    }
  }
  // The versions are different texts, so their vectors must differ somewhere.
  assert.notDeepEqual(vectors.raw, vectors.table);
  assert.notDeepEqual(vectors.table, vectors.model_where_thin);
  assert.notDeepEqual(vectors.model_where_thin, vectors.model_everywhere);
});

test("PL-8: embeddings answered by another model, or of the wrong size, stop the build and the file is named", () => {
  const breakages: [RegExp, (body: { model: string; data: { embedding: string }[] }) => void][] = [
    [/the response is from model "text-embedding-3-large", expected "text-embedding-3-small"/, (body) => void (body.model = "text-embedding-3-large")],
    [/vector 0 has 256 dimensions, expected 1536/, (body) => void ((body.data[0] ?? assert.fail()).embedding = Buffer.alloc(1024, 1).toString("base64"))],
    [/99 vectors for 100 texts/, (body) => void body.data.pop()],
  ];
  for (const [expect, breakIt] of breakages) {
    const dataDir = scratchData();
    try {
      const path = embeddingPath(paths(dataDir).responses, "table");
      const stored = readEmbeddingFile(path);
      breakIt(stored.body as { model: string; data: { embedding: string }[] });
      writeFileSync(path, JSON.stringify(stored));
      const result = rebuild(dataDir);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expect);
      assert.ok(result.stderr.includes(path), `stderr must name ${path}: ${result.stderr}`);
      assert.ok(!existsSync(paths(dataDir).index), "nothing may be written when the build stops");
    } finally {
      rmSync(dataDir, { recursive: true });
    }
  }
});

// ---------------------------------------------------------------------------
// PL-9 and PL-10: the rebuild needs no key and no hidden truth
// ---------------------------------------------------------------------------

test("PL-9: rebuilding twice with no key, from the stored responses alone, reproduces the committed index byte for byte", () => {
  const dataDir = scratchData();
  try {
    const committed = indexFiles(COMMITTED.index);
    assert.equal(committed.size, 8);
    for (const run of [1, 2]) {
      const result = rebuild(dataDir);
      assert.equal(result.status, 0, result.stderr);
      const rebuilt = indexFiles(paths(dataDir).index);
      assert.deepEqual([...rebuilt.keys()], [...committed.keys()], `run ${run}`);
      for (const [name, content] of committed) assert.ok(rebuilt.get(name)?.equals(content), `run ${run}: ${name} differs from the committed file`);
    }
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});

test("PL-10: the build completes in a tree with no hidden truth directory, and the reader refuses a path inside one", () => {
  const hidden = join(DATA, "generation", "truth.games.jsonl");
  assert.ok(existsSync(hidden), "the hidden truth must exist here, or refusing to read it proves nothing");
  assert.throws(() => readText(hidden), /may not read .*generation.* holds the hidden truth/);
  assert.throws(() => readRawCatalogue(hidden), /may not read/);
  assert.throws(() => loadIndex(join(DATA, "generation")), /may not read/);

  // The whole build, in a tree that has no such directory: whatever it wrote cannot come from the truth.
  const dataDir = scratchData();
  try {
    assert.ok(!existsSync(join(dataDir, "generation")));
    assert.deepEqual(readdirSync(dataDir).sort(), ["catalogue.raw.jsonl", "pipeline"]);
    const result = rebuild(dataDir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(indexFiles(paths(dataDir).index).get("manifest.json")?.equals(readFileSync(join(COMMITTED.index, "manifest.json"))));
    assert.ok(!existsSync(join(dataDir, "generation")));
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// PL-11: a stale, damaged or missing stored response stops the rebuild
// ---------------------------------------------------------------------------

test("PL-11: a stored response that is stale, damaged or missing stops the rebuild, names the file and writes nothing", () => {
  const [first] = canonicaliseCatalogue(readRawCatalogue(COMMITTED.catalogue));
  assert.ok(first);
  const enrichmentFile = (dataDir: string): string => join(enrichmentDir(paths(dataDir).responses), `${first.game_id}.json`);
  const embeddingFile = (dataDir: string): string => embeddingPath(paths(dataDir).responses, "raw");
  const cases: { name: string; expect: RegExp; file: (dataDir: string) => string; breakIt: (dataDir: string) => void }[] = [
    {
      name: "a record changed after its answer was stored",
      expect: /was produced by a different request/,
      file: enrichmentFile,
      breakIt: (dataDir) => {
        const catalogue = readFileSync(paths(dataDir).catalogue, "utf8");
        const changed = catalogue.replace(JSON.stringify(first.title_as_delivered), JSON.stringify(`${first.title_as_delivered} Remastered`));
        assert.notEqual(changed, catalogue);
        writeFileSync(paths(dataDir).catalogue, changed);
      },
    },
    {
      name: "a stored answer cut short",
      expect: /is not valid JSON/,
      file: enrichmentFile,
      breakIt: (dataDir) => writeFileSync(enrichmentFile(dataDir), readFileSync(enrichmentFile(dataDir), "utf8").slice(0, 400)),
    },
    {
      name: "a stored answer edited to carry a fact",
      expect: /the stored answer no longer passes validation/,
      file: enrichmentFile,
      breakIt: (dataDir) => {
        const stored = readEnrichmentFile(enrichmentFile(dataDir));
        const body = stored.attempts[0]?.body as { output: { type: string; content?: { text?: string }[] }[] };
        const part = body.output.find((item) => item.type === "message")?.content?.[0];
        assert.ok(part?.text);
        part.text = JSON.stringify({ ...(JSON.parse(part.text) as object), rtp: "99%" });
        writeFileSync(enrichmentFile(dataDir), JSON.stringify(stored));
      },
    },
    {
      name: "a stored answer missing",
      expect: /Re-run with --live and OPENAI_API_KEY set/,
      file: enrichmentFile,
      breakIt: (dataDir) => rmSync(enrichmentFile(dataDir)),
    },
    {
      name: "stored embeddings of other texts",
      expect: /holds embeddings of different texts/,
      file: embeddingFile,
      breakIt: (dataDir) => {
        const stored = readEmbeddingFile(embeddingFile(dataDir));
        writeFileSync(embeddingFile(dataDir), JSON.stringify({ ...stored, request_sha256: "0".repeat(64) }));
      },
    },
    {
      name: "stored embeddings missing",
      expect: /no stored embeddings for version "raw"/,
      file: embeddingFile,
      breakIt: (dataDir) => rmSync(embeddingFile(dataDir)),
    },
  ];
  for (const { name, expect, file, breakIt } of cases) {
    const dataDir = scratchData();
    try {
      breakIt(dataDir);
      const result = rebuild(dataDir);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, expect, name);
      assert.ok(result.stderr.includes(file(dataDir)), `${name}: stderr must name ${file(dataDir)}, got: ${result.stderr}`);
      assert.ok(!existsSync(paths(dataDir).index), `${name}: nothing may be written`);
    } finally {
      rmSync(dataDir, { recursive: true });
    }
  }
});

// ---------------------------------------------------------------------------
// PL-12: the ledger and the spend limit
// ---------------------------------------------------------------------------

test("PL-12: the ledger gives each version's calls, tokens, cost and seconds, and they are what the stored responses add up to", async () => {
  const { records, ledger } = await currentIndex();
  const sum = (ids: readonly string[]) => {
    const total = { calls: 0, input: 0, output: 0, usd: 0, seconds: 0 };
    for (const id of ids) {
      for (const attempt of readEnrichmentFile(join(enrichmentDir(COMMITTED.responses), `${id}.json`)).attempts) {
        total.calls += 1;
        total.seconds += attempt.seconds;
        total.input += attempt.usage?.input_tokens ?? 0;
        total.output += attempt.usage?.output_tokens ?? 0;
        total.usd += ((attempt.usage?.input_tokens ?? 0) * PRICES.enrichment_per_million_usd.input + (attempt.usage?.output_tokens ?? 0) * PRICES.enrichment_per_million_usd.output) / 1e6;
      }
    }
    return total;
  };
  const sentToModel: Record<Version, string[]> = {
    raw: [],
    table: [],
    model_where_thin: records.filter((record) => record.thin).map((record) => record.game_id),
    model_everywhere: records.map((record) => record.game_id),
  };
  for (const version of VERSIONS) {
    const expected = sum(sentToModel[version]);
    const { enrichment, embedding, estimated_usd: usd, seconds } = ledger.versions[version];
    assert.deepEqual([enrichment.calls, enrichment.input_tokens, enrichment.output_tokens], [expected.calls, expected.input, expected.output], version);
    assert.equal(enrichment.cached_input_tokens, 0, "the cost check below assumes no cached input");
    assert.ok(Math.abs(enrichment.estimated_usd - expected.usd) < 1e-6, version);
    assert.ok(Math.abs(enrichment.seconds - expected.seconds) < 1e-3, version);
    const stored = readEmbeddingFile(embeddingPath(COMMITTED.responses, version));
    assert.deepEqual([embedding.calls, embedding.texts, embedding.tokens, embedding.seconds], [1, records.length, stored.usage.total_tokens, stored.seconds], version);
    assert.ok(embedding.tokens > 0 && embedding.estimated_usd > 0, version);
    assert.ok(Math.abs(usd - (enrichment.estimated_usd + embedding.estimated_usd)) < 1e-6, version);
    assert.ok(Math.abs(seconds - (enrichment.seconds + embedding.seconds)) < 1e-3, version);
  }
  assert.equal(ledger.versions.raw.enrichment.calls, 0);
  assert.equal(ledger.versions.table.enrichment.calls, 0);
  assert.ok(ledger.versions.model_where_thin.enrichment.calls > 0);
  assert.ok(ledger.versions.model_everywhere.enrichment.calls > ledger.versions.model_where_thin.enrichment.calls);
  // Every stored response once: the full-model version's answers plus all four embedding calls.
  const embeddings = VERSIONS.reduce((total, version) => total + ledger.versions[version].embedding.estimated_usd, 0);
  assert.ok(Math.abs(ledger.spent.total_usd - (ledger.versions.model_everywhere.enrichment.estimated_usd + embeddings)) < 1e-5);
});

test("PL-12: a live run stops before the call that could pass the spend limit, counts what is already stored, and writes no index", async () => {
  const answer = { status: 200, body: completed({ themes: [], mechanics: [] }) };
  const perCall = (1000 * PRICES.enrichment_per_million_usd.input + 100 * PRICES.enrichment_per_million_usd.output) / 1e6;
  const dataDir = scratchData(false);
  try {
    // A limit that cannot cover a hundred calls.
    const limit = 0.2;
    const first = fakeTransport(() => answer);
    const live = liveWith(first.transport, limit);
    await assert.rejects(runBuild({ dataDir, live, log: quiet }), (error) => error instanceof SpendLimitReached && /spend limit reached before the enrichment call for/.test(error.message));
    assert.ok(first.calls.enrichment > 0 && first.calls.enrichment < 100, `${first.calls.enrichment} calls`);
    assert.equal(first.calls.embedding, 0);
    assert.ok(live.budget.spentUsd <= limit);
    assert.ok(Math.abs(live.budget.spentUsd - first.calls.enrichment * perCall) < 1e-9, "every call that was made is counted");
    assert.ok(!existsSync(paths(dataDir).index));
    assert.equal(readdirSync(enrichmentDir(paths(dataDir).responses)).length, first.calls.enrichment, "what was paid for is kept");

    // What the stored responses add up to is what was spent, and a run that starts from it under a used-up limit calls nothing.
    const stored = storedSpend(paths(dataDir).responses).total_usd;
    assert.ok(Math.abs(stored - live.budget.spentUsd) < 1e-6, `stored ${stored}, spent ${live.budget.spentUsd}`);
    const second = fakeTransport(() => answer);
    await assert.rejects(runBuild({ dataDir, live: liveWith(second.transport, stored, stored), log: quiet }), SpendLimitReached);
    assert.equal(second.calls.enrichment, 0);
    const spentBefore = stored;

    // With room to spend, the same tree finishes, never writes the key, and then rebuilds identically with no key.
    const third = fakeTransport(() => answer);
    const result = await runBuild({ dataDir, live: liveWith(third.transport, 5, spentBefore), log: quiet });
    assert.equal(third.calls.enrichment, 100 - first.calls.enrichment);
    assert.equal(third.calls.embedding, 4);
    assert.ok(Math.abs((result.ledger?.spent.total_usd ?? 0) - (100 * perCall + (4 * 1000 * PRICES.embedding_per_million_usd.input) / 1e6)) < 1e-6);
    const written = indexFiles(paths(dataDir).index);
    const everything = spawnSync("grep", ["-rl", STAND_IN, dataDir], { encoding: "utf8" });
    assert.equal(everything.stdout, "", "the key must not be in any file the run wrote");
    assert.equal(rebuild(dataDir).status, 0);
    for (const [name, content] of indexFiles(paths(dataDir).index)) assert.ok(written.get(name)?.equals(content), `${name} changed on the keyless rebuild`);
  } finally {
    rmSync(dataDir, { recursive: true });
  }
});
