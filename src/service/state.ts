/**
 * Everything the service loads before it answers anything, and every reason it refuses to start.
 *
 * It refuses when the index is invalid, when the offerings cannot be read, and when there is
 * no passing verdict for exactly this index, these pass marks and this serving rule.
 * It never reads the hidden truth: the paths below are all it opens.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MeasuredSchema, decide, parseThresholds, type Measured } from "../../eval/gate.ts";
import { loadIndex, type Index } from "../pipeline/index-store.ts";
import { VERSIONS, type Version } from "../pipeline/versions.ts";
import { loadOfferings, type Offerings } from "./offerings.ts";
import { FLOOR_RULE, buildState, type ServingState } from "./recommend.ts";
import { readVerdict, sha256OfFile, type Verdict } from "./verdict.ts";

export interface ServicePaths {
  indexDir: string;
  cataloguePath: string;
  offeringsPath: string;
  verdictPath: string;
  thresholdsPath: string;
}

export const DEFAULT_PATHS: ServicePaths = {
  indexDir: "data/index",
  cataloguePath: "data/catalogue.raw.jsonl",
  offeringsPath: "data/offerings.jsonl",
  verdictPath: "eval/results/verdict.json",
  thresholdsPath: "eval/thresholds.json",
};

export interface Service {
  /** The version the evaluation chose. Requests are answered from this one. */
  served: ServingState;
  /** All four versions, for the console's comparison. Only `served` answers a recommendation request. */
  byVersion: Record<Version, ServingState>;
  index: Index;
  offerings: Offerings;
  verdict: Verdict;
  /** The evaluation report and the committed pass marks, as read at the start. Shown by the console, never recomputed here. */
  report: unknown;
  thresholds: unknown;
  /** Offerings that name a game the index does not hold. They can never be recommended. */
  offeringsForUnknownGames: number;
}

/** The part of the evaluation report the service checks its verdict against. The rest it only passes to the console. */
const VersionKeys = z.enum(VERSIONS);
const ReportForServingSchema = z.object({
  index_hash: z.string(),
  thresholds_sha256: z.string(),
  measured: z.record(VersionKeys, MeasuredSchema),
  decision: z.object({
    passed: z.boolean(),
    ships: VersionKeys.nullable(),
    versions: z.record(VersionKeys, z.object({ passed: z.boolean() })),
  }),
});

/** The refusal to serve. Its message is the reason, in words. */
export class NotServing extends Error {}

export function loadService(paths: ServicePaths = DEFAULT_PATHS): Service {
  let index: Index;
  try {
    index = loadIndex(paths.indexDir, { cataloguePath: paths.cataloguePath });
  } catch (error) {
    throw new NotServing(`not serving: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const offerings = loadOfferings(paths.offeringsPath);

  let verdict: Verdict;
  try {
    verdict = readVerdict(paths.verdictPath);
  } catch (error) {
    throw new NotServing(`not serving: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const refuse = (why: string): never => {
    throw new NotServing(`not serving: the verdict at ${paths.verdictPath} ${why}`);
  };
  if (verdict.index_hash !== index.manifest.index_hash) {
    refuse(`is for index ${verdict.index_hash}, and the index at ${paths.indexDir} is ${index.manifest.index_hash}. Run "npm run eval" on this index.`);
  }
  const thresholdsHash = sha256OfFile(paths.thresholdsPath);
  if (verdict.thresholds_sha256 !== thresholdsHash) {
    refuse(`was reached with other pass marks than ${paths.thresholdsPath} now holds. Run "npm run eval" again.`);
  }
  if (!verdict.passed || verdict.ships === null) refuse(`does not pass: ${verdict.reason}`);
  const ships = verdict.ships as Version;
  if (verdict.versions[ships]?.passed !== true) refuse(`ships ${ships}, which it also records as not passing`);

  const byVersion = Object.fromEntries(VERSIONS.map((version) => [version, buildState(index, offerings, version)])) as Record<Version, ServingState>;
  if (verdict.serving.floor_rule !== FLOOR_RULE.id || verdict.serving.floors[ships] !== byVersion[ships].floor) {
    refuse(
      `judged the serving rule ${verdict.serving.floor_rule} with floor ${String(verdict.serving.floors[ships])}, ` +
        `and this service would apply ${FLOOR_RULE.id} with floor ${byVersion[ships].floor}. Run "npm run eval" again.`,
    );
  }
  const reportPath = join(dirname(paths.verdictPath), verdict.report.path);
  let reportHash: string;
  try {
    reportHash = sha256OfFile(reportPath);
  } catch {
    return refuse(`names the report ${reportPath}, which is missing`);
  }
  if (reportHash !== verdict.report.sha256) refuse(`does not match its report ${reportPath}. Run "npm run eval" again.`);

  // The same bytes are not the same decision. The verdict has to say what the report says, and the report's
  // decision has to be what the gate gives for the report's own numbers under the committed pass marks.
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  const thresholds = JSON.parse(readFileSync(paths.thresholdsPath, "utf8")) as unknown;
  const parsed = ReportForServingSchema.safeParse(report);
  if (!parsed.success) return refuse(`names the report ${reportPath}, which does not hold a decision the service can check: ${z.prettifyError(parsed.error)}`);
  const judged = parsed.data;
  if (judged.index_hash !== verdict.index_hash || judged.thresholds_sha256 !== verdict.thresholds_sha256) {
    refuse(`and its report ${reportPath} are for different indexes or pass marks. Run "npm run eval" again.`);
  }
  const regated = decide(judged.measured as Record<Version, Measured>, parseThresholds(thresholds, paths.thresholdsPath));
  for (const [what, decision] of [
    [`its report ${reportPath} chose`, judged.decision],
    [`the gate, applied to the numbers in ${reportPath} with the pass marks in ${paths.thresholdsPath}, chooses`, regated],
  ] as const) {
    const chose = decision.ships === null ? "nothing" : decision.ships;
    if (decision.ships !== verdict.ships || decision.passed !== verdict.passed) {
      refuse(`ships ${String(verdict.ships)}, and ${what} ${chose}. A verdict is written by "npm run eval", never by hand: run it again.`);
    }
    for (const version of VERSIONS) {
      if (decision.versions[version]?.passed !== verdict.versions[version]?.passed) {
        refuse(
          `records ${version} as ${verdict.versions[version]?.passed === true ? "passing" : "not passing"}, and ${what.replace(/ (chose|chooses)$/, "")} ` +
            `records it as ${decision.versions[version]?.passed === true ? "passing" : "not passing"}. A verdict is written by "npm run eval", never by hand: run it again.`,
        );
      }
    }
  }

  const known = new Set(index.manifest.game_ids);
  let unknown = 0;
  for (const statuses of offerings.statusByBrand.values()) for (const gameId of statuses.keys()) if (!known.has(gameId)) unknown += 1;

  return {
    served: byVersion[ships],
    byVersion,
    index,
    offerings,
    verdict,
    report,
    thresholds,
    offeringsForUnknownGames: unknown,
  };
}
