/**
 * Reading the service's responses: everything the page works out before it draws, with no markup in it.
 *
 * Nothing here computes a score, a label or a verdict. It reads what a response carries: the labels two
 * records both hold, where a quote sits in the text it was copied from, how two lists overlap, which of
 * the evaluation's failures happened on the request on screen, and which game shows each example.
 * `get` is the only way any of it reaches data, and every URL it is given is one of this service's own.
 */
import type { Report } from "../../eval/evaluate.ts";
import type { Decision, MARKS, Thresholds } from "../../eval/gate.ts";
import type { Version } from "../pipeline/versions.ts";
import type { FilterStep, Recommendation, TraceAnchor } from "../service/recommend.ts";

export type Get = (url: string) => Promise<unknown>;

/** The service rejected the request as bad input (a 400). Its message says what was wrong. */
export class BadRequestError extends Error {}

/** A response of /api/recommendations with its trace, or of /api/inspect. */
export type Answer = Recommendation & { inspection?: { served_version: Version; is_served_version: boolean } };

export interface CatalogueGame {
  game_id: string;
  title: string;
  provider: string;
  evidence: "description" | "tags_only" | "none";
  thin: boolean;
  conflict: boolean;
  family_id: string | null;
  status: Record<string, string>;
}

export interface Catalogue {
  served: { version: Version; index_hash: string; floor: number; floor_rule: string };
  versions: Version[];
  brands: { brand: string; live: number }[];
  offerings_for_unknown_games: number;
  games: CatalogueGame[];
}

export interface Evaluation {
  verdict: { ships: Version | null; reason: string; index_hash: string; passed: boolean };
  thresholds: Thresholds & { decided_on?: string };
  thresholds_file: string;
  marks: typeof MARKS;
  report: Report;
}

export interface WhatIf {
  note: string;
  marks: Thresholds;
  committed: Thresholds;
  decision: Decision;
}

export type Failure = Report["gallery"]["real"][number];
export type Held = TraceAnchor["steps"]["table"]["themes"][number] & { field: "themes" | "mechanics" };

// ---------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------

export const words = (term: unknown): string => String(term).replaceAll("_", " ");
export const count = (value: number): string => value.toLocaleString("en-US");
export const plural = (number: number, one: string, many: string): string => `${count(number)} ${number === 1 ? one : many}`;
export const pct = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`);
export const url = (path: string, params: Record<string, string>): string => `${path}?${new URLSearchParams(params).toString()}`;

const VERSION_NAMES: Record<string, string> = { raw: "Raw text", table: "Synonym table", model_where_thin: "Model where thin", model_everywhere: "Model everywhere" };
export const versionName = (version: string): string => VERSION_NAMES[version] ?? version;

/** A score to two places, for reading at a glance. The exact number stays one click away. */
export const short = (score: number): string => score.toFixed(2);

/** A build cost is an estimate, and reads as one: two places, never the four the report stores. */
export function estimate(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.005 ? "under $0.01" : `about $${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The labels a version holds for a record, themes first. */
export function heldLabels(anchor: TraceAnchor | null | undefined): Held[] {
  if (!anchor || anchor.fields === null) return [];
  const { fields } = anchor;
  return (["themes", "mechanics"] as const).flatMap((field) => fields[field].labels.map((entry) => ({ ...entry, field })));
}

/** The labels of the game played that another game also holds, in the same version. */
export function sharedLabels(anchor: TraceAnchor | null | undefined, neighbour: Answer | undefined): Held[] {
  const theirs = heldLabels(neighbour?.trace?.anchor);
  return heldLabels(anchor).filter((mine) => theirs.some((other) => other.field === mine.field && other.label === mine.label));
}

export interface Piece {
  text: string;
  /** The numbers of the labels read from these words. Absent for words no label was read from. */
  numbers?: number[];
}

/**
 * A text of the record cut into pieces, with the words each label was read from marked in place.
 * `placed` holds the numbers that were found, so a quote that is nowhere in the text can be said.
 */
export function markText(text: string, labels: readonly { quote: string; n: number }[]): { pieces: Piece[]; placed: number[] } {
  const spans: { start: number; end: number; numbers: number[] }[] = [];
  for (const entry of labels) {
    const start = entry.quote === "" ? -1 : text.indexOf(entry.quote);
    if (start !== -1) spans.push({ start, end: start + entry.quote.length, numbers: [entry.n] });
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.numbers.push(...span.numbers);
    } else merged.push(span);
  }
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start) });
    pieces.push({ text: text.slice(span.start, span.end), numbers: span.numbers });
    cursor = span.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return { pieces, placed: spans.flatMap((span) => span.numbers) };
}

