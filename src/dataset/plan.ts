/**
 * The plan: what each catalogue slot is, before any text is written.
 *
 * Slots are allocated to test cases first, not to realism targets. The first
 * slots are hand-allocated scenarios that between them cover every kind of
 * mess; any further slots are drawn from seeded distributions. A slot's plan
 * depends only on the seed and on earlier slots, so the pilot is a strict
 * prefix of the full catalogue and its committed model responses stay valid.
 */
import type { Facts, OfferingStatus, VolatilityBand } from "./model.ts";
import { at, seededRng, type Rng } from "./rng.ts";
import { WIN_SYSTEMS, type Mechanic, type Theme, type WinSystem } from "./vocabulary.ts";

export const DEFAULT_SEED = "catalogue-v1";

// ---------------------------------------------------------------------------
// Fictional studios. Gaps and formats are properties of the studio, because
// real missingness is structural: a whole field is absent from a source.
// ---------------------------------------------------------------------------

export type OmittedField = "description" | "themes" | "volatility" | "max_win" | "bets" | "release_date";

export interface Studio {
  id: string;
  name: string;
  /** Prefix of the supplier game ids. */
  code: string;
  weight: number;
  omits: readonly OmittedField[];
  suppliesFamily: boolean;
  descriptionLocale: "en" | "de";
  markupDescriptions: boolean;
  boilerplateProne: boolean;
  /** House style of the studio's copy, passed to the writing model. */
  voice: string;
  category: string;
  tagStyle: "title" | "kebab" | "lower";
  rtpStyle: "percent" | "decimal" | "fraction" | "comma";
  volatilityStyle: "label" | "int6" | "of5" | "upper" | "german";
  dateStyle: "iso" | "dmy" | "month_year";
  maxWinStyle: "number" | "x_prefix" | "comma_x";
  betStyle: "number" | "string" | "array";
  gridStyle: "x" | "dash";
}

/** The reference conventions; a studio that differs produces a format variant. */
const REFERENCE_FORMATS = {
  tagStyle: "title",
  rtpStyle: "percent",
  volatilityStyle: "label",
  dateStyle: "iso",
  maxWinStyle: "number",
  betStyle: "number",
  gridStyle: "x",
} as const;

export const STUDIOS = [
  {
    id: "okkelund",
    name: "Okkelund Studios",
    code: "okk",
    weight: 30,
    omits: [],
    suppliesFamily: true,
    descriptionLocale: "en",
    markupDescriptions: false,
    boilerplateProne: false,
    voice: "story-led: open with the setting or a character, then walk through what the game does",
    category: "Video Slots",
    ...REFERENCE_FORMATS,
  },
  {
    id: "quillfern",
    name: "Quillfern Interactive",
    code: "qfi",
    weight: 22,
    omits: ["themes"],
    suppliesFamily: false,
    descriptionLocale: "en",
    markupDescriptions: true,
    boilerplateProne: false,
    voice: "feature-led: lead with what the game does in confident product language, then the setting",
    category: "Video Slot",
    tagStyle: "title",
    rtpStyle: "percent",
    volatilityStyle: "of5",
    dateStyle: "dmy",
    maxWinStyle: "comma_x",
    betStyle: "array",
    gridStyle: "x",
  },
  {
    id: "wexomar",
    name: "Wexomar Gaming",
    code: "wex",
    weight: 18,
    omits: ["description", "max_win"],
    suppliesFamily: false,
    descriptionLocale: "en",
    markupDescriptions: false,
    boilerplateProne: false,
    voice: "plain and technical: short declarative sentences and no hype",
    category: "videoslot",
    tagStyle: "kebab",
    rtpStyle: "decimal",
    volatilityStyle: "int6",
    dateStyle: "iso",
    maxWinStyle: "number",
    betStyle: "string",
    gridStyle: "x",
  },
  {
    id: "ulvenskar",
    name: "Ulvenskar Games",
    code: "ulv",
    weight: 14,
    omits: ["release_date"],
    suppliesFamily: true,
    descriptionLocale: "en",
    markupDescriptions: false,
    boilerplateProne: true,
    voice: "high-energy promotional copy that addresses the player in the second person",
    category: "Slots",
    tagStyle: "title",
    rtpStyle: "percent",
    volatilityStyle: "upper",
    dateStyle: "iso",
    maxWinStyle: "x_prefix",
    betStyle: "number",
    gridStyle: "x",
  },
  {
    id: "thrannock",
    name: "Thrannock Play",
    code: "thr",
    weight: 10,
    omits: ["volatility", "bets"],
    suppliesFamily: false,
    descriptionLocale: "en",
    markupDescriptions: false,
    boilerplateProne: false,
    voice: "dry and compact: understated and a little old-fashioned",
    category: "slot",
    tagStyle: "lower",
    rtpStyle: "fraction",
    volatilityStyle: "label",
    dateStyle: "month_year",
    maxWinStyle: "number",
    betStyle: "number",
    gridStyle: "dash",
  },
  {
    id: "drachtweil",
    name: "Drachtweil Spiele",
    code: "drw",
    weight: 6,
    omits: [],
    suppliesFamily: false,
    descriptionLocale: "de",
    markupDescriptions: false,
    boilerplateProne: false,
    voice: "measured and descriptive, as if translated from a German original",
    category: "Slots",
    tagStyle: "title",
    rtpStyle: "comma",
    volatilityStyle: "german",
    dateStyle: "dmy",
    maxWinStyle: "number",
    betStyle: "number",
    gridStyle: "x",
  },
] as const satisfies readonly Studio[];

