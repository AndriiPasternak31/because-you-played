/**
 * The index: what the service and the console load. A directory of files:
 *
 *   manifest.json            format version, index hash, model ids, prompt version, dimensions,
 *                            catalogue hash, thin rule, game ids in row order, and a hash of every other file
 *   records.jsonl            one line per game, sorted by game id: the canonical record, the table's output,
 *                            the model's checked output, and the four versions with their labels and quotes
 *   vectors.<version>.f32    one vector per game in the same order: little-endian 32-bit floats
 *   ledger.json              calls, tokens, estimated cost and seconds per version
 *   report.json              what was dropped, unknown, stripped and in conflict
 *
 * `loadIndex` is the only way in, and it validates everything before returning.
 * Availability is not here: it is read from the offerings file by whoever serves.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CanonicalRecordSchema } from "./canonical.ts";
import { BYTES_PER_VECTOR, DIMENSIONS, EMBEDDING_MODEL, assertUsableVectors } from "./embed.ts";
import { ENRICHMENT_MODEL, ModelOutputSchema, PROMPT_VERSION, quoteIsVerbatim } from "./enrich.ts";
import { assertReadable, parseJsonFrom, readBytes, sha256 } from "./io.ts";
import type { BuildReport, Ledger } from "./report.ts";
import { TableOutputSchema } from "./synonyms.ts";
import { ConflictSchema, EVIDENCE_LEVELS, THIN_RULE, VERSIONS, VersionContentSchema, type Version } from "./versions.ts";

export const FORMAT_VERSION = 1;

export const IndexRecordSchema = z.strictObject({
  game_id: z.string().min(1),
  /** Written by deterministic code from the raw row. Nothing a model returns is merged into it. */
  canonical: CanonicalRecordSchema,
  evidence: z.enum(EVIDENCE_LEVELS),
  table: TableOutputSchema,
  conflict: ConflictSchema.nullable(),
  thin: z.boolean(),
  model: ModelOutputSchema,
  versions: z.strictObject({
    raw: VersionContentSchema,
    table: VersionContentSchema,
    model_where_thin: VersionContentSchema,
    model_everywhere: VersionContentSchema,
  }),
});
export type IndexRecord = z.infer<typeof IndexRecordSchema>;

const FileEntrySchema = z.strictObject({ sha256: z.string(), bytes: z.number().int().nonnegative() });

