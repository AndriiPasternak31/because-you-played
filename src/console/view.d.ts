/** Types for view.js, which is plain JavaScript so that the browser can load it with no build step. */
type Get = (url: string) => Promise<unknown>;

/** One game that shows one of the things worth seeing, or the statement that the data holds none. */
export interface Example {
  kind: "thin" | "plain" | "conflict" | "filter" | "decline" | "versions" | "failure";
  name: string;
  found: boolean;
  note: string;
  game?: string;
  brand?: string;
  focus?: string;
  /** The section of the page that shows it. */
  section?: string;
  href?: string;
}

export function esc(value: unknown): string;
export function versionName(version: string): string;
/** What a request can be shown with, beyond its own response. Every part is optional and comes from this service. */
export interface Extras {
  neighbours?: Record<string, unknown>;
  versions?: Record<string, unknown>;
  evaluation?: unknown;
  focus?: string | undefined;
  look?: { note: string; section?: string | undefined } | undefined;
  /** The section that is open. */
  section?: string | undefined;
}

/** One of the four sections of the page: the question it asks, and why it matters. */
export interface Section {
  id: string;
  pane: string;
  tab: string;
  question: string;
  why: string;
}
export const SECTIONS: readonly Section[];
export function renderTabs(open: string, request: Record<string, string>): string;
/** What an address asks for. `game` is null when it names no request. */
export interface Asked {
  game: string | null;
  brand: string | null;
  version: string | null;
  section: string;
  focus: string | null;
  open: string | null;
}
export function addressRequest(search: string, catalogue: unknown): Asked;
export function brandOptions(catalogue: unknown, asked?: string | null): { value: string; text: string }[];
export function versionOptions(catalogue: unknown, asked?: string | null): { value: string; text: string }[];
/** Marks the start of work for a place; the function it returns says whether that work is still the latest for it. */
export function turns(): (place: object) => () => boolean;

export function renderTrace(response: unknown, extras?: Extras): string;
export function renderCompare(responses: Record<string, unknown>, served: string): string;
export function renderEvaluation(evaluation: unknown): string;
export function renderWhatIf(evaluation: unknown, whatIf: unknown): string;
export function traceView(
  get: Get,
  request: { game: string; brand: string; version?: string; served?: string; versions?: readonly string[]; evaluation?: unknown; focus?: string | undefined; look?: Extras["look"]; section?: string | undefined },
): Promise<string>;
export function compareView(get: Get, request: { game: string; brand: string; versions: readonly string[]; served: string }): Promise<string>;
export function whatIfView(get: Get, evaluation: unknown, values: Record<string, string>): Promise<string>;
export function gameOptions(catalogue: unknown, brand: string, asked?: string | null): { value: string; text: string }[];
export function findExamples(get: Get, catalogue: unknown, evaluation: unknown): Promise<Example[]>;
export function renderExamples(examples: readonly Example[], current?: { game: string; brand: string }): string;
export function renderEmpty(): string;
export function renderLoading(): string;
export function renderBadInput(message: string): string;
export function renderFailed(message: string): string;