export type StudioId = (typeof STUDIOS)[number]["id"];

export function studioById(id: StudioId): Studio {
  const studio = STUDIOS.find((candidate) => candidate.id === id);
  if (studio === undefined) throw new Error(`unknown studio "${id}"`);
  return studio;
}

export function usesReferenceFormats(studio: Studio): boolean {
  return (Object.keys(REFERENCE_FORMATS) as (keyof typeof REFERENCE_FORMATS)[]).every(
    (key) => studio[key] === REFERENCE_FORMATS[key],
  );
}

// ---------------------------------------------------------------------------
// Fictional brands. One jurisdiction per brand; the third is kept small on
// purpose so that a "nothing eligible is good enough" case can exist.
// ---------------------------------------------------------------------------

export const BRANDS = [
  { id: "tavrenmoor", name: "Tavrenmoor Casino", jurisdiction: "GB" },
  { id: "copperjay", name: "Copperjay Spins", jurisdiction: "ON" },
  { id: "quarrowby", name: "Quarrowby Bingo", jurisdiction: "NJ" },
] as const;

export type BrandId = (typeof BRANDS)[number]["id"];

const SMALL_BRAND: BrandId = "quarrowby";
const SMALL_BRAND_MAX_LIVE = 8;

// ---------------------------------------------------------------------------
// Slot plan
// ---------------------------------------------------------------------------

export type VariantKind = "sequel" | "deluxe" | "seasonal";

export type Relation =
  | { kind: "none" }
  | { kind: "variant_of"; parent: number; variant: VariantKind }
  | { kind: "same_name_as"; twin: number };

export type DescriptionState = "full" | "terse" | "boilerplate" | "missing";
export type TagState = "clean" | "drift" | "removed" | "one_dropped" | "conflict";
export type TitleDecoration = "none" | "trademark" | "uppercase";
/** "thematic": the title names the theme. "opaque": the title hints at nothing. */
export type TitleStyle = "thematic" | "opaque";

export interface SlotMess {
  description: DescriptionState;
  tags: TagState;
  nonAttributes: boolean;
  titleDecoration: TitleDecoration;
  injection: boolean;
  nearEmpty: boolean;
  duplicateRow: boolean;
}

export interface SlotPlan {
  slot: number;
  scenario: string;
  studio: StudioId;
  themes: readonly Theme[];
  mechanics: readonly Mechanic[];
  relation: Relation;
  titleStyle: TitleStyle;
  mess: SlotMess;
  facts: Facts;
  /** Whether the description states volatility and maximum win. Most real copy does not. */
  copyMentionsFacts: boolean;
  offerings: readonly (readonly [BrandId, OfferingStatus])[];
}

const NO_MESS: SlotMess = {
  description: "full",
  tags: "clean",
  nonAttributes: false,
  titleDecoration: "none",
  injection: false,
  nearEmpty: false,
  duplicateRow: false,
};

interface Scenario {
  scenario: string;
  studio: StudioId;
  themes: readonly Theme[];
  mechanics: readonly Mechanic[];
  relation?: Relation;
  titleStyle?: TitleStyle;
  mess?: Partial<SlotMess>;
  rtpBuilds?: number;
  offerings: readonly (readonly [BrandId, OfferingStatus])[];
}

