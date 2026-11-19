/**
 * Availability: the status of each game on each brand, read from the offerings file.
 *
 * This is the only source of availability. Nothing a model wrote is read here,
 * and the index holds no status at all. Only `live` is eligible.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { OfferingSchema, type OfferingStatus } from "../dataset/model.ts";

export interface Offerings {
  /** Brand names, sorted. */
  brands: string[];
  /** brand -> game id -> status. A game with no row for a brand is not offered there. */
  statusByBrand: ReadonlyMap<string, ReadonlyMap<string, OfferingStatus>>;
  rows: number;
}

/** Parses the offerings file. A malformed line, a repeated game and brand, or an empty file is an error that names its place. */
export function parseOfferings(text: string, source: string): Offerings {
  const statusByBrand = new Map<string, Map<string, OfferingStatus>>();
  let rows = 0;
  text.split("\n").forEach((line, index) => {
    if (line.length === 0) return;
    const where = `${source} line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const parsed = OfferingSchema.safeParse(value);
    if (!parsed.success) throw new Error(`${where} is not an offering: ${z.prettifyError(parsed.error)}`);
    const { brand, game_id: gameId, status } = parsed.data;
    const forBrand = statusByBrand.get(brand) ?? new Map<string, OfferingStatus>();
    if (forBrand.has(gameId)) throw new Error(`${where} repeats ${gameId} on ${brand}, so its status there is ambiguous`);
    forBrand.set(gameId, status);
    statusByBrand.set(brand, forBrand);
    rows += 1;
  });
  if (rows === 0) throw new Error(`${source} holds no offering, so nothing could be served on any brand`);
  return { brands: [...statusByBrand.keys()].sort(), statusByBrand, rows };
}

export function loadOfferings(path: string): Offerings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`the offerings file ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseOfferings(text, path);
}

/** Live games per brand. The largest brand is the one with the most; a tie goes to the first name in order. */
export function liveCounts(offerings: Offerings): { brand: string; live: number }[] {
  return offerings.brands.map((brand) => ({
    brand,
    live: [...(offerings.statusByBrand.get(brand)?.values() ?? [])].filter((status) => status === "live").length,
  }));
}

export function largestBrand(offerings: Offerings): string {
  const [first, ...rest] = liveCounts(offerings);
  if (first === undefined) throw new Error("no brand in the offerings");
  return rest.reduce((best, entry) => (entry.live > best.live ? entry : best), first).brand;
}
