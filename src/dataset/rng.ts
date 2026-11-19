/**
 * Seeded randomness. Every stream is named, so a draw for one slot never
 * depends on how many other slots exist: slot 5 is planned and degraded the
 * same way in a 14-game pilot and in a 100-game catalogue.
 */
import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly (readonly [T, number])[]): T;
}

export function seededRng(...name: (string | number)[]): Rng {
  let state = Number.parseInt(sha256Hex(name.join("|")).slice(0, 8), 16);
  // mulberry32
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => at(items, int(items.length)),
    weighted: (items) => {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [item, weight] of items) {
        roll -= weight;
        if (roll < 0) return item;
      }
      return at(items, items.length - 1)[0];
    },
  };
}

/** Indexed access that fails loudly instead of yielding undefined. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`index ${index} is out of range for a list of ${items.length}`);
  }
  return item;
}
