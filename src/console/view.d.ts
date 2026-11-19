/** Types for view.js, which is plain JavaScript so that the browser can load it with no build step. */
type Get = (url: string) => Promise<unknown>;

export function esc(value: unknown): string;
export function versionName(version: string): string;
export function renderTrace(response: unknown): string;
export function renderCompare(responses: Record<string, unknown>, served: string): string;
export function renderEvaluation(evaluation: unknown): string;
export function renderWhatIf(evaluation: unknown, whatIf: unknown): string;
export function traceView(get: Get, request: { game: string; brand: string; version?: string; served?: string }): Promise<string>;
export function compareView(get: Get, request: { game: string; brand: string; versions: readonly string[]; served: string }): Promise<string>;
export function whatIfView(get: Get, evaluation: unknown, values: Record<string, string>): Promise<string>;
export function renderEmpty(): string;
export function renderLoading(): string;
export function renderBadInput(message: string): string;
export function renderFailed(message: string): string;