const ManifestSchema = z.strictObject({
  format_version: z.number().int(),
  /** SHA-256 of this manifest without this key. It names one index, and changes when anything in it does. */
  index_hash: z.string(),
  catalogue: z.strictObject({ sha256: z.string(), raw_rows: z.number().int(), games: z.number().int() }),
  models: z.strictObject({ enrichment: z.string(), embedding: z.string() }),
  prompt_version: z.string(),
  prompt_sha256: z.string(),
  dimensions: z.number().int().positive(),
  versions: z.array(z.enum(VERSIONS)),
  thin_rule: z.strictObject({ id: z.string(), rule: z.string() }),
  game_ids: z.array(z.string()),
  files: z.record(z.string(), FileEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export interface Index {
  manifest: Manifest;
  records: IndexRecord[];
  /** Per version, all vectors end to end: row `i` is `records[i]`, at `i * dimensions`. */
  vectors: Record<Version, Float32Array>;
  ledger: Ledger;
  report: BuildReport;
}

const vectorsFile = (version: Version): string => `vectors.${version}.f32`;

/** JSON with object keys sorted at every depth, so that a hash does not depend on key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sets the hash that seals a manifest. Exported so that a test can re-seal a copy it has altered on purpose. */
export function sealManifest(manifest: Omit<Manifest, "index_hash"> & { index_hash?: string }): Manifest {
  const { index_hash: _previous, ...rest } = manifest;
  return { ...rest, index_hash: sha256(stableJson(rest)) };
}

export interface IndexParts {
  catalogue: { sha256: string; raw_rows: number };
  promptSha256: string;
  records: readonly IndexRecord[];
  vectors: Record<Version, Buffer>;
  ledger: Ledger;
  report: BuildReport;
}

/** Serialises the index. Returns each file's content, the manifest last, without touching the disk. */
export function serialiseIndex(parts: IndexParts): Map<string, string | Buffer> {
  const files = new Map<string, string | Buffer>();
  files.set("records.jsonl", parts.records.map((record) => `${JSON.stringify(IndexRecordSchema.parse(record))}\n`).join(""));
  for (const version of VERSIONS) files.set(vectorsFile(version), parts.vectors[version]);
  files.set("ledger.json", `${JSON.stringify(parts.ledger, null, 2)}\n`);
  files.set("report.json", `${JSON.stringify(parts.report, null, 2)}\n`);
  const manifest = sealManifest({
    format_version: FORMAT_VERSION,
    catalogue: { ...parts.catalogue, games: parts.records.length },
    models: { enrichment: ENRICHMENT_MODEL, embedding: EMBEDDING_MODEL },
    prompt_version: PROMPT_VERSION,
    prompt_sha256: parts.promptSha256,
    dimensions: DIMENSIONS,
    versions: [...VERSIONS],
    thin_rule: { ...THIN_RULE },
    game_ids: parts.records.map((record) => record.game_id),
    files: Object.fromEntries(
      [...files].map(([name, content]) => [name, { sha256: sha256(content), bytes: Buffer.byteLength(content) }]),
    ),
  });
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

export function writeIndex(dir: string, parts: IndexParts): Manifest {
  const files = serialiseIndex(parts);
  // Validated in memory first, so that a build which would not load writes nothing.
  const index = validateIndex((name) => {
    const content = files.get(name);
    return content === undefined ? null : Buffer.from(content);
  }, "the index about to be written");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of files) writeFileSync(join(dir, name), content);
  return index.manifest;
}

/**
 * Loads the index from `dir` and validates all of it. With `cataloguePath`, also checks that
 * the index was built from that catalogue file.
 */
export function loadIndex(dir: string, options: { cataloguePath?: string } = {}): Index {
  assertReadable(dir);
  const index = validateIndex((name) => {
    const path = join(dir, name);
    return existsSync(path) ? readBytes(path) : null;
  }, dir);
  if (options.cataloguePath !== undefined) {
    const actual = sha256(readBytes(options.cataloguePath));
    if (actual !== index.manifest.catalogue.sha256) {
      throw new Error(
        `${dir} was built from a catalogue with hash ${index.manifest.catalogue.sha256}, ` +
          `but ${options.cataloguePath} has hash ${actual}. Rebuild the index.`,
      );
    }
  }
  return index;
}

function validateIndex(read: (name: string) => Buffer | null, where: string): Index {
  const fail = (problem: string): never => {
    throw new Error(`invalid index at ${where}: ${problem}`);
  };
  const need = (name: string): Buffer => read(name) ?? fail(`${name} is missing`);

  const manifestSource = `${where}/manifest.json`;
  const parsedManifest = ManifestSchema.safeParse(parseJsonFrom(need("manifest.json").toString("utf8"), manifestSource));
  if (!parsedManifest.success) return fail(`manifest.json: ${z.prettifyError(parsedManifest.error)}`);
  const manifest = parsedManifest.data;
  if (manifest.format_version !== FORMAT_VERSION) {
    fail(`format version ${manifest.format_version} is not the supported version ${FORMAT_VERSION}`);
  }
  if (sealManifest(manifest).index_hash !== manifest.index_hash) fail("manifest.json does not match its own index hash");
  if (manifest.dimensions !== DIMENSIONS) fail(`manifest says ${manifest.dimensions} dimensions, this code reads ${DIMENSIONS}`);
  if (manifest.versions.join(",") !== VERSIONS.join(",")) fail(`manifest lists versions [${manifest.versions.join(", ")}]`);

  const expectedFiles = ["records.jsonl", ...VERSIONS.map(vectorsFile), "ledger.json", "report.json"];
  if (Object.keys(manifest.files).sort().join(",") !== [...expectedFiles].sort().join(",")) {
    fail(`manifest lists files [${Object.keys(manifest.files).join(", ")}], expected [${expectedFiles.join(", ")}]`);
  }
  const contents = new Map<string, Buffer>();
  for (const name of expectedFiles) {
    const content = need(name);
    const entry = manifest.files[name];
    if (entry === undefined || entry.bytes !== content.length || entry.sha256 !== sha256(content)) {
      fail(`hash mismatch: ${name} is not the file the manifest describes`);
    }
    contents.set(name, content);
  }
  const text = (name: string): string => (contents.get(name) ?? fail(`${name} is missing`)).toString("utf8");

  // Records: well formed, unique, and in the order the manifest and the vectors use.
  const records = text("records.jsonl")
    .split("\n")
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      const source = `records.jsonl line ${index + 1}`;
      const parsed = IndexRecordSchema.safeParse(parseJsonFrom(line, `${where}/${source}`));
      if (!parsed.success) return fail(`${source}: ${z.prettifyError(parsed.error)}`);
      return [parsed.data];
    });
  const ids = records.map((record) => record.game_id);
  if (new Set(ids).size !== ids.length) fail("records.jsonl holds a game id twice");
  if (ids.length !== manifest.game_ids.length || ids.some((id, row) => id !== manifest.game_ids[row])) {
    const row = ids.findIndex((id, position) => id !== manifest.game_ids[position]);
    fail(
      `misaligned ids: records.jsonl has ${ids.length} games and the manifest ${manifest.game_ids.length}` +
        (row === -1 ? "" : `; row ${row} is ${ids[row]} in the records and ${manifest.game_ids[row]} in the manifest`),
    );
  }
  for (const record of records) {
    if (record.canonical.game_id !== record.game_id) fail(`record ${record.game_id} wraps the canonical record of ${record.canonical.game_id}`);
    for (const version of VERSIONS) {
      const { text: versionText, text_sha256: hash, themes, mechanics } = record.versions[version];
      if (sha256(versionText) !== hash) fail(`record ${record.game_id}: the ${version} text does not match its hash`);
      for (const field of [themes, mechanics]) {
        for (const label of field?.labels ?? []) {
          if (!quoteIsVerbatim(record.canonical, label.source_field, label.quote)) {
            fail(`record ${record.game_id}: the quote for "${label.label}" in ${version} is not in its ${label.source_field}`);
          }
        }
      }
    }
  }

  // Vectors: the right number of the right size, every value finite.
  const vectors = Object.fromEntries(
    VERSIONS.map((version) => {
      const bytes = contents.get(vectorsFile(version)) ?? fail(`${vectorsFile(version)} is missing`);
      if (bytes.length !== records.length * BYTES_PER_VECTOR) {
        fail(
          `wrong dimension: ${vectorsFile(version)} holds ${bytes.length} bytes, ` +
            `expected ${records.length} vectors of ${DIMENSIONS} dimensions (${records.length * BYTES_PER_VECTOR} bytes)`,
        );
      }
      try {
        assertUsableVectors(bytes, records.length, vectorsFile(version));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      const floats = new Float32Array(records.length * DIMENSIONS);
      for (let position = 0; position < floats.length; position += 1) floats[position] = bytes.readFloatLE(position * 4);
      return [version, floats];
    }),
  ) as Record<Version, Float32Array>;

  return {
    manifest,
    records,
    vectors,
    // Not re-validated field by field: the hash check above shows these are the files the build wrote.
    ledger: parseJsonFrom(text("ledger.json"), `${where}/ledger.json`) as Ledger,
    report: parseJsonFrom(text("report.json"), `${where}/report.json`) as BuildReport,
  };
}
