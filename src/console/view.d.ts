/** Types for view.js, which is plain JavaScript so that the browser can load it with no build step. */
type Get = (url: string) => Promise<unknown>;

/** One game that shows one of the five things worth seeing, or the statement that the data holds none. */
export interface Example {
  kind: "thin" | "plain" | "conflict" | "filter" | "decline" | "versions" | "failure";
  name: string;
  found: boolean;
  note: string;
  game?: string;
  brand?: string;
  focus?: string;
  /** The id of the part of the page that shows it. */
  target?: string;
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
  look?: { note: string; target?: string | undefined } | undefined;
}

export function renderTrace(response: unknown, extras?: Extras): string;
export function renderCompare(responses: Record<string, unknown>, served: string): string;
export function renderEvaluation(evaluation: unknown): string;
export function renderWhatIf(evaluation: unknown, whatIf: unknown): string;
export function traceView(
  get: Get,
  request: { game: string; brand: string; version?: string; served?: string; versions?: readonly string[]; evaluation?: unknown; focus?: string | undefined; look?: Extras["look"] },
): Promise<string>;
export function compareView(get: Get, request: { game: string; brand: string; versions: readonly string[]; served: string }): Promise<string>;
export function whatIfView(get: Get, evaluation: unknown, values: Record<string, string>): Promise<string>;
export function gameOptions(catalogue: unknown, brand: string, asked?: string | null): { value: string; text: string }[];
export function findExamples(get: Get, catalogue: unknown, evaluation: unknown): Promise<Example[]>;
export function renderExamples(examples: readonly Example[], current?: string): string;
export function renderEmpty(): string;
export function renderLoading(): string;
export function renderBadInput(message: string): string;
export function renderFailed(message: string): string;