/**
 * Hand-allocated slots. Together they hold one of everything the catalogue
 * has to contain: clean controls, two families (one supplied by the feed, one
 * not), a same-name pair from different studios, a true duplicate, a
 * near-empty record, an injected instruction, and each description and tag
 * defect. Themes and mechanics overlap on purpose: several games share
 * hold-and-respin across different themes, and two share a theme with
 * different gameplay.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    scenario: "clean_control",
    studio: "okkelund",
    themes: ["ancient_egypt", "adventure"],
    mechanics: ["paylines", "free_spins", "expanding_wilds"],
    rtpBuilds: 1,
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"], ["quarrowby", "live"]],
  },
  {
    scenario: "family_original",
    studio: "okkelund",
    themes: ["ocean_fishing"],
    mechanics: ["paylines", "free_spins", "pick_bonus"],
    mess: { titleDecoration: "trademark", nonAttributes: true },
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"]],
  },
  {
    scenario: "family_sequel",
    studio: "okkelund",
    themes: ["ocean_fishing"],
    mechanics: ["ways", "free_spins", "multipliers", "hold_and_respin"],
    relation: { kind: "variant_of", parent: 1, variant: "sequel" },
    mess: { tags: "drift" },
    offerings: [["tavrenmoor", "live"], ["copperjay", "coming_soon"]],
  },
  {
    scenario: "same_name_first",
    studio: "wexomar",
    themes: ["mythology"],
    mechanics: ["ways", "cascading_reels", "multipliers"],
    titleStyle: "opaque",
    offerings: [["tavrenmoor", "live"], ["quarrowby", "live"]],
  },
  {
    scenario: "same_name_second",
    studio: "quillfern",
    themes: ["sci_fi"],
    mechanics: ["cluster_pays", "sticky_wilds", "free_spins"],
    relation: { kind: "same_name_as", twin: 3 },
    titleStyle: "opaque",
    mess: { tags: "removed" },
    rtpBuilds: 3,
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"]],
  },
  {
    scenario: "true_duplicate",
    studio: "okkelund",
    themes: ["horror"],
    mechanics: ["paylines", "sticky_wilds", "free_spins"],
    mess: { duplicateRow: true },
    rtpBuilds: 1,
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"], ["quarrowby", "live"]],
  },
  {
    scenario: "near_empty",
    studio: "thrannock",
    themes: ["classic_fruit"],
    mechanics: ["paylines", "multipliers"],
    titleStyle: "opaque",
    mess: { nearEmpty: true },
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"]],
  },
  {
    scenario: "injected_instruction",
    studio: "ulvenskar",
    themes: ["western"],
    mechanics: ["paylines", "hold_and_respin", "pick_bonus"],
    mess: { injection: true },
    offerings: [["tavrenmoor", "live"]],
  },
  {
    scenario: "non_english_interacting",
    studio: "drachtweil",
    themes: ["animals"],
    mechanics: ["cluster_pays", "cascading_reels", "multipliers"],
    mess: { tags: "drift", nonAttributes: true },
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"]],
  },
  {
    scenario: "boilerplate_description",
    studio: "ulvenskar",
    themes: ["ancient_egypt"],
    mechanics: ["paylines", "hold_and_respin", "progressive_jackpot"],
    mess: { description: "boilerplate" },
    offerings: [["tavrenmoor", "withdrawn"], ["copperjay", "live"]],
  },
  {
    scenario: "tag_conflicts_description",
    studio: "okkelund",
    themes: ["east_asian"],
    mechanics: ["cluster_pays", "cascading_reels", "multipliers"],
    mess: { tags: "conflict" },
    rtpBuilds: 1,
    offerings: [["tavrenmoor", "live"], ["copperjay", "disabled"]],
  },
  {
    scenario: "tag_dropped_but_inferable",
    studio: "quillfern",
    themes: ["fantasy"],
    mechanics: ["ways", "free_spins", "mystery_symbols"],
    mess: { tags: "one_dropped" },
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"], ["quarrowby", "live"]],
  },
  {
    scenario: "terse_unsupplied_family",
    studio: "thrannock",
    themes: ["classic_fruit"],
    mechanics: ["paylines", "multipliers", "free_spins"],
    relation: { kind: "variant_of", parent: 6, variant: "deluxe" },
    titleStyle: "opaque",
    mess: { description: "terse" },
    offerings: [["tavrenmoor", "withdrawn"], ["copperjay", "withdrawn"]],
  },
  {
    scenario: "clean_control",
    studio: "okkelund",
    themes: ["animals"],
    mechanics: ["ways", "hold_and_respin", "free_spins"],
    rtpBuilds: 1,
    offerings: [["tavrenmoor", "live"], ["copperjay", "live"], ["quarrowby", "live"]],
  },
];

/** The smallest count that contains every hand-allocated scenario. */
export const SCENARIO_COUNT = SCENARIOS.length;