export const sameTag = (a: unknown, b: unknown): boolean => a === b || String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** The supplier's three lists the lookup table reads, in the order the record gives them. */
const SUPPLIER_LISTS = ["features", "themes", "tags"] as const;
const listed = (items: readonly string[], last: "and" | "or"): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`);

/** What the lookup table read and from which of the supplier's lists, counted from the table's own output for this record. */
export function tableRead(anchor: TraceAnchor): string {
  const labels = [...anchor.steps.table.themes, ...anchor.steps.table.mechanics];
  if (labels.length === 0) return `found no label in the supplier's ${listed(SUPPLIER_LISTS, "or")}`;
  const from = SUPPLIER_LISTS.filter((list) => labels.some((entry) => entry.source_field === list));
  return `read ${plural(labels.length, "label", "labels")} from the supplier's ${listed(from, "and")}`;
}

/** Which entry of which of the supplier's lists the description contradicts, from the record. */
export function contradiction(anchor: TraceAnchor, conflict: NonNullable<TraceAnchor["steps"]["conflict"]>): string {
  const from = anchor.steps.table.mechanics.find((entry) => entry.label === conflict.tag_asserts && sameTag(entry.quote, conflict.tag))?.source_field;
  return `“${conflict.tag}” in the supplier's ${from ?? "lists"} says ${words(conflict.tag_asserts)} but the description says ${conflict.description_states.map(words).join(", ")}`;
}

/**
 * What happened to this record on its way into this version of the index, in one sentence.
 * Every clause is read from the record: what the lookup table found is the table's own output, whatever
 * version is on screen, and what the version holds is counted from the labels it holds.
 */
export function story(anchor: TraceAnchor, version: string): string {
  const { conflict, model } = anchor.steps;
  let first: string;
  if (conflict !== null) first = `${contradiction(anchor, conflict)}, so ${versionName("table")} asserts no mechanic`;
  else first = `the lookup table ${tableRead(anchor)}`;
  first = anchor.thin ? `A thin record: ${first}` : `${first[0]?.toUpperCase()}${first.slice(1)}`;
  if (anchor.fields === null) return `${first}; ${versionName(version)} holds no labels and indexes the supplier's text as it is.`;
  const held = heldLabels(anchor);
  const fromModel = held.filter((entry) => entry.method === "model").length;
  const fromTable = held.length - fromModel;
  if (!model.used) return `${first}; ${versionName(version)} does not use the model for this record and holds ${plural(fromTable, "label", "labels")} from the table.`;
  if (fromModel === 0) return `${first}; the model was asked, and ${versionName(version)} holds no label from it.`;
  return `${first}; ${versionName(version)} holds ${plural(fromModel, "label", "labels")} the model read from the text${fromTable === 0 ? "" : ` and ${count(fromTable)} from the table`}, each marked in the words it was read from.`;
}

// ---------------------------------------------------------------------------
// The evaluation's failures, where they happened
// ---------------------------------------------------------------------------

/**
 * The real failures the evaluation lists that happened on the request on screen: this game, this version,
 * and, where the failure names a brand, a result or a decline, that brand, that result and that outcome.
 * A failure found on one brand says nothing about the same game on another.
 */
export function failuresHere(evaluation: Evaluation | undefined, response: Answer): Failure[] {
  const anchor = response.trace?.anchor ?? null;
  if (evaluation === undefined || anchor === null) return [];
  const { report } = evaluation;
  return report.gallery.real.filter((entry) => {
    if (entry.game_id !== anchor.game_id) return false;
    if (entry.version !== null && entry.version !== response.served.version) return false;
    const detail = entry.detail as { brand?: unknown; result?: { game_id?: unknown } };
    const about = typeof detail.result?.game_id === "string" ? detail.result.game_id : null;
    // A failure about a result the evaluation saw was seen on its check brand.
    const brand = typeof detail.brand === "string" ? detail.brand : about !== null ? report.check_games.brand : null;
    if (brand !== null && brand !== response.request.brand) return false;
    if (about !== null && !response.results.some((result) => result.game_id === about)) return false;
    if (/declined/.test(entry.kind) && response.outcome !== "declined") return false;
    // A failure of the ranking is shown where there is a ranking: not beside a request that was declined before anything was scored.
    if (!entry.kind.startsWith("label_") && brand === null && (response.trace?.scores.length ?? 0) === 0) return false;
    return true;
  });
}

