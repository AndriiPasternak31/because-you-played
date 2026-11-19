/**
 * The verdict: the evaluation's decision for one index, as the service reads it.
 *
 * The evaluation writes it; the service only reads it. It names the index it was reached on,
 * the pass marks it was reached with, and the serving rule it judged, so that a verdict for
 * anything else is refused.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { VERSIONS } from "../pipeline/versions.ts";

export const VERDICT_FORMAT = 1;

const VersionEnum = z.enum(VERSIONS);

export const VerdictSchema = z.strictObject({
  format_version: z.literal(VERDICT_FORMAT),
  /** The index this verdict was reached on. */
  index_hash: z.string().min(1),
  /** SHA-256 of the pass-mark file the verdict was reached with. */
  thresholds_sha256: z.string().min(1),
  prompt_version: z.string(),
  /** The full report this verdict summarises, relative to the verdict file, and its SHA-256. */
  report: z.strictObject({ path: z.string(), sha256: z.string() }),
  /** The serving rule that was judged: the floor rule and the floor it gives each version. */
  serving: z.strictObject({ floor_rule: z.string(), floors: z.record(VersionEnum, z.number()) }),
  /** True when at least one version passed every mark that applies to it. */
  passed: z.boolean(),
  /** The version the ship rule chose. Null when none passed. */
  ships: VersionEnum.nullable(),
  reason: z.string(),
  versions: z.record(VersionEnum, z.strictObject({ passed: z.boolean(), failed_marks: z.array(z.string()) })),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Reads a verdict file. A missing or malformed file is an error that says so. */
export function readVerdict(path: string): Verdict {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`there is no evaluation verdict at ${path}. Run "npm run eval" first: the service serves only an index that has passed.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`the verdict at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = VerdictSchema.safeParse(value);
  if (!parsed.success) throw new Error(`the verdict at ${path} is not a verdict: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
