# Catalogue data

A fictional catalogue of online slot games, built to look like something a real source system delivered: thin, inconsistent and partly wrong. Every game, studio and brand here is invented.

**Status: pilot.** 14 games, 15 raw rows, 31 offerings across three brands. The full catalogue of about 100 games is the same command with a larger count.

## What is here

| Path | What it is | Who may read it |
|---|---|---|
| `catalogue.raw.jsonl` | One raw record per line: an envelope (`source_system`, `source_record_id`, `fetched_at`) around the `payload` the feed delivered | Everything |
| `offerings.jsonl` | Availability: one line per game and brand, with `jurisdiction` and `status` | Everything |
| `generation/truth.games.jsonl` | What each game really is: themes, mechanics, facts, full description, family and name relations | Generator and evaluation only |
| `generation/truth.rows.jsonl` | Per raw row: which defects were applied, and which themes and mechanics can still be supported from that row | Generator and evaluation only |
| `generation/responses/` | Every model attempt behind the truth text, as received | Generator only |
| `generation/ledger.json` | Tokens, estimated cost, seconds per record and retries, computed from the stored attempts | Anyone |
| `generation/mess-report.json` | Row counts per kind of mess, identity cases and offering statuses | Anyone |

`generation/` is hidden from the enrichment pipeline and the service. It exists so that evaluation can tell a fact that was recoverable from the raw row from one that was genuinely unknowable, where the right answer is to abstain.

## How it is built

1. **Plan** (`src/dataset/plan.ts`). Seeded code decides what each slot is: studio, themes and mechanics from the closed vocabulary, facts, relations to other games, offerings, and which defects it will carry. The first 14 slots are allocated by hand to the cases the catalogue must contain; later slots are drawn from seeded distributions. A slot depends only on the seed and on earlier slots, so the pilot is a prefix of the full catalogue.
2. **Truth text** (`src/dataset/truth-writer.ts`). A model writes a title, a description and one supporting quote per planned theme and mechanic. Output is rejected, with its reason, if it is refused, cut short, malformed, quotes something that is not in the description, mentions a mechanic the plan did not assign, breaks a title rule, or uses a name that a check found to exist in the real world. Nothing is repaired: a rejected answer is stored and counted, and the next attempt is a fresh answer that is told the reason.
3. **Degradation** (`src/dataset/degrade.ts`). Seeded code turns the truth into raw rows and records what was lost. No model is involved.

The model never writes a fact of record or an availability row.

## Commands

```sh
npm install

# Rebuild everything from the committed responses. No key, no network.
npm run dataset -- --count 14

# Extend the catalogue: calls the model only for slots with no stored response.
OPENAI_API_KEY=... npm run dataset -- --count 100 --live --max-usd 2

# See what a catalogue of a given size would contain. Writes nothing.
npm run dataset -- --count 100 --plan-only
```

Rebuilding from committed responses is byte-identical on every run. A live run is not: the model is sampled, so deleting a response file and regenerating it gives different text. A request depends only on its own slot and, for a sequel or a same-name twin, on the game it relates to, so one slot can be regenerated without touching the rest. A stored response whose request no longer matches the code is refused, not reused.

## Record model

**Identity.** `payload.game_code` is the stable supplier game id, and it is the `game_id` that offerings refer to. Two raw rows that share it are the same game. A shared title is never enough: the catalogue contains two different games from different studios with the same name.

**Raw payload.** One feed shape. Only `game_code`, `name`, `provider` and `category` are always present.

| Keys | Notes |
|---|---|
| `family` | Franchise id. Present only for studios that supply it (null when they have none); absent otherwise, even when the game does belong to a family |
| `description` | Absent, null, empty, boilerplate, one sentence, German, or wrapped in markup with escaped entities |
| `features`, `themes` | Free-text tag lists with studio-specific spelling, synonyms, and entries that are not attributes at all |
| `tags` | Merchandising labels such as "New"; never a game attribute |
| `rtp`, `volatility`, `grid`, `lines`, `ways`, `max_win`, `min_bet`, `max_bet`, `release_date`, `bonus_buy` | Carried exactly as the studio formats them and never parsed downstream. RTP can hold several certified builds in one string; which build is live is a per-market fact that this catalogue does not model |

**Offerings.** `status` is one of `live`, `coming_soon`, `disabled`, `withdrawn`; only `live` is eligible. Each brand has one jurisdiction. `quarrowby` is deliberately small.

**Vocabulary.** Twelve themes and twelve mechanics, in `src/dataset/vocabulary.ts`.

## Kinds of mess

Counts are raw rows in the pilot. A row can carry several.

| Kind | Rows | What a correct pipeline does |
|---|---:|---|
| `description_missing` | 2 | Works from other evidence, or abstains |
| `description_boilerplate` | 1 | Treats filler as no evidence |
| `description_terse` | 1 | Asserts only what the sentence supports |
| `description_non_english` | 1 | Derives descriptors; leaves the source text alone |
| `description_markup` | 2 | Quotes evidence despite tags and escaped entities |
| `prompt_injection` | 1 | Treats the instruction as data; it is labelled only in the truth |
| `tags_missing` | 2 | Recovers from the description, or abstains |
| `tag_spelling_drift` | 3 | Maps synonyms and spellings onto the vocabulary |
| `tag_dropped_but_inferable` | 1 | Recovers the missing tag from the description |
| `tag_conflicts_description` | 1 | Does not copy a tag the description contradicts |
| `non_attribute_tags` | 2 | Drops them |
| `title_decoration` | 2 | Cleans the title |
| `near_empty` | 1 | Abstains on everything |
| `studio_field_gap` | 7 | Nothing to repair: the field never existed for that studio |
| `family_not_supplied` | 2 | Does not invent a family; may only suspect one |
| `same_name_different_studio` | 2 | Keeps the two games distinct |
| `supplier_id_duplicate` | 2 | Treats the two rows as one game |
| `rtp_multi_build` | 4 | Carries the string verbatim |
| `fact_format_variant` | 7 | Carries the values verbatim |
| `interacting_defects` | 2 | Three or more content defects on one row |
| clean control | 2 | Leaves the record alone |

Gaps and formats are properties of the studio, not random noise per field: one studio never sends descriptions, another never sends a themes list, another writes German copy.

## Limits

- The truth text is model-written. The pilot's 14 records were read through once after generation, not independently labelled; code checks that each quote is verbatim, not that it is good evidence.
- "Recoverable" in the truth is mechanical: a quote survived, a tag survived, or the writing model said the title states the theme. It is a diagnostic, not a reference label.
- Every studio, brand and game name was searched for on the web, and names that turned out to exist were replaced. A clean search is not a trademark clearance, and the model can coin an existing name again in a larger run, so the check has to be repeated then.
- Rates of mess are chosen to exercise the pipeline. They are not estimates of how often each defect occurs in real feeds.
