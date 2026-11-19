/**
 * Prices, cost estimates and the spend limit.
 *
 * Costs are estimates: the tokens a response reports, multiplied by list price.
 */
import { z } from "zod";

/**
 * USD per million tokens, standard tier. Read from the provider's pricing page on
 * 2026-11-19; re-check before trusting a ledger produced later.
 */
export const PRICES = {
  read_on: "2026-11-19",
  enrichment_per_million_usd: { input: 2.0, cached_input: 0.1, output: 10.0 },
  embedding_per_million_usd: { input: 0.02 },
} as const;

export const EnrichmentUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  // The detail block is optional on the wire; a missing counter is zero.
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().default(0) }).prefault({}),
});
export type EnrichmentUsage = z.infer<typeof EnrichmentUsageSchema>;

export const EmbeddingUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type EmbeddingUsage = z.infer<typeof EmbeddingUsageSchema>;

export function enrichmentUsd(usage: EnrichmentUsage): number {
  const price = PRICES.enrichment_per_million_usd;
  const cached = usage.input_tokens_details.cached_tokens;
  return ((usage.input_tokens - cached) * price.input + cached * price.cached_input + usage.output_tokens * price.output) / 1_000_000;
}

export function embeddingUsd(usage: EmbeddingUsage): number {
  return (usage.total_tokens * PRICES.embedding_per_million_usd.input) / 1_000_000;
}

/** An upper bound on tokens for a text: no tokeniser gives fewer than one token per two characters of prose. */
export function tokensAtMost(text: string): number {
  return Math.ceil(text.length / 2);
}

export class SpendLimitReached extends Error {}

/**
 * The spend limit for a live run. It starts from what the stored responses
 * already cost, so the limit holds across runs and not only within one.
 *
 * A call first reserves the most it could cost and is refused when that would
 * pass the limit, so calls in flight together cannot overshoot it.
 */
export class Budget {
  readonly maxUsd: number;
  #spentUsd: number;
  #reservedUsd = 0;

  constructor(maxUsd: number, alreadySpentUsd: number) {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`the spend limit must be a positive number, got ${maxUsd}`);
    this.maxUsd = maxUsd;
    this.#spentUsd = alreadySpentUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Call before a request. Throws without reserving when the request might pass the limit. */
  reserve(worstCaseUsd: number, what: string): void {
    if (this.#spentUsd + this.#reservedUsd + worstCaseUsd > this.maxUsd) {
      throw new SpendLimitReached(
        `spend limit reached before ${what}: $${this.#spentUsd.toFixed(4)} spent and $${this.#reservedUsd.toFixed(4)} in flight ` +
          `of $${this.maxUsd.toFixed(2)}, and the call could cost up to $${worstCaseUsd.toFixed(4)}. Raise --max-usd to continue.`,
      );
    }
    this.#reservedUsd += worstCaseUsd;
  }

  /** Call after the request, with what it really cost. */
  settle(worstCaseUsd: number, actualUsd: number): void {
    this.#reservedUsd -= worstCaseUsd;
    this.#spentUsd += actualUsd;
  }
}

/** Sends one JSON request. Injected so that the live path can be exercised without a network. */
export type Transport = (url: string, apiKey: string, body: unknown) => Promise<{ status: number; body: unknown }>;

const REQUEST_TIMEOUT_MS = 180_000;

export const httpTransport: Transport = async (url, apiKey, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: (await response.json()) as unknown };
};

export interface Live {
  apiKey: string;
  budget: Budget;
  transport: Transport;
  /** Base wait before retrying a failed call; it grows with each failure. */
  retryDelayMs: number;
}

/**
 * The reason stored for a failed call. The provider's message can echo part of the key,
 * so only its machine-readable fields are kept.
 */
export function describeHttpError(status: number, body: unknown): string {
  const fields = z
    .object({ error: z.object({ type: z.string().nullish(), code: z.string().nullish(), param: z.string().nullish() }) })
    .safeParse(body);
  const detail = fields.success
    ? `type=${fields.data.error.type ?? "?"} code=${fields.data.error.code ?? "?"} param=${fields.data.error.param ?? "?"}`
    : "unreadable error body";
  return `http ${status} ${detail}`;
}

export function isRetryable(status: number): boolean {
  return [408, 409, 429].includes(status) || status >= 500;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