export function buildPlan(count: number, seed: string): SlotPlan[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
  const plan: SlotPlan[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const scenario = SCENARIOS[slot];
    plan.push(scenario === undefined ? drawSlot(seed, slot, plan) : scenarioSlot(seed, slot, scenario));
  }
  for (const slotPlan of plan) checkSlot(slotPlan, plan);
  return plan;
}

function scenarioSlot(seed: string, slot: number, scenario: Scenario): SlotPlan {
  return {
    slot,
    scenario: scenario.scenario,
    studio: scenario.studio,
    themes: scenario.themes,
    mechanics: scenario.mechanics,
    relation: scenario.relation ?? { kind: "none" },
    titleStyle: scenario.titleStyle ?? "thematic",
    mess: { ...NO_MESS, ...scenario.mess },
    facts: drawFacts(seededRng(seed, "facts", slot), scenario.mechanics, scenario.rtpBuilds),
    copyMentionsFacts: drawCopyMentionsFacts(seed, slot),
    offerings: scenario.offerings,
  };
}

// ---------------------------------------------------------------------------
// Drawn slots (everything after the scenarios)
// ---------------------------------------------------------------------------

const MAX_SAME_NAME_PAIRS = 3;
const VARIANT_KINDS: readonly VariantKind[] = ["sequel", "deluxe", "seasonal"];

const THEME_WEIGHTS: readonly (readonly [Theme, number])[] = [
  ["fantasy", 12],
  ["animals", 12],
  ["adventure", 10],
  ["mythology", 10],
  ["classic_fruit", 10],
  ["east_asian", 9],
  ["ancient_egypt", 8],
  ["irish_luck", 7],
  ["ocean_fishing", 7],
  ["horror", 6],
  ["western", 5],
  ["sci_fi", 4],
];

const WIN_SYSTEM_WEIGHTS: readonly (readonly [WinSystem, number])[] = [
  ["paylines", 50],
  ["ways", 30],
  ["cluster_pays", 20],
];

const FEATURE_WEIGHTS: readonly (readonly [Mechanic, number])[] = [
  ["free_spins", 30],
  ["multipliers", 18],
  ["cascading_reels", 10],
  ["hold_and_respin", 10],
  ["expanding_wilds", 9],
  ["sticky_wilds", 8],
  ["pick_bonus", 6],
  ["mystery_symbols", 5],
  ["progressive_jackpot", 4],
];

function drawSlot(seed: string, slot: number, earlier: readonly SlotPlan[]): SlotPlan {
  const rng = seededRng(seed, "plan", slot);
  const studioId = rng.weighted(STUDIOS.map((candidate) => [candidate.id, candidate.weight] as const));
  const studio = studioById(studioId);
  const relation = drawRelation(rng, studioId, earlier);

  let themes: readonly Theme[];
  let mechanics: readonly Mechanic[];
  let titleStyle: TitleStyle;
  if (relation.kind === "variant_of") {
    const parent = at(earlier, relation.parent);
    themes = parent.themes;
    titleStyle = parent.titleStyle;
    const unused = FEATURE_WEIGHTS.filter(([feature]) => !parent.mechanics.includes(feature));
    mechanics =
      relation.variant === "seasonal" || unused.length === 0
        ? parent.mechanics
        : [...parent.mechanics, rng.weighted(unused)];
  } else {
    const twinThemes = relation.kind === "same_name_as" ? at(earlier, relation.twin).themes : [];
    themes = drawWithoutReplacement(
      rng,
      THEME_WEIGHTS.filter(([theme]) => !twinThemes.includes(theme)),
      rng.chance(0.3) ? 2 : 1,
    );
    mechanics = [
      rng.weighted(WIN_SYSTEM_WEIGHTS),
      ...drawWithoutReplacement(rng, FEATURE_WEIGHTS, rng.chance(0.4) ? 3 : 2),
    ];
    titleStyle = relation.kind === "same_name_as" || rng.chance(0.12) ? "opaque" : "thematic";
  }

  const nearEmpty = relation.kind === "none" && rng.chance(0.03);
  const description = rng.weighted<DescriptionState>(
    studio.boilerplateProne
      ? [["full", 25], ["missing", 20], ["boilerplate", 45], ["terse", 10]]
      : [["full", 40], ["missing", 24], ["boilerplate", 26], ["terse", 10]],
  );
  let tags = rng.weighted<TagState>([
    ["clean", 35],
    ["drift", 30],
    ["removed", 15],
    ["one_dropped", 12],
    ["conflict", 8],
  ]);
  if (needsFullDescription(tags) && !hasFullDescription(description, nearEmpty, studio)) tags = "drift";

  return {
    slot,
    scenario: "drawn",
    studio: studioId,
    themes,
    mechanics,
    relation,
    titleStyle,
    mess: {
      description,
      tags,
      nonAttributes: rng.chance(0.22),
      titleDecoration: rng.weighted<TitleDecoration>([["none", 86], ["trademark", 9], ["uppercase", 5]]),
      injection: false,
      nearEmpty,
      duplicateRow: rng.chance(0.06),
    },
    facts: drawFacts(seededRng(seed, "facts", slot), mechanics, undefined),
    copyMentionsFacts: drawCopyMentionsFacts(seed, slot),
    offerings: drawOfferings(rng, earlier),
  };
}

