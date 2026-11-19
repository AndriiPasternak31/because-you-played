/**
 * The one way the pipeline reads a file.
 *
 * `data/generation/` holds the hidden truth: what each game really is. It
 * exists for the generator and for scoring. Every read in the pipeline goes
 * through this module, which refuses a path inside that directory.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The directory name the pipeline may never read from, wherever it sits in a path. */
export const HIDDEN_DIRECTORY = "generation";

/** Returns the resolved path, or throws when it lies inside the hidden truth directory. */
export function assertReadable(path: string): string {
  const full = resolve(path);
  if (full.split(sep).includes(HIDDEN_DIRECTORY)) {
    throw new Error(`the pipeline may not read ${full}: a "${HIDDEN_DIRECTORY}" directory holds the hidden truth`);
  }
  return full;
}

export function readText(path: string): string {
  return readFileSync(assertReadable(path), "utf8");
}

export function readBytes(path: string): Buffer {
  return readFileSync(assertReadable(path));
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Parses JSON that was read from `source`; a failure names the source, which `JSON.parse` cannot. */
export function parseJsonFrom(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Reads a file of one JSON value per line. An error names the file and the line. */
export function readJsonLines<T>(path: string, parse: (value: unknown, source: string) => T): T[] {
  return readText(path)
    .split("\n")
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      const source = `${path} line ${index + 1}`;
      return [parse(parseJsonFrom(line, source), source)];
    });
}

/** JSON with object keys sorted at every depth, so that a hash does not depend on key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const SEAL = "seal_sha256";

/**
 * A stored response with its seal: the SHA-256 of everything else in it. The seal is set when
 * the pipeline stores a response, so a later edit of any part of the file no longer matches it.
 */
export function sealed<T extends object>(content: T): T & { seal_sha256: string } {
  const { [SEAL]: _previous, ...rest } = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  return { ...(rest as T), [SEAL]: sha256(stableJson(rest)) };
}

/** The content of a stored response without its seal. Throws, naming the file, when the two do not match. */
export function unseal(stored: unknown, source: string): unknown {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored) || typeof (stored as Record<string, unknown>)[SEAL] !== "string") {
    throw new Error(`${source} carries no seal, so nothing shows it is what the pipeline stored. Restore it from version control.`);
  }
  const { [SEAL]: seal, ...rest } = stored as Record<string, unknown>;
  if (sha256(stableJson(rest)) !== seal) {
    throw new Error(
      `${source} does not match its seal: it was changed after the pipeline stored it. ` +
        "Restore it from version control, or delete it and re-run with --live.",
    );
  }
  return rest;
}
