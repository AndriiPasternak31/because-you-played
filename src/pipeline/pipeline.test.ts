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
import { BYTES_PER_VECTOR, DIMENSIONS, EMBEDDING_MODEL, embeddingPath, obtainEmbeddings, readEmbeddingFile, shareVectors } from "./embed.ts";
import {
  ENRICHMENT_MODEL,
  PROMPT_VERSION,
  buildRequest,
  enrichmentDir,
  interpretResponse,
  obtainEnrichment,
  quoteIsVerbatim,
  readEnrichmentFile,
  type ModelOutput,
} from "./enrich.ts";
import { loadIndex, sealManifest, type Index, type IndexRecord, type Manifest } from "./index-store.ts";
import { readText, sealed, sha256 } from "./io.ts";
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
  const vectorFor = (call: number, position: number): string => {
    const vector = Buffer.alloc(DIMENSIONS * 4);
    for (let column = 0; column < DIMENSIONS; column += 1) vector.writeFloatLE(column % 7 === 0 ? 0.25 : 0.01, column * 4);
    // Every vector differs by call and by position, so a vector made again cannot pass for one that was kept.
    vector.writeFloatLE(call + position / 1000, 0);
    return vector.toString("base64");
  };
  const transport: Transport = async (url, apiKey, body) => {
    assert.equal(apiKey, STAND_IN);
    if (url.endsWith("/embeddings")) {
      calls.embedding += 1;
      const { input } = body as { input: string[] };
      return {
        status: 200,
        body: {
          model: EMBEDDING_MODEL,
          data: input.map((_, index) => ({ index, embedding: vectorFor(calls.embedding, index) })),
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
/** For a report built in a test from records alone: no vector was shared. */
const NONE_TAKEN = { raw: 0, table: 0, model_where_thin: 0, model_everywhere: 0 };
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
  const report = buildReport(1, [assembleRecord(record, { outcome: "accepted", themes: result.themes, mechanics: result.mechanics, stripped: result.stripped })], new Map(), NONE_TAKEN);
  assert.deepEqual(report.enrichment.labels_stripped, { label_outside_list: 2, invented_quote: 4, duplicate_label: 1 });
  assert.equal(report.enrichment.labels_kept, 3);
});

test("PL-2: a quote is whole words: a piece taken from inside a word is not a quote, and a label backed by one is stripped", () => {
  const record = recordFrom({ name: "Cowboys of Testvale", description: "A party of art thieves meets a sphinx and its riddles. Die Götter der Unterwelt warten." });
  const cases: [Label["source_field"], string, boolean][] = [
    ["description", "ri", false], // inside "riddles"
    ["description", "sphinx and its rid", false], // ends inside a word
    ["description", "phinx and its riddles", false], // starts inside a word
    ["description", "ötter der Unterwelt", false], // starts inside a word with a non-ASCII letter
    ["description", "Die Gött", false],
    ["title", "Cow", false],
    ["title", "boys of Testvale", false],
    ["description", "its riddles", true], // ends at a full stop
    ["description", "A party", true], // starts the text
    ["description", "Unterwelt warten.", true], // ends the text
    ["description", "Die Götter", true],
    ["description", "art", true], // inside "party" first, then a word of its own
    ["title", "Cowboys", true],
    ["title", "Cowboys of Testvale", true],
  ];
  for (const [sourceField, quote, expected] of cases) {
    assert.equal(quoteIsVerbatim(record, sourceField, quote), expected, `"${quote}" in the ${sourceField}`);
  }
  // Through the checker: the label is stripped and counted, not kept.
  const result = interpretResponse(
    completed({
      themes: [
        { label: "ancient_egypt", quote: "ri", source_field: "description" },
        { label: "western", quote: "Cow", source_field: "title" },
        { label: "mythology", quote: "its riddles", source_field: "description" },
      ],
      mechanics: [],
    }),
    record,
  );
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return;
  assert.deepEqual(result.themes.map((label) => label.label), ["mythology"]);
  assert.deepEqual(result.stripped.map((entry) => `${entry.label}:${entry.reason}`), ["ancient_egypt:invented_quote", "western:invented_quote"]);
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
          const escaped = label.quote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const asWholeWords = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
          assert.ok(label.quote.trim().length >= 2 && source.some((text) => asWholeWords.test(text)), `${where}: quote "${label.quote}" not found as whole words`);
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
    const report = buildReport(1, [assembleRecord(record, output)], new Map([[record.game_id, file]]), NONE_TAKEN);
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
      name: "a quote cut to a piece of a word, with the hashes brought up to date",
      expect: /the quote for "\w+" in model_everywhere is not in its description/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        const cuttable = (label: Label): boolean => label.source_field === "description" && /^[a-z]{3}/i.test(label.quote);
        const position = lines.findIndex((line) => line.length > 0 && labelsOf(JSON.parse(line) as IndexRecord, "model_everywhere").some(cuttable));
        const record = JSON.parse(lines[position] ?? "") as IndexRecord;
        const label = labelsOf(record, "model_everywhere").find(cuttable);
        assert.ok(label);
        // Still a run of characters of the description, but it now starts inside a word.
        label.quote = label.quote.slice(1);
        assert.ok(record.canonical.description?.includes(label.quote));
        lines[position] = JSON.stringify(record);
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    {
      name: "a disputed tag put back into the table version, with the hashes brought up to date",
      expect: /the table version carries a label on a field whose tag ".+" the description contradicts/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        const position = lines.findIndex((line) => line.length > 0 && (JSON.parse(line) as IndexRecord).conflict !== null);
        const record = JSON.parse(lines[position] ?? "") as IndexRecord;
        record.versions.table.mechanics = { status: "asserted", conflict_reason: null, labels: record.table.mechanics };
        lines[position] = JSON.stringify(record);
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    {
      name: "a model label on a disputed field backed by the disputed tag, with the hashes brought up to date",
      expect: /"\w+" in model_everywhere is backed by the features list, which is in dispute/,
      corrupt: (dir) => {
        const lines = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n");
        const position = lines.findIndex((line) => line.length > 0 && (JSON.parse(line) as IndexRecord).conflict !== null);
        const record = JSON.parse(lines[position] ?? "") as IndexRecord;
        const disputed = record.table.mechanics.find((label) => label.quote === record.conflict?.tag);
        assert.ok(disputed && disputed.source_field === "features");
        // A real delivered tag, quoted whole, so only the rule about disputed fields can refuse it.
        record.versions.model_everywhere.mechanics?.labels.push({ ...disputed, method: "model", model: ENRICHMENT_MODEL, prompt_version: PROMPT_VERSION });
        lines[position] = JSON.stringify(record);
        writeFileSync(join(dir, "records.jsonl"), lines.join("\n"));
        reseal(dir);
      },
    },
    {
      name: "one text given two vectors, with the hashes brought up to date",
      expect: /have the same text and different vectors/,
      corrupt: (dir) => {
        const records = readFileSync(join(dir, "records.jsonl"), "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as IndexRecord);
        const row = records.findIndex((record, position) => position > 0 && record.versions.table.text_sha256 === record.versions.model_where_thin.text_sha256);
        assert.ok(row > 0);
        // A real, usable vector, only not the one this text has in the table version.
        const bytes = readFileSync(join(dir, "vectors.model_where_thin.f32"));
        bytes.copy(bytes, row * BYTES_PER_VECTOR, 0, BYTES_PER_VECTOR);
        writeFileSync(join(dir, "vectors.model_where_thin.f32"), bytes);
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
    features: ["Varnaways", "Free Spinz", "FREE-SPINS", "High Volatility", "Hold & Respin", "Freespins"],
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
    { tag: "Varnaways", source_field: "features" },
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
  const report = buildReport(1, [assembleRecord(record, NO_LABELS)], new Map(), NONE_TAKEN);
  assert.equal(report.table.unknown, 4);
  assert.deepEqual(report.table.unknown_tags.map((entry) => `${entry.tag}@${entry.game_ids.join()}`), [
    "Egypt themed@tst-1",
    "Free Spinz@tst-1",
    "Pirates@tst-1",
    "Varnaways@tst-1",
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
  // A conflict is a reason to call the model, even where the table filled both fields.
  const disputed = records.filter((record) => record.conflict !== null);
  assert.ok(disputed.some((record) => record.table.themes.length > 0 && record.table.mechanics.length > 0));
  assert.ok(disputed.every((record) => record.thin));
  assert.ok(records.some((record) => labelsOf(record, "model_where_thin").some((label) => label.method === "model")));
  // The cost on record for the thin version is the cost of the thin records.
  assert.equal(ledger.versions.model_where_thin.enrichment.records, thin);
  assert.equal(ledger.versions.model_everywhere.enrichment.records, records.length);
});

// ---------------------------------------------------------------------------
// PL-7: on a contradiction the table says nothing and the model's reading of the text stands
// ---------------------------------------------------------------------------

test("PL-7: when a tag contradicts the description, the table version adds nothing for that field and the model versions carry the model's reading of the text", () => {
  const fromText = [modelLabel("ways", "243 ways to win", "description"), modelLabel("multipliers", "rising multipliers", "description")];
  const fromTag = modelLabel("free_spins", "Free Spins", "features");
  const model: ModelOutput = { ...NO_LABELS, themes: [modelLabel("western", "frontier saloon", "description")], mechanics: [fromText[0] as Label, fromTag, fromText[1] as Label] };
  const payload = { features: ["Paylines", "Free Spins"], themes: ["Wild West"] };
  const agreeing = assembleRecord(recordFrom({ ...payload, description: "A frontier saloon with 25 fixed paylines." }), model);
  const conflicting = assembleRecord(recordFrom({ ...payload, description: "A frontier saloon with 243 ways to win and rising multipliers." }), model);

  // Control: without the contradiction the delivered tags do reach the table version's text.
  assert.equal(agreeing.conflict, null);
  assert.match(agreeing.versions.table.text, /\nMechanics: paylines, free spins$/);

  // The record says what happened: which tag was contradicted, and that the model's reading was used.
  assert.deepEqual(conflicting.conflict, {
    tag: "Paylines",
    tag_asserts: "paylines",
    description_states: ["ways"],
    description_quote: "243 ways",
    model_reading_used: true,
    model_labels_withheld: [fromTag],
  });
  assert.equal(conflicting.thin, true, "a conflict is a reason to call the model");

  // The table cannot tell which side is right: the disputed field adds nothing, not even the tags that were not disputed.
  assert.deepEqual(conflicting.versions.table.mechanics, { status: "conflict", conflict_reason: "tag_contradicts_description", labels: [] });
  assert.doesNotMatch(conflicting.versions.table.text, /Mechanics:/);
  assert.match(conflicting.versions.table.text, /\nThemes: western$/, "the other field is untouched");

  // Both model versions carry the model's labels that are quoted from the text. The one backed by the disputed tag list is left out.
  for (const version of ["model_where_thin", "model_everywhere"] as const) {
    assert.deepEqual(conflicting.versions[version].mechanics, { status: "asserted", conflict_reason: null, labels: fromText }, version);
    assert.match(conflicting.versions[version].text, /\nMechanics: ways, multipliers$/, version);
    assert.doesNotMatch(conflicting.versions[version].text, /paylines|free spins/i, version);
  }
});

test("PL-7: on a disputed field a label backed only by the tag lists never stands, and with no reading of the text the field stays in conflict", () => {
  const payload = { features: ["Paylines", "Free Spins"], themes: ["Wild West"], description: "A frontier saloon with 243 ways to win." };
  const build = (mechanics: Label[]): IndexRecord => assembleRecord(recordFrom(payload), { ...NO_LABELS, mechanics });
  const unresolved = { status: "conflict", conflict_reason: "tag_contradicts_description", labels: [] };

  // The model repeats the tags: the disputed tag itself, and a neighbour from the same list.
  const tagBacked = [modelLabel("paylines", "Paylines", "features"), modelLabel("free_spins", "Free Spins", "features"), modelLabel("multipliers", "Wild West", "themes")];
  const repeated = build(tagBacked);
  assert.deepEqual(repeated.conflict?.model_labels_withheld, tagBacked);
  assert.equal(repeated.conflict?.model_reading_used, false);
  // The model abstains.
  const silent = build([]);
  assert.deepEqual([silent.conflict?.model_reading_used, silent.conflict?.model_labels_withheld], [false, []]);
  // The model reads two win systems out of the text: that settles nothing.
  const torn = build([modelLabel("ways", "243 ways to win", "description"), modelLabel("cluster_pays", "frontier saloon", "description")]);
  assert.equal(torn.conflict?.model_reading_used, false);

  for (const version of DESCRIBED) {
    assert.deepEqual(repeated.versions[version].mechanics, unresolved, `repeated tags, ${version}`);
    assert.deepEqual(silent.versions[version].mechanics, unresolved, `no reading, ${version}`);
    for (const record of [repeated, silent, torn]) assert.doesNotMatch(record.versions[version].text, /Mechanics:/, version);
  }
  assert.deepEqual(torn.versions.model_everywhere.mechanics, { status: "conflict", conflict_reason: "more_than_one_win_system", labels: [] });

  // Away from a conflict the model may still quote a tag: the rule is about the disputed field only.
  const calm = assembleRecord(recordFrom({ ...payload, description: "A frontier saloon with 25 fixed paylines." }), { ...NO_LABELS, mechanics: tagBacked.slice(0, 2) });
  assert.deepEqual(calm.versions.model_everywhere.mechanics?.labels, tagBacked.slice(0, 2));

  // Two win systems asserted by the tags alone cannot both be right either.
  const both = assembleRecord(recordFrom({ features: ["Paylines", "Cluster Pays", "Free Spins"] }), NO_LABELS);
  assert.deepEqual(both.versions.table.mechanics, { status: "conflict", conflict_reason: "more_than_one_win_system", labels: [] });
  assert.doesNotMatch(both.versions.table.text, /Mechanics:/);
});

test("PL-7: in the built index a disputed field is empty in the table version and holds only the model's text-backed labels in the model versions", async () => {
  const { records } = await currentIndex();
  const seen = { conflict: 0, abstained: 0, asserted: 0 };
  let resolved = 0;
  let labelsUsed = 0;
  for (const record of records) {
    for (const version of DESCRIBED) {
      const { text, themes, mechanics } = record.versions[version];
      for (const [line, field] of [["Themes", themes], ["Mechanics", mechanics]] as const) {
        assert.ok(field);
        seen[field.status] += 1;
        // A field adds a line to the text exactly when it holds labels.
        const hasLine = text.split("\n").some((row) => row.startsWith(`${line}: `));
        assert.equal(hasLine, field.status === "asserted", `${record.game_id} ${version} ${line}`);
        assert.equal(field.labels.length > 0, field.status === "asserted", `${record.game_id} ${version} ${line}`);
      }
    }
    const { conflict } = record;
    if (conflict === null) continue;
    assert.deepEqual(record.versions.table.mechanics, { status: "conflict", conflict_reason: "tag_contradicts_description", labels: [] }, record.game_id);
    assert.ok(record.table.mechanics.some((label) => label.quote === conflict.tag && label.label === conflict.tag_asserts), `${record.game_id}: the contradicted tag is one that was delivered`);
    // What the model read from the text, worked out here from its checked answer alone.
    const fromText = record.model.mechanics.filter((label) => label.source_field === "description" || label.source_field === "title");
    assert.deepEqual(conflict.model_labels_withheld, record.model.mechanics.filter((label) => !fromText.includes(label)), record.game_id);
    for (const version of ["model_where_thin", "model_everywhere"] as const) {
      const used = record.versions[version].mechanics?.labels ?? [];
      assert.equal(conflict.model_reading_used, used.length > 0, `${record.game_id} ${version}`);
      assert.deepEqual(used.map((label) => label.label).sort(), conflict.model_reading_used ? fromText.map((label) => label.label).sort() : [], `${record.game_id} ${version}`);
      assert.ok(used.every((label) => label.method === "model" && (label.source_field === "description" || label.source_field === "title")), `${record.game_id} ${version}`);
    }
    if (conflict.model_reading_used) {
      resolved += 1;
      labelsUsed += fromText.length;
    }
  }
  assert.ok(seen.conflict > 0 && seen.abstained > 0 && seen.asserted > 0, JSON.stringify(seen));
  assert.ok(resolved > 0 && labelsUsed > resolved, `${resolved} conflicts resolved with ${labelsUsed} labels`);
});

// ---------------------------------------------------------------------------
// PL-8: embeddings for every version of every game, from one model
// ---------------------------------------------------------------------------

test("PL-8: all four versions of every game have an embedding of 1,536 dimensions from the same model", async () => {
  const { manifest, records, vectors } = await currentIndex();
  assert.equal(records.length, 100);
  // The vector the index should hold for each text: the stored answer of the first version on the ladder to embed it.
  const expectedFor = new Map<string, Buffer>();
  for (const version of VERSIONS) {
    const stored = readEmbeddingFile(embeddingPath(COMMITTED.responses, version));
    assert.deepEqual([stored.version, stored.model, stored.dimensions], [version, EMBEDDING_MODEL, DIMENSIONS], version);
    // This version's own stored answer for each of its texts, found here by game and text hash.
    const own = new Map<string, Buffer>();
    for (const call of stored.calls) {
      const body = call.body as { model: string; data: { index: number; embedding: string }[] };
      assert.equal(body.model, manifest.models.embedding, version);
      assert.equal(body.data.length, call.inputs.length, version);
      call.inputs.forEach((input, row) => {
        const entry = body.data.find((candidate) => candidate.index === row);
        own.set(`${input.game_id} ${input.text_sha256}`, Buffer.from(entry?.embedding ?? "", "base64"));
      });
    }
    records.forEach((record, row) => {
      const hash = record.versions[version].text_sha256;
      // Every version embedded every one of its own texts: that is the cost the ledger charges it.
      const mine = own.get(`${record.game_id} ${hash}`);
      assert.ok(mine, `${version} ${record.game_id}: no stored embedding of its current text`);
      if (!expectedFor.has(hash)) expectedFor.set(hash, mine);
      const expected = expectedFor.get(hash) ?? assert.fail();

      const vector = vectors[version].subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS);
      assert.equal(vector.length, DIMENSIONS);
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `${version} row ${row} has length ${norm}`);
      assert.ok(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).equals(expected), `${version} ${record.game_id}: not the stored vector of its text`);
    });
  }
  // The versions are different texts, so their vectors must differ somewhere.
  assert.notDeepEqual(vectors.raw, vectors.table);
  assert.notDeepEqual(vectors.table, vectors.model_where_thin);
  assert.notDeepEqual(vectors.model_where_thin, vectors.model_everywhere);
});

test("PL-8: a text has one vector: wherever two versions or two games hold the same text, they hold the same bytes", async () => {
  const { records, vectors, report } = await currentIndex();
  const first = new Map<string, { bytes: Buffer; where: string }>();
  const shared: Record<string, number> = {};
  for (const version of VERSIONS) {
    shared[version] = 0;
    records.forEach((record, row) => {
      const view = vectors[version].subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS);
      const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      const where = `${version} ${record.game_id}`;
      const seen = first.get(record.versions[version].text_sha256);
      if (seen === undefined) first.set(record.versions[version].text_sha256, { bytes, where });
      else {
        assert.ok(seen.bytes.equals(bytes), `${where} has the same text as ${seen.where} and another vector`);
        shared[version] = (shared[version] ?? 0) + 1;
      }
    });
  }
  // Not an empty claim: most of the later versions' texts are ones an earlier version already holds.
  assert.ok((shared["model_where_thin"] ?? 0) > 50 && (shared["model_everywhere"] ?? 0) > 50, JSON.stringify(shared));
  assert.deepEqual(report.vectors_taken_from_an_earlier_text, shared);

  // The rule itself, on vectors that all differ: the first version on the ladder to hold a text gives it its vector.
  const block = (...seeds: number[]): Buffer => Buffer.concat(seeds.map((seed) => Buffer.alloc(BYTES_PER_VECTOR, seed)));
  const own = { raw: block(1, 2), table: block(3, 4), model_where_thin: block(5, 6), model_everywhere: block(7, 8) };
  const hashes = { raw: ["a", "b"], table: ["a", "c"], model_where_thin: ["a", "c"], model_everywhere: ["d", "c"] };
  const result = shareVectors(hashes, own);
  assert.deepEqual(result.taken, { raw: 0, table: 1, model_where_thin: 2, model_everywhere: 1 });
  assert.ok(result.vectors.raw.equals(block(1, 2)) && result.vectors.table.equals(block(1, 4)));
  assert.ok(result.vectors.model_where_thin.equals(block(1, 4)) && result.vectors.model_everywhere.equals(block(7, 4)));
});

test("PL-8: when a text changes, only that text is embedded again and every other vector keeps its bytes", async () => {
  const dataDir = scratchData(false);
  const { responses } = paths(dataDir);
  try {
    const sent: string[][] = [];
    const { transport } = fakeTransport(() => assert.fail("no enrichment call belongs here"));
    const recording: Transport = async (url, apiKey, body) => {
      sent.push((body as { input: string[] }).input);
      return transport(url, apiKey, body);
    };
    const run = (items: { game_id: string; text: string }[], live: boolean) =>
      obtainEmbeddings("table", items, { responsesDir: responses, live: live ? liveWith(recording) : null, log: quiet });
    const vector = (bytes: Buffer, row: number): Buffer => bytes.subarray(row * BYTES_PER_VECTOR, (row + 1) * BYTES_PER_VECTOR);

    const before = [{ game_id: "a", text: "alpha" }, { game_id: "b", text: "beta" }, { game_id: "c", text: "gamma" }];
    const after = [before[0] ?? assert.fail(), { game_id: "b", text: "beta, revised" }, before[2] ?? assert.fail()];
    const first = await run(before, true);
    const second = await run(after, true);
    assert.deepEqual(sent, [["alpha", "beta", "gamma"], ["beta, revised"]], "only the changed text may be sent the second time");
    assert.ok(vector(second.bytes, 0).equals(vector(first.bytes, 0)) && vector(second.bytes, 2).equals(vector(first.bytes, 2)), "the unchanged texts keep their vectors");
    assert.ok(!vector(second.bytes, 1).equals(vector(first.bytes, 1)), "the changed text has a new vector");
    assert.deepEqual(second.file.calls.map((call) => call.inputs.map((input) => input.game_id)), [["a", "b", "c"], ["b"]]);

    // With no key the same texts give the same bytes and nothing is sent.
    assert.ok((await run(after, false)).bytes.equals(second.bytes));
    assert.equal(sent.length, 2);
    // A text that was never embedded stops a keyless rebuild, and the file and the game are named.
    const path = embeddingPath(responses, "table");
    await assert.rejects(run([...after.slice(0, 2), { game_id: "c", text: "gamma, revised" }], false), (error: Error) => error.message.startsWith(`${path} holds no embedding for the current text of 1 game(s): c.`));
    // One game's vector is never handed to another game, even for the same words.
    await assert.rejects(run([{ game_id: "d", text: "alpha" }], false), /current text of 1 game\(s\): d\./);
    // Two stored vectors for one text: nothing says which is right, so neither is used.
    const stored = readEmbeddingFile(path);
    stored.calls.push(stored.calls[1] ?? assert.fail());
    writeFileSync(path, JSON.stringify(sealed(stored)));
    await assert.rejects(run(after, false), (error: Error) => error.message === `${path} holds two embeddings for the same text of b; call 3 repeats an earlier one`);
  } finally {
    rmSync(dataDir, { recursive: true });
  }
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
      breakIt(stored.calls[0]?.body as { model: string; data: { embedding: string }[] });
      // Sealed again, so that the check of the vectors has to catch it and not the seal.
      writeFileSync(path, JSON.stringify(sealed(stored)));
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
        writeFileSync(enrichmentFile(dataDir), JSON.stringify(sealed(stored)));
      },
    },
    {
      name: "a stored answer missing",
      expect: /Re-run with --live and OPENAI_API_KEY set/,
      file: enrichmentFile,
      breakIt: (dataDir) => rmSync(enrichmentFile(dataDir)),
    },
    {
      name: "stored embeddings of another text for one game",
      expect: /holds no embedding for the current text of 1 game\(s\): /,
      file: embeddingFile,
      breakIt: (dataDir) => {
        const stored = readEmbeddingFile(embeddingFile(dataDir));
        (stored.calls[0]?.inputs[0] ?? assert.fail()).text_sha256 = "0".repeat(64);
        writeFileSync(embeddingFile(dataDir), JSON.stringify(sealed(stored)));
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

test("PL-11: a stored response edited by hand is refused, whatever the edit, and the file is named", () => {
  const [first] = canonicaliseCatalogue(readRawCatalogue(COMMITTED.catalogue));
  assert.ok(first);
  const enrichmentFile = (dataDir: string): string => join(enrichmentDir(paths(dataDir).responses), `${first.game_id}.json`);
  const embeddingFile = (version: Version) => (dataDir: string): string => embeddingPath(paths(dataDir).responses, version);
  type Stored = Record<string, unknown> & { calls: { inputs: unknown[]; body: { data: { embedding: string }[] } }[]; attempts: { usage: { output_tokens: number }; body: { output: { type: string; content?: { text?: string }[] }[] } }[] };
  const edit = (path: string, change: (stored: Stored) => void): void => {
    // Edited as a person would: read, change, write back. The seal is left as it was.
    const stored = JSON.parse(readFileSync(path, "utf8")) as Stored;
    change(stored);
    writeFileSync(path, `${JSON.stringify(stored, null, 1)}\n`);
  };
  const cases: { name: string; file: (dataDir: string) => string; change: (stored: Stored) => void; expect?: RegExp }[] = [
    {
      name: "two games' entries swapped in the list of what was embedded",
      file: embeddingFile("raw"),
      change: (stored) => {
        const inputs = stored.calls[0]?.inputs ?? assert.fail();
        [inputs[0], inputs[1]] = [inputs[1], inputs[0]];
      },
    },
    {
      name: "two vectors swapped in the response body",
      file: embeddingFile("table"),
      change: (stored) => {
        const data = stored.calls[0]?.body.data ?? assert.fail();
        const [a, b] = [data[0] ?? assert.fail(), data[1] ?? assert.fail()];
        [a.embedding, b.embedding] = [b.embedding, a.embedding];
      },
    },
    {
      name: "a model answer edited into another answer that would pass every check",
      file: enrichmentFile,
      change: (stored) => {
        const part = stored.attempts[0]?.body.output.find((item) => item.type === "message")?.content?.[0];
        assert.ok(part?.text);
        part.text = JSON.stringify({ themes: [], mechanics: [] });
      },
    },
    {
      name: "the tokens a call reported, edited",
      file: enrichmentFile,
      change: (stored) => void ((stored.attempts[0] ?? assert.fail()).usage.output_tokens = 1),
    },
    {
      name: "the seal removed",
      file: embeddingFile("model_everywhere"),
      change: (stored) => void delete stored["seal_sha256"],
      expect: /carries no seal/,
    },
  ];
  for (const { name, file, change, expect } of cases) {
    const dataDir = scratchData();
    try {
      edit(file(dataDir), change);
      const result = rebuild(dataDir);
      assert.equal(result.status, 1, `${name}: the rebuild must stop. ${result.stderr}`);
      assert.match(result.stderr, expect ?? /does not match its seal/, name);
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
    const add = (pick: (call: (typeof stored.calls)[number]) => number): number => stored.calls.reduce((total, call) => total + pick(call), 0);
    assert.deepEqual([embedding.calls, embedding.texts, embedding.tokens], [stored.calls.length, add((call) => call.inputs.length), add((call) => call.usage.total_tokens)], version);
    assert.ok(embedding.texts >= records.length && Math.abs(embedding.seconds - add((call) => call.seconds)) < 1e-3, version);
    assert.ok(Math.abs(embedding.estimated_usd - (embedding.tokens * PRICES.embedding_per_million_usd.input) / 1e6) < 1e-6, version);
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
