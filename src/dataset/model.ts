/**
 * Record model for the generated catalogue.
 *
 * Three things leave the generator for the rest of the system:
 *   - raw records: an envelope around the payload a source feed delivered;
 *   - offerings: availability per game and brand, in its own file;
 *   - hidden truth: what each game really is and what each raw row lost.
 *
 * The truth exists for evaluation only. Nothing in the pipeline or the
 * service may read it.
 */
import { z } from "zod";
import { MECHANICS, THEMES } from "./vocabulary.ts";

const ThemeSchema = z.enum(THEMES);
const MechanicSchema = z.enum(MECHANICS);
const TermSchema = z.enum([...THEMES, ...MECHANICS]);

// ---------------------------------------------------------------------------
// Raw record: what the pipeline is allowed to see
// ---------------------------------------------------------------------------

/**
 * One feed shape. Every key except the identity keys is optional because
 * whole fields are missing for some studios. Fact-like values (rtp,
 * volatility, bets, max win, dates) keep whatever format the studio uses:
 * they are carried verbatim and never parsed.
 */
export const RawPayloadSchema = z.strictObject({
  /** Stable supplier game id. Two rows sharing it are the same game. */
  game_code: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  category: z.string().min(1),
  /** Franchise id; supplied by some studios, null when a supplying studio has none. */
  family: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
  themes: z.array(z.string()).optional(),
  /** Merchandising labels; never a game attribute. */
  tags: z.array(z.strictObject({ name: z.string().min(1) })).optional(),
  rtp: z.union([z.string(), z.number()]).optional(),
  volatility: z.union([z.string(), z.number()]).optional(),
  grid: z.string().optional(),
  lines: z.union([z.string(), z.number()]).optional(),
  ways: z.union([z.string(), z.number()]).optional(),
  max_win: z.union([z.string(), z.number()]).optional(),
  min_bet: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  max_bet: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  release_date: z.string().optional(),
  bonus_buy: z.boolean().optional(),
});

export const RawRecordSchema = z.strictObject({
  source_system: z.string().min(1),
  source_record_id: z.string().min(1),
  fetched_at: z.iso.datetime(),
  payload: RawPayloadSchema,
});

export type RawPayload = z.infer<typeof RawPayloadSchema>;
export type RawRecord = z.infer<typeof RawRecordSchema>;

// ---------------------------------------------------------------------------
// Offering: availability, on its own lifecycle
// ---------------------------------------------------------------------------

export const OFFERING_STATUSES = ["live", "coming_soon", "disabled", "withdrawn"] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

/** `game_id` is the supplier game id (`payload.game_code`). Only `live` is eligible. */
export const OfferingSchema = z.strictObject({
  game_id: z.string().min(1),
  brand: z.string().min(1),
  jurisdiction: z.string().length(2),
  status: z.enum(OFFERING_STATUSES),
});
export type Offering = z.infer<typeof OfferingSchema>;

// ---------------------------------------------------------------------------
// Hidden truth
// ---------------------------------------------------------------------------

export const VOLATILITY_BANDS = ["low", "medium", "high", "very_high"] as const;
export type VolatilityBand = (typeof VOLATILITY_BANDS)[number];

export const FactsSchema = z.strictObject({
  rtp_builds: z.array(z.number()).min(1),
  volatility: z.enum(VOLATILITY_BANDS),
  grid: z.string(),
  lines_or_ways: z.number().int().nullable(),
  max_win_multiplier: z.number().int(),
  min_bet: z.number(),
  max_bet: z.number(),
  release_date: z.iso.date(),
  bonus_buy: z.boolean(),
});
export type Facts = z.infer<typeof FactsSchema>;

/** A quote from the truth description that shows a term applies. */
export const EvidenceSchema = z.strictObject({
  term: TermSchema,
  span: z.string(),
  span_de: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * What the model writes for one game. Kept to basic types so it is a valid
 * strict structured-output schema; lengths and cross-field rules are checked
 * in code after parsing.
 */
export const TruthTextSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  description_de: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  title_theme_terms: z.array(ThemeSchema),
});
export type TruthText = z.infer<typeof TruthTextSchema>;

export const TruthGameSchema = z.strictObject({
  game_id: z.string(),
  slot: z.number().int(),
  scenario: z.string(),
  title: z.string(),
  studio: z.string(),
  game_type: z.literal("slot"),
  family_id: z.string().nullable(),
  variant_of: z.string().nullable(),
  variant_kind: z.enum(["sequel", "deluxe", "seasonal"]).nullable(),
  same_name_as: z.string().nullable(),
  themes: z.array(ThemeSchema),
  mechanics: z.array(MechanicSchema),
  /** Themes the title alone states, as declared by the writing model. */
  title_theme_terms: z.array(ThemeSchema),
  facts: FactsSchema,
  description: z.string(),
  description_de: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  written_by: z.strictObject({
    response_file: z.string(),
    model: z.string(),
    prompt_version: z.string(),
  }),
});
export type TruthGame = z.infer<typeof TruthGameSchema>;

export const MESS_KINDS = [
  "description_missing",
  "description_boilerplate",
  "description_terse",
  "description_non_english",
  "description_markup",
  "prompt_injection",
  "tags_missing",
  "tag_spelling_drift",
  "tag_dropped_but_inferable",
  "tag_conflicts_description",
  "non_attribute_tags",
  "title_decoration",
  "near_empty",
  "studio_field_gap",
  "family_not_supplied",
  "same_name_different_studio",
  "supplier_id_duplicate",
  "rtp_multi_build",
  "fact_format_variant",
  "interacting_defects",
] as const;
export type MessKind = (typeof MESS_KINDS)[number];

const RECOVERY_SOURCES = ["title", "description", "source_tags"] as const;
export type RecoverySource = (typeof RECOVERY_SOURCES)[number];

const RecoverableSchema = z.strictObject({
  term: TermSchema,
  via: z.array(z.enum(RECOVERY_SOURCES)).min(1),
});

/** Per raw row: which defects were applied and what can still be recovered. */
export const TruthRowSchema = z.strictObject({
  source_record_id: z.string(),
  game_id: z.string(),
  /** Set on the later row of a true duplicate pair. */
  duplicate_of: z.string().nullable(),
  mess: z.array(z.enum(MESS_KINDS)),
  clean_control: z.boolean(),
  description_state: z.enum(["full", "terse", "boilerplate", "missing"]),
  description_locale: z.enum(["en", "de"]).nullable(),
  injected_instruction: z.boolean(),
  dropped_tag_terms: z.array(TermSchema),
  conflicting_tags: z.array(
    z.strictObject({ tag: z.string(), asserts: TermSchema, contradicts: TermSchema }),
  ),
  non_attribute_tags: z.array(z.string()),
  recoverable: z.strictObject({
    themes: z.array(RecoverableSchema),
    mechanics: z.array(RecoverableSchema),
  }),
  unknowable: z.strictObject({
    themes: z.array(ThemeSchema),
    mechanics: z.array(MechanicSchema),
  }),
  expected_abstain: z.strictObject({ themes: z.boolean(), mechanics: z.boolean() }),
});
export type TruthRow = z.infer<typeof TruthRowSchema>;
