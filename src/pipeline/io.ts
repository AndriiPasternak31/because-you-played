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