/** A failure about the labels belongs with the labels; any other belongs with the result. */
export const failureTab = (failure: Failure): TabId => (failure.kind.startsWith("label_") ? "added" : "shown");

// ---------------------------------------------------------------------------
// The path from the catalogue to the result
// ---------------------------------------------------------------------------

type Group = "eligible" | "similar" | "limit" | "other";
const STEPS: Record<string, { name: string; group: Group }> = {
  not_live_on_brand: { name: "Live on this brand", group: "eligible" },
  anchor_or_duplicate: { name: "Not the game itself", group: "eligible" },
  insufficient_data: { name: "Enough to compare", group: "eligible" },
  below_floor: { name: "Above the floor", group: "similar" },
  family_cap: { name: "One per family", group: "limit" },
  over_limit: { name: "Within the limit", group: "limit" },
};
/** The three different things a step can decide, in a word. */
export const GROUPS: Record<Group, string> = { eligible: "rule", similar: "score", limit: "limit", other: "step" };
export const stepName = (filter: string): string => STEPS[filter]?.name ?? words(filter);
const stepGroup = (filter: string): Group => STEPS[filter]?.group ?? "other";

export type { Group };
export interface Run {
  group: Group;
  steps: { step: FilterStep; index: number }[];
}

/** Runs of neighbouring steps that decide the same thing, in the order the trace gives them. */
export function runsOf(filters: readonly FilterStep[]): Run[] {
  const runs: Run[] = [];
  filters.forEach((step, index) => {
    const group = stepGroup(step.filter);
    if (runs.at(-1)?.group !== group) runs.push({ group, steps: [] });
    runs.at(-1)?.steps.push({ step, index });
  });
  return runs;
}

// ---------------------------------------------------------------------------
// One request, and everything the page shows for it
// ---------------------------------------------------------------------------

export interface Request {
  game: string;
  brand: string;
  version: Version;
}

export interface Loaded {
  response: Answer;
  /** Each returned game's own record in the same version, for what it has in common with the game played. */
  neighbours: Record<string, Answer>;
  /** Every version's answer to the same request. */
  versions: Record<string, Answer>;
}

export const sameRequest = (a: Request, b: Request): boolean => a.game === b.game && a.brand === b.brand && a.version === b.version;

/** Asks the service for one request: its answer, each returned game's record, and every other version's answer. */
export async function loadRequest(get: Get, request: Request, catalogue: Pick<Catalogue, "served" | "versions">): Promise<Loaded> {
  const params = { game: request.game, brand: request.brand };
  const inspect = (version: string, game = request.game): Promise<Answer> => get(url("/api/inspect", { game, brand: request.brand, version })) as Promise<Answer>;
  const response = (request.version === catalogue.served.version ? await get(url("/api/recommendations", { ...params, trace: "1" })) : await inspect(request.version)) as Answer;
  const [neighbours, versions] = await Promise.all([
    Promise.all(response.results.map(async (entry) => [entry.game_id, await inspect(response.served.version, entry.game_id)] as const)),
    Promise.all(catalogue.versions.map(async (version) => [version, version === response.served.version ? response : await inspect(version)] as const)),
  ]);
  return { response, neighbours: Object.fromEntries(neighbours), versions: Object.fromEntries(versions) };
}

/**
 * Keeps only the answer to the last question asked. `ask` starts a piece of work and returns its result,
 * or null when another was started before it finished: a late answer is never shown for another request.
 */
export function latestOnly(): <T>(work: () => Promise<T>) => Promise<{ value: T } | null> {
  let current = 0;
  return async (work) => {
    current += 1;
    const mine = current;
    const value = await work();
    return mine === current ? { value } : null;
  };
}

/** How another version's list compares with the list on screen, in the words the page uses. */
export function overlap(mine: readonly string[], other: Answer): string {
  const theirs = other.results.map((entry) => entry.game_id);
  const same = theirs.filter((id) => mine.includes(id)).length;
  if (other.outcome === "declined") return "declines";
  if (mine.length === 0) return `returns ${plural(theirs.length, "game", "games")}`;
  if (same === mine.length && theirs.length === same) return theirs.join() === mine.join() ? "the same games, same order" : "the same games, another order";
  return `${count(same)} of these ${count(mine.length)}${theirs.length > same ? `, and ${plural(theirs.length - same, "other", "others")}` : ""}`;
}

