/**
 * The release gate: the owner's pass marks applied to the measured numbers.
 *
 * No pass mark lives here. `ThresholdsSchema` is only the shape of eval/thresholds.json;
 * every value comes from that file. The same function answers the console's what-if
 * sliders, which pass other marks in and write nothing.
 *
 * Readings chosen where eval/refs/evaluation-plan.md leaves a detail open, each the stricter one:
 *   - The enrichment marks apply to a version that asserts labels. `raw` asserts none, so only
 *     the matching marks apply to it.
 *   - A version's pairwise accuracy, for its mark and for the ship rule, is the lower of its
 *     pooled figure and its mean per game.
 *   - A rate over nothing (no label asserted, no pair to compare) fails its mark.
 *   - "The best" is the best among the versions that pass, so a passing version always ships.
 *   - "Simplest" is the ladder's order, not the ledger's cost.
 */
import { z } from "zod";
import { VERSIONS, type Version } from "../src/pipeline/versions.ts";

export const ThresholdsSchema = z.strictObject({
  decided_on: z.string(),
  enrichment: z.strictObject({
    min_precision: z.number(),
    min_recovery: z.number(),
    min_recovery_without_tags: z.number(),
    max_missed_abstentions: z.number(),
    max_invalid_quotes: z.number(),
  }),
  matching: z.strictObject({
    min_pairwise_accuracy: z.number(),
    max_wrongly_shown_on_check_anchors: z.number(),
  }),
  ship_rule: z.strictObject({
    compare: z.literal("ladder"),
    ship: z.literal("simplest_within_margin_of_best"),
    margin: z.number().nonnegative(),
  }),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export function parseThresholds(value: unknown, source: string): Thresholds {
  const parsed = ThresholdsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${source} is not a pass-mark file this evaluation understands, so no mark was applied: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The numbers the gate reads for one version. A null rate is a rate over nothing. */
export interface Measured {
  /** Null for a version that asserts no labels. */
  enrichment: {
    precision: number | null;
    recovery: number | null;
    recovery_without_tags: number | null;
    missed_abstentions: number;
    invalid_quotes: number;
  } | null;
  matching: {
    /** The lower of the pooled figure and the mean per game. */
    pairwise_accuracy: number | null;
    wrongly_shown: number;
  };
}

export const MARKS = [
  { id: "enrichment.min_precision", group: "enrichment", key: "min_precision", measure: "precision", direction: "min", label: "Precision" },
  { id: "enrichment.min_recovery", group: "enrichment", key: "min_recovery", measure: "recovery", direction: "min", label: "Recovery" },
  {
    id: "enrichment.min_recovery_without_tags",
    group: "enrichment",
    key: "min_recovery_without_tags",
    measure: "recovery_without_tags",
    direction: "min",
    label: "Recovery without tags",
  },
  {
    id: "enrichment.max_missed_abstentions",
    group: "enrichment",
    key: "max_missed_abstentions",
    measure: "missed_abstentions",
    direction: "max",
    label: "Missed abstentions",
  },
  { id: "enrichment.max_invalid_quotes", group: "enrichment", key: "max_invalid_quotes", measure: "invalid_quotes", direction: "max", label: "Invalid quotes" },
  { id: "matching.min_pairwise_accuracy", group: "matching", key: "min_pairwise_accuracy", measure: "pairwise_accuracy", direction: "min", label: "Pairwise accuracy" },
  {
    id: "matching.max_wrongly_shown_on_check_anchors",
    group: "matching",
    key: "max_wrongly_shown_on_check_anchors",
    measure: "wrongly_shown",
    direction: "max",
    label: "Wrongly shown on the check games",
  },
] as const;
export type MarkId = (typeof MARKS)[number]["id"];

export interface MarkResult {
  mark: MarkId;
  label: string;
  direction: "min" | "max";
  threshold: number;
  /** Null when the mark does not apply to this version, or when there was nothing to measure. */
  measured: number | null;
  applies: boolean;
  pass: boolean;
}

export interface Decision {
  versions: Record<Version, { passed: boolean; marks: MarkResult[]; failed_marks: MarkId[]; pairwise_accuracy: number | null }>;
  /** The best pairwise accuracy among the versions that passed. */
  best: { version: Version; pairwise_accuracy: number } | null;
  margin: number;
  passed: boolean;
  ships: Version | null;
  reason: string;
}

function threshold(thresholds: Thresholds, mark: (typeof MARKS)[number]): number {
  return mark.group === "enrichment" ? thresholds.enrichment[mark.key] : thresholds.matching[mark.key];
}

function measuredValue(measured: Measured, mark: (typeof MARKS)[number]): { applies: boolean; value: number | null } {
  if (mark.group === "enrichment") {
    return measured.enrichment === null ? { applies: false, value: null } : { applies: true, value: measured.enrichment[mark.measure] };
  }
  return { applies: true, value: measured.matching[mark.measure] };
}

export function decide(measured: Record<Version, Measured>, thresholds: Thresholds): Decision {
  const versions = {} as Decision["versions"];
  for (const version of VERSIONS) {
    const marks: MarkResult[] = MARKS.map((mark) => {
      const limit = threshold(thresholds, mark);
      const { applies, value } = measuredValue(measured[version], mark);
      const pass = !applies || (value !== null && (mark.direction === "min" ? value >= limit : value <= limit));
      return { mark: mark.id, label: mark.label, direction: mark.direction, threshold: limit, measured: value, applies, pass };
    });
    const failed = marks.filter((mark) => !mark.pass).map((mark) => mark.mark);
    versions[version] = { passed: failed.length === 0, marks, failed_marks: failed, pairwise_accuracy: measured[version].matching.pairwise_accuracy };
  }

  const passing = VERSIONS.filter((version) => versions[version].passed);
  const { margin } = thresholds.ship_rule;
  let best: Decision["best"] = null;
  for (const version of passing) {
    const accuracy = versions[version].pairwise_accuracy;
    if (accuracy !== null && (best === null || accuracy > best.pairwise_accuracy)) best = { version, pairwise_accuracy: accuracy };
  }
  if (best === null) {
    const why = VERSIONS.map((version) => `${version} fails ${versions[version].failed_marks.join(", ")}`).join("; ");
    return { versions, best, margin, passed: false, ships: null, reason: `No version passes its marks, so nothing may be served. ${why}.` };
  }
  const top = best;
  // The ladder is in order of cost, so the first passing version within the margin is the simplest one.
  const ships = passing.find((version) => (versions[version].pairwise_accuracy ?? Number.NEGATIVE_INFINITY) >= top.pairwise_accuracy - margin) ?? top.version;
  const failing = VERSIONS.filter((version) => !versions[version].passed);
  const reason =
    `${ships} ships: it is the simplest version that passes its marks and is within ${margin} of the best passing pairwise accuracy ` +
    `(${top.version}, ${top.pairwise_accuracy}).` +
    (failing.length === 0 ? "" : ` Not passing: ${failing.map((version) => `${version} (${versions[version].failed_marks.join(", ")})`).join("; ")}.`);
  return { versions, best, margin, passed: true, ships, reason };
}