function drawRelation(rng: Rng, studio: StudioId, earlier: readonly SlotPlan[]): Relation {
  const roll = rng.next();
  if (roll < 0.09) {
    const roots = earlier.filter(
      (candidate) =>
        candidate.studio === studio &&
        candidate.relation.kind === "none" &&
        !candidate.mess.nearEmpty &&
        freeVariantKinds(candidate, earlier).length > 0,
    );
    if (roots.length > 0) {
      const parent = rng.pick(roots);
      return { kind: "variant_of", parent: parent.slot, variant: rng.pick(freeVariantKinds(parent, earlier)) };
    }
  } else if (roll < 0.14) {
    const twinned = new Set(
      earlier.flatMap((candidate) => (candidate.relation.kind === "same_name_as" ? [candidate.relation.twin] : [])),
    );
    const candidates = earlier.filter(
      (candidate) =>
        candidate.titleStyle === "opaque" &&
        candidate.relation.kind === "none" &&
        candidate.studio !== studio &&
        !twinned.has(candidate.slot),
    );
    if (twinned.size < MAX_SAME_NAME_PAIRS && candidates.length > 0) {
      return { kind: "same_name_as", twin: rng.pick(candidates).slot };
    }
  }
  return { kind: "none" };
}

function freeVariantKinds(root: SlotPlan, earlier: readonly SlotPlan[]): VariantKind[] {
  const taken = earlier.flatMap((candidate) =>
    candidate.relation.kind === "variant_of" && candidate.relation.parent === root.slot
      ? [candidate.relation.variant]
      : [],
  );
  return VARIANT_KINDS.filter((kind) => !taken.includes(kind));
}

function drawOfferings(rng: Rng, earlier: readonly SlotPlan[]): (readonly [BrandId, OfferingStatus])[] {
  const status = (): OfferingStatus =>
    rng.weighted<OfferingStatus>([["live", 86], ["coming_soon", 4], ["disabled", 3], ["withdrawn", 7]]);
  const smallBrandLive = earlier.filter((slotPlan) =>
    slotPlan.offerings.some(([brand, offered]) => brand === SMALL_BRAND && offered === "live"),
  ).length;

  const offerings: (readonly [BrandId, OfferingStatus])[] = [];
  if (rng.chance(0.9)) offerings.push(["tavrenmoor", status()]);
  if (rng.chance(0.65)) offerings.push(["copperjay", status()]);
  if (rng.chance(0.07) && smallBrandLive < SMALL_BRAND_MAX_LIVE) offerings.push([SMALL_BRAND, "live"]);
  if (offerings.length === 0) offerings.push(["tavrenmoor", status()]);
  return offerings;
}

function drawWithoutReplacement<T>(rng: Rng, weights: readonly (readonly [T, number])[], n: number): T[] {
  const pool = [...weights];
  const drawn: T[] = [];
  while (drawn.length < n && pool.length > 0) {
    const item = rng.weighted(pool);
    drawn.push(item);
    pool.splice(pool.findIndex(([candidate]) => candidate === item), 1);
  }
  return drawn;
}

// ---------------------------------------------------------------------------
// Facts of record. Seeded code writes them, never the model.
// ---------------------------------------------------------------------------

const LAYOUTS: Record<WinSystem, readonly (readonly [string, number | null])[]> = {
  paylines: [["5x3", 10], ["5x3", 20], ["5x3", 25], ["5x4", 40], ["3x3", 5]],
  ways: [["5x3", 243], ["5x4", 1024], ["6x4", 4096]],
  cluster_pays: [["6x5", null], ["7x7", null]],
};