/**
 * The options of the game picker for one brand. A game that an address asks for and the index does not hold
 * gets an option of its own, so that the request is sent as asked and the service's decline is what is shown.
 */
export function gameOptions(catalogue: Catalogue, brand: string | null, asked?: string | null): { value: string; label: string; note: string }[] {
  const options = catalogue.games.map((entry) => {
    const notes = brand === null ? [] : [words(entry.status[brand] ?? "not_offered")];
    if (entry.evidence === "none") notes.push("nearly empty");
    else if (entry.conflict) notes.push("conflicting tag");
    else if (entry.thin) notes.push("thin");
    return { value: entry.game_id, label: entry.title, note: notes.join(", ") };
  });
  if (asked && !catalogue.games.some((entry) => entry.game_id === asked)) options.unshift({ value: asked, label: asked, note: "not in the index" });
  return options;
}

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

export const TABS = [
  { id: "shown", name: "Shown" },
  { id: "added", name: "Added" },
  { id: "removed", name: "Removed" },
  { id: "worth", name: "Worth it" },
] as const;
export type TabId = (typeof TABS)[number]["id"];
const isTab = (value: string): value is TabId => TABS.some((tab) => tab.id === value);

export interface Address {
  game: string | null;
  brand: string | null;
  version: Version;
  tab: TabId;
  /** A game to point out on the path. */
  focus: string | null;
  /** Whether the address named anything at all. With nothing named, the page opens its first example. */
  empty: boolean;
  /** What is wrong with the address, each in a sentence. Nothing wrong is replaced in silence. */
  problems: string[];
}

const PARAMETERS = ["game", "brand", "version", "tab", "focus"];

/**
 * Reads the page's address against what the service holds. A brand or a version the service does not
 * know, a section the page does not have and a parameter it does not read are each reported for what
 * they are. A game the index does not hold is not a problem here: it is asked for, and the service declines.
 */
export function readAddress(search: string, catalogue: Pick<Catalogue, "brands" | "versions" | "served">): Address {
  const asked = new URLSearchParams(search);
  const problems: string[] = [];
  for (const name of new Set(asked.keys())) {
    if (!PARAMETERS.includes(name)) problems.push(`The address has a parameter this page does not read: "${name}". It reads ${PARAMETERS.join(", ")}.`);
    else if (asked.getAll(name).length > 1) problems.push(`The address gives "${name}" more than once.`);
  }
  const value = (name: string): string | null => (asked.get(name) === null || asked.get(name) === "" ? null : asked.get(name));
  const brands = catalogue.brands.map((entry) => entry.brand);
  let brand = value("brand");
  if (brand !== null && !brands.includes(brand)) {
    problems.push(`The address names the brand "${brand}", which this service does not have. Its brands are ${brands.join(", ")}; the name must match exactly.`);
    brand = null;
  }
  let version: Version = catalogue.served.version;
  const askedVersion = value("version");
  if (askedVersion !== null) {
    const known = catalogue.versions.find((entry) => entry === askedVersion);
    if (known === undefined) problems.push(`The address names the version "${askedVersion}", which this index does not have. Its versions are ${catalogue.versions.join(", ")}; the served one is shown.`);
    else version = known;
  }
  let tab: TabId = "shown";
  const askedTab = value("tab");
  if (askedTab !== null) {
    if (isTab(askedTab)) tab = askedTab;
    else problems.push(`The address asks for the section "${askedTab}", which this page does not have. Its sections are ${TABS.map((entry) => entry.id).join(", ")}; the first is shown.`);
  }
  const game = value("game");
  if (game !== null && value("brand") === null) problems.push(`The address names the game "${game}" and no brand. Choose a brand to see what is shown there.`);
  if (game === null && brand !== null) problems.push(`The address names the brand "${brand}" and no game. Choose a game to see what is shown for it.`);
  return { game, brand, version, tab, focus: value("focus"), empty: [...asked.keys()].length === 0, problems };
}

/** The address of a request, as the page writes it and as an example links to it. */
export function addressOf(request: { game: string; brand: string; version?: string | null | undefined; tab?: TabId | null | undefined; focus?: string | null | undefined }, served: string): string {
  const query = new URLSearchParams({ game: request.game, brand: request.brand });
  if (request.version && request.version !== served) query.set("version", request.version);
  if (request.tab && request.tab !== "shown") query.set("tab", request.tab);
  if (request.focus) query.set("focus", request.focus);
  return `/?${query}`;
}

// ---------------------------------------------------------------------------
// Examples: one game for each thing worth seeing, found in the service's own responses
// ---------------------------------------------------------------------------

export const EXAMPLE_KINDS = ["thin", "plain", "conflict", "filter", "decline", "versions", "failure"] as const;
export type ExampleKind = (typeof EXAMPLE_KINDS)[number];

const EXAMPLE_NAMES: Record<ExampleKind, string> = {
  thin: "A thin record gains labels",
  plain: "Already well described: the model adds nothing",
  conflict: "A tag contradicts the description",
  filter: "A plausible game is removed",
  decline: "A decline instead of a guess",
  versions: "The versions disagree",
  failure: "A failure the evaluation found",
};

/** One game that shows one thing worth seeing, or the statement that the data holds none. */
export interface Example {
  kind: ExampleKind;
  name: string;
  found: boolean;
  note: string;
  game?: string;
  brand?: string;
  version?: Version;
  focus?: string;
  /** The section that shows it. */
  tab?: TabId;
  href?: string;
}

type Found = Required<Pick<Example, "game" | "brand" | "tab" | "note">> & Pick<Example, "focus" | "version">;

/** How many requests one search may make before it gives up and says it found none. */
const SEARCH_LIMIT = 40;

/**
 * Looks through the catalogue and the evaluation for one game that shows each thing.
 * No game is named in the code: change the catalogue and the examples change with it. An example the
 * data does not hold is returned as not found, and shown as such. What an example's line says is read
 * from the response that made it an example.
 */