function drawFacts(rng: Rng, mechanics: readonly Mechanic[], rtpBuilds: number | undefined): Facts {
  const winSystem = winSystemOf(mechanics);
  const [grid, linesOrWays] = rng.pick(LAYOUTS[winSystem]);
  const jackpot = mechanics.includes("progressive_jackpot");
  const baseRtp = jackpot ? rng.pick([92.0, 93.5, 94.1]) : rng.pick([95.9, 96.0, 96.1, 96.21, 96.3, 96.5, 97.0]);
  const builds = rtpBuilds ?? rng.weighted([[1, 86], [3, 9], [4, 5]] as const);
  const steps = [0, 1, 2, 4].slice(0, builds);
  const year = rng.weighted([
    [2014, 3], [2016, 5], [2018, 8], [2019, 8], [2020, 10], [2021, 10],
    [2022, 12], [2023, 14], [2024, 14], [2025, 12], [2026, 4],
  ] as const);
  return {
    rtp_builds: steps.map((step) => Math.round((baseRtp - step) * 100) / 100),
    volatility: rng.weighted<VolatilityBand>([["low", 12], ["medium", 28], ["high", 45], ["very_high", 15]]),
    grid,
    lines_or_ways: linesOrWays,
    max_win_multiplier: rng.pick([500, 1000, 2500, 5000, 5000, 10000, 25000]),
    min_bet: rng.pick([0.1, 0.2, 0.25]),
    max_bet: rng.pick([50, 100, 250]),
    release_date: `${year}-${pad2(1 + rng.int(12))}-${pad2(1 + rng.int(28))}`,
    bonus_buy: rng.chance(0.4),
  };
}

function drawCopyMentionsFacts(seed: string, slot: number): boolean {
  return seededRng(seed, "copy", slot).chance(0.35);
}

export function winSystemOf(mechanics: readonly Mechanic[]): WinSystem {
  const found = WIN_SYSTEMS.filter((system) => mechanics.includes(system));
  if (found.length !== 1) {
    throw new Error(`a game needs exactly one win system, got [${found.join(", ")}] in [${mechanics.join(", ")}]`);
  }
  return at(found, 0);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Plan invariants
// ---------------------------------------------------------------------------

function checkSlot(slotPlan: SlotPlan, plan: readonly SlotPlan[]): void {
  const fail = (problem: string): never => {
    throw new Error(`plan slot ${slotPlan.slot} (${slotPlan.scenario}): ${problem}`);
  };
  winSystemOf(slotPlan.mechanics);
  if (slotPlan.themes.length === 0) fail("no themes");
  if (new Set(slotPlan.themes).size !== slotPlan.themes.length) fail("repeated theme");
  if (new Set(slotPlan.mechanics).size !== slotPlan.mechanics.length) fail("repeated mechanic");
  if (slotPlan.offerings.length === 0) fail("no offerings");

  const { relation } = slotPlan;
  if (relation.kind === "variant_of") {
    const parent = plan[relation.parent];
    if (parent === undefined || parent.slot >= slotPlan.slot) fail("variant parent must be an earlier slot");
    else if (parent.studio !== slotPlan.studio) fail("a variant must come from its parent's studio");
    else if (parent.relation.kind !== "none") fail("a variant must attach to a family root");
  }
  if (relation.kind === "same_name_as") {
    const twin = plan[relation.twin];
    if (twin === undefined || twin.slot >= slotPlan.slot) fail("same-name twin must be an earlier slot");
    else if (twin.studio === slotPlan.studio) fail("a same-name pair must span two studios");
    else if (twin.titleStyle !== "opaque" || slotPlan.titleStyle !== "opaque") {
      fail("a shared title must be opaque on both sides");
    }
  }

  const { mess } = slotPlan;
  const full = hasFullDescription(mess.description, mess.nearEmpty, studioById(slotPlan.studio));
  if (needsFullDescription(mess.tags) && !full) fail(`tag state "${mess.tags}" needs a full description`);
  if (mess.injection && !full) fail("an injected instruction needs a full description");
}

/** A dropped or contradicted tag only means something if the description is there to disagree with. */
function needsFullDescription(tags: TagState): boolean {
  return tags === "one_dropped" || tags === "conflict";
}

function hasFullDescription(description: DescriptionState, nearEmpty: boolean, studio: Studio): boolean {
  return description === "full" && !nearEmpty && !studio.omits.includes("description");
}