export async function findExamples(get: Get, catalogue: Catalogue, evaluation: Evaluation): Promise<Example[]> {
  const home = [...catalogue.brands].sort((a, b) => b.live - a.live)[0]?.brand;
  const byId = new Map(catalogue.games.map((entry) => [entry.game_id, entry]));
  const liveOn = (entry: CatalogueGame | undefined, brand: string): boolean => entry?.status[brand] === "live";
  const served = catalogue.served.version;
  const recommend = (id: string, brand: string): Promise<Answer> => get(url("/api/recommendations", { game: id, brand, trace: "1" })) as Promise<Answer>;
  const { report } = evaluation;

  const finders: Record<ExampleKind, (home: string) => Promise<Found | null>> = {
    /** Among the thin records that are live and get results, the one the model added most labels to. */
    async thin(home) {
      const candidates = catalogue.games.filter((entry) => entry.thin && !entry.conflict && entry.evidence !== "none" && liveOn(entry, home)).slice(0, SEARCH_LIMIT);
      const answers = await Promise.all(candidates.map((entry) => recommend(entry.game_id, home)));
      let best: { response: Answer; fromModel: number } | null = null;
      for (const response of answers) {
        const fromModel = heldLabels(response.trace?.anchor).filter((held) => held.method === "model").length;
        if (response.outcome === "results" && fromModel > (best?.fromModel ?? 0)) best = { response, fromModel };
      }
      const anchor = best?.response.trace?.anchor;
      if (!best || !anchor) return null;
      return { game: anchor.game_id, brand: home, tab: "added", note: `The lookup table ${tableRead(anchor)}, and the model added ${best.fromModel} from the text.` };
    },
    /** A record the supplier described well: the table's labels were enough, and this version holds none from the model. */
    async plain(home) {
      const candidates = catalogue.games.filter((entry) => !entry.thin && !entry.conflict && entry.evidence === "description" && liveOn(entry, home)).slice(0, SEARCH_LIMIT);
      for (const entry of candidates) {
        const response = await recommend(entry.game_id, home);
        const anchor = response.trace?.anchor;
        const held = heldLabels(anchor);
        if (anchor && response.outcome === "results" && held.length > 0 && held.every((label) => label.method !== "model")) {
          return { game: entry.game_id, brand: home, tab: "added", note: `The lookup table ${tableRead(anchor)}; the model adds nothing.` };
        }
      }
      return null;
    },
    async conflict(home) {
      const listed = report.conflict_games.games.filter((entry) => liveOn(byId.get(entry.game_id), home));
      const pick = listed.find((entry) => (entry.mechanics as Record<string, { status: string }>)[served]?.status === "asserted") ?? listed[0];
      if (pick === undefined) return null;
      return { game: pick.game_id, brand: home, tab: "added", note: `“${pick.tag}” in the supplier's record says ${words(pick.tag_asserts)}; the description says ${pick.description_states.map(words).join(", ")}.` };
    },
    /** A game whose best match on another brand is not live on this one, and is removed here before anything is scored. */
    async filter(home) {
      let asked = 0;
      for (const { brand: other } of [...catalogue.brands].filter((entry) => entry.brand !== home).sort((a, b) => b.live - a.live)) {
        for (const entry of catalogue.games) {
          if (!liveOn(entry, home) || !liveOn(entry, other)) continue;
          if ((asked += 1) > SEARCH_LIMIT) return null;
          const best = (await recommend(entry.game_id, other)).results[0];
          if (best === undefined || liveOn(byId.get(best.game_id), home)) continue;
          const here = await recommend(entry.game_id, home);
          const removed = here.trace?.filters.flatMap((step) => step.removed).find((gone) => gone.game_id === best.game_id);
          if (removed === undefined) continue;
          return { game: entry.game_id, brand: home, focus: best.game_id, tab: "removed", note: `${best.title} is its closest match on ${other}, and is ${words(removed.why)} on ${home}.` };
        }
      }
      return null;
    },
    /** A live game the service declines: a record with nothing in it first, and one the evaluation lists no failure for, so the example shows one thing. */
    async decline(home) {
      const failed = new Set(report.gallery.real.map((entry) => entry.game_id));
      const order = (entry: CatalogueGame): number => (entry.evidence === "none" ? 0 : 2) + (failed.has(entry.game_id) ? 1 : 0);
      const candidates = catalogue.games.filter((entry) => liveOn(entry, home)).sort((a, b) => order(a) - order(b)).slice(0, SEARCH_LIMIT);
      for (const entry of candidates) {
        const response = await recommend(entry.game_id, home);
        if (response.outcome === "declined" && response.decline) return { game: entry.game_id, brand: home, tab: "shown", note: `The service declines to recommend: ${words(response.decline.reason)}.` };
      }
      return null;
    },
    /** Among the evaluation's check games, the one whose list changes most between the first version and the served one. */
    async versions() {
      const check = report.check_games;
      const results = check.results as Record<string, { anchor: string; results: { game_id: string }[] }[]>;
      const first = Object.keys(results)[0];
      if (first === undefined) return null;
      const ids = (version: string, index: number): string[] => (results[version]?.[index]?.results ?? []).map((entry) => entry.game_id);
      let best: { anchor: string; changed: number; first: number; mine: number } | null = null;
      for (const [index, anchor] of (results[served] ?? []).entries()) {
        if (!byId.has(anchor.anchor)) continue;
        const [theirs, mine] = [ids(first, index), ids(served, index)];
        const changed = theirs.filter((id) => !mine.includes(id)).length + mine.filter((id) => !theirs.includes(id)).length;
        if (changed > (best?.changed ?? 0)) best = { anchor: anchor.anchor, changed, first: theirs.length, mine: mine.length };
      }
      if (best === null) return null;
      return { game: best.anchor, brand: check.brand, tab: "worth", note: `${plural(best.first, "game", "games")} from ${versionName(first)}, ${best.mine} from ${versionName(served)}, not all the same.` };
    },
    /** One of the real failures the evaluation lists, on the brand and in the version where it happened: the page must show it there. */
    async failure(home) {
      for (const entry of report.gallery.real) {
        if (!byId.has(entry.game_id)) continue;
        const named = (entry.detail as { brand?: unknown }).brand;
        // The brand the failure names first, then the brands where the game is live, the largest first.
        const live = [home, ...catalogue.brands.map((item) => item.brand)].filter((brand) => liveOn(byId.get(entry.game_id), brand));
        const brands = [...new Set([...(typeof named === "string" ? [named] : []), ...live])];
        const version = entry.version ?? served;
        for (const brand of brands) {
          if (!catalogue.brands.some((item) => item.brand === brand)) continue;
          const response = (version === served ? await recommend(entry.game_id, brand) : await get(url("/api/inspect", { game: entry.game_id, brand, version }))) as Answer;
          const here = failuresHere(evaluation, response).find((failure) => failure === entry);
          if (here === undefined) continue;
          return { game: entry.game_id, brand, version, tab: failureTab(entry), note: `${entry.what.split(". ")[0]?.replace(/\.$/, "")}.` };
        }
      }
      return null;
    },
  };

  const examples: Example[] = [];
  for (const kind of EXAMPLE_KINDS) {
    const found = home === undefined ? null : await finders[kind](home);
    if (found === null) examples.push({ kind, name: EXAMPLE_NAMES[kind], found: false, note: "No game in this catalogue shows it." });
    else examples.push({ kind, name: EXAMPLE_NAMES[kind], found: true, ...found, href: addressOf(found, served) });
  }
  return examples;
}
