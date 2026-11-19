# Catalogue data

A fictional catalogue of online slot games, built to look like something a real source system delivered: thin, inconsistent and partly wrong.

100 games as 104 raw rows, with 170 offerings across three brands.

**All names are invented.** Every game, studio and brand in this catalogue was made up for it, and any resemblance to a real game, studio, operator, brand or person is coincidental. The names were searched for on the web and those found to belong to something real were replaced, but a search is not a trademark clearance.

## What is here

| Path | What it is | Who may read it |
|---|---|---|
| `catalogue.raw.jsonl` | One raw record per line: an envelope (`source_system`, `source_record_id`, `fetched_at`) around the `payload` the feed delivered | Everything |
| `offerings.jsonl` | Availability: one line per game and brand, with `jurisdiction` and `status` | Everything |
| `generation/truth.games.jsonl` | What each game really is: themes, mechanics, facts, setting, full description, family and name relations | Generator and evaluation only |
| `generation/truth.rows.jsonl` | Per raw row: which defects were applied, and which themes and mechanics can still be supported from that row | Generator and evaluation only |
| `generation/responses/` | Every stored model attempt behind the truth text | Generator only |
| `generation/retired-attempts.jsonl` | Accounting for attempts whose responses were later replaced: outcome, time and tokens, without bodies | Anyone |
| `generation/ledger.json` | Tokens, estimated cost, seconds per record and retries, computed from the two files above | Anyone |
| `generation/mess-report.json` | Row counts per kind of mess, identity cases and offering statuses | Anyone |

`generation/` is hidden from the enrichment pipeline and the service. It exists so that evaluation can tell a fact that was recoverable from the raw row from one that was genuinely unknowable, where the right answer is to abstain.

## How it is built

1. **Plan** (`src/dataset/plan.ts`). Seeded code decides what each slot is: studio, themes and mechanics from the closed vocabulary, facts, the setting and title pattern, relations to other games, offerings, and which defects it will carry. The first 14 slots are allocated by hand to the cases the catalogue must contain; later slots are drawn from seeded distributions. A slot depends only on the seed and on earlier slots, so a smaller count gives a prefix of the same catalogue.
2. **Truth text** (`src/dataset/truth-writer.ts`). A model writes a title, a description and one supporting quote per planned theme and mechanic. Output is rejected, with its reason, if it is refused, cut short, malformed, quotes something that is not in the description, mentions a mechanic the plan did not assign, states a number or a volatility the brief did not supply, breaks a title rule, or uses a name on the blocked list. Nothing is repaired: a rejected answer is stored and counted, and the next attempt is a fresh answer that is told the reason.
3. **Degradation** (`src/dataset/degrade.ts`). Seeded code turns the truth into raw rows and records what was lost. No model is involved.

The model never writes a fact of record or an availability row.

## Commands

```sh
npm install

# Rebuild everything from the committed responses. No key, no network.
npm run dataset -- --count 100

# Call the model for any slot that has no stored response.
OPENAI_API_KEY=... npm run dataset -- --count 100 --live --max-usd 2

# See what a catalogue of a given size would contain. Writes nothing.
npm run dataset -- --count 100 --plan-only

# Replace a game: drop its stored responses, keep what they cost, then run --live again.
npm run dataset -- --count 100 --retire 41,57 --retire-reason name_replacement

# Print the blocked-list entry for a name that turned out to exist.
npm run dataset -- --name-hash Word

# Prove the rebuild is byte-identical, in a scratch directory. The invariants are in docs/features/dataset.md.
npm test -- DS-1
```

Rebuilding from committed responses is byte-identical on every run. A live run is not: the model is sampled, so a regenerated slot gets different text. A request depends only on its own slot and, for a sequel or a same-name twin, on the game it relates to, so one slot can be replaced without touching the rest; `--retire` also retires those dependants. A stored response whose request no longer matches the code is refused, not reused.

## Names

- **Checking.** Titles are checked in batches after a run. A name found to belong to an existing game, studio, gambling brand, or a character or place in commercial fiction is added to the blocked list, and its slot is retired and regenerated. Generic phrases and real place names are accepted.
- **The blocked list is stored as hashes** (`BLOCKED_NAME_HASHES` in `truth-writer.ts`), so this repository does not publish the names it avoids. It matches single words, case-insensitively.
- **Rejected answers that used a blocked name are stored redacted.** The name is replaced with `[name withheld]` in the stored body, the stored reason says a blocked name was used without saying which, and the attempt is marked `body_redacted: true`. Its outcome, time and token counts are untouched, so the ledger still counts it. The accepted answer is never altered.

## Record model

**Raw payload.** One feed shape. Only `game_code`, `name`, `provider` and `category` are always present.

| Keys | Notes |
|---|---|
| `family` | Franchise id. Present only for studios that supply it (null when they have none); absent otherwise, even when the game does belong to a family |
| `description` | Full, boilerplate, one sentence, German, wrapped in markup with escaped entities, or missing. Missing comes in three forms: the key is absent (17 rows), null (14) or an empty string (9) |
| `features`, `themes` | Free-text tag lists with studio-specific spelling, synonyms, and entries that are not attributes at all |
| `tags` | Merchandising labels such as "New"; never a game attribute |
| `rtp`, `volatility`, `grid`, `lines`, `ways`, `max_win`, `min_bet`, `max_bet`, `release_date`, `bonus_buy` | Carried exactly as the studio formats them and never parsed downstream. RTP can hold several certified builds in one string; which build is live is a per-market fact that this catalogue does not model |

**Offerings.** `status` is one of `live`, `coming_soon`, `disabled`, `withdrawn`; only `live` is eligible. Each brand has one jurisdiction. `quarrowby` is deliberately small: 8 live games.

**Vocabulary.** Twelve themes and twelve mechanics, in `src/dataset/vocabulary.ts`.

### Open questions, and the answer this catalogue assumes

The generator had to pick an answer to each of these. None is settled; the enrichment work should confirm or change them on purpose.

| Question | Assumed here | What depends on it |
|---|---|---|
| What mints `game_id`? | The supplier game code, `payload.game_code`. Codes carry a studio prefix and are unique across the feed. Offerings refer to it | Joining offerings to games without the truth; two rows with the same code are one game |
| How are the three source tag lists carried? | As three separate payload keys: `features`, `themes` and `tags`. Nothing merges them. A canonical `source_tags[]` would be `features` then `themes`, verbatim, with merchandising `tags` kept apart | Merging all three loses the only signal that separates merchandising labels from attributes |
| Do evidence spans match the raw description or a cleaned one? | A cleaned one. For the 9 rows with markup, "recoverable from the description" in the truth was computed after removing `<p>` tags and decoding `&amp;`, `&#39;` and `&quot;`. For every other row raw and cleaned are the same text | If spans must be substrings of the raw field, a quote that crosses a paragraph break or an escaped apostrophe is invalid on those rows |
| Which row of a true duplicate wins? | The later `fetched_at`. The two rows differ only in title decoration and tag spelling, so both should enrich to the same tags | 4 duplicate pairs |
| What is the cleaned title? | The delivered title without ™. The 4 upper-cased titles cannot be restored to their original case | Display, and matching a title to its family |
| Is a family inferred when the feed does not supply one? | No. `family_id` is null for those rows, and a "Deluxe", "2" or "Winter Edition" suffix is at most a suspicion | 10 rows belong to a family the feed does not state; the truth has the real family |
| What does a missing description mean? | Absent key, null and empty string all mean "no description" | 40 rows |
| What is done with a non-English description? | The source text is kept as delivered; descriptors are still vocabulary terms, and a quote is in the language of the text | 5 German rows |
| Do facts in a description count? | They are left in. 43 of the 100 truth descriptions state volatility and maximum win, by design | Embedding text carries them even though the canonical model excludes them |
| When is a record too thin to use? | Only the 4 near-empty rows. A row with boilerplate or no description but usable tags counts as usable | The decline path for insufficient data |
| Is a tag that contradicts a raw fact a conflict? | No. "High Volatility" in a tag list is a non-attribute whatever the `volatility` field says. Only a win-system tag that contradicts the description is recorded as a conflict (5 rows) | The conflict status of a field |

## Kinds of mess

Counts are raw rows. A row can carry several.

| Kind | Rows | What a correct pipeline does |
|---|---:|---|
| `description_missing` | 40 | Works from other evidence, or abstains |
| `description_boilerplate` | 16 | Treats filler as no evidence |
| `description_terse` | 7 | Asserts only what the sentence supports |
| `description_non_english` | 5 | Derives descriptors; leaves the source text alone |
| `description_markup` | 9 | Quotes evidence despite tags and escaped entities |
| `prompt_injection` | 1 | Treats the instruction as data; it is labelled only in the truth |
| `tags_missing` | 13 | Recovers from the description, or abstains |
| `tag_spelling_drift` | 43 | Maps synonyms and spellings onto the vocabulary |
| `tag_dropped_but_inferable` | 4 | Recovers the missing tag from the description |
| `tag_conflicts_description` | 5 | Does not copy a tag the description contradicts |
| `non_attribute_tags` | 23 | Drops them |
| `title_decoration` | 16 | Cleans the title |
| `near_empty` | 4 | Abstains |
| `studio_field_gap` | 65 | Nothing to repair: the field never existed for that studio |
| `family_not_supplied` | 10 | Does not invent a family; may only suspect one |
| `same_name_different_studio` | 7 | Keeps the games distinct |
| `supplier_id_duplicate` | 8 | Treats the two rows as one game |
| `rtp_multi_build` | 11 | Carries the string verbatim |
| `fact_format_variant` | 67 | Carries the values verbatim |
| `interacting_defects` | 23 | Three or more content defects on one row |
| clean control | 6 | Leaves the record alone |

Identity cases: 9 families with 18 members, 3 same-name pairs from different studios, 4 true duplicate pairs.

Gaps and formats are properties of the studio, not random noise per field: one studio never sends descriptions, another never sends a themes list, another writes German copy.

## Cost

`generation/ledger.json` separates what the stored responses cost (`cost_usd.committed_run`) from what was spent on responses that were later replaced (`cost_usd.retired_attempts`, split into prompt revisions and name replacement), and gives their sum as `cost_usd.total_spent`. Costs are estimates: reported tokens multiplied by the list price recorded in the ledger.

## Limits

- The truth text is model-written. A sample was read after generation; it was not independently labelled. Code checks that each quote is verbatim, not that it is good evidence, and it cannot check that a description avoids themes the plan did not assign. Numbers in the copy are checked against the facts only where they are written in digits.
- "Recoverable" in the truth is mechanical: a quote survived, a tag survived, or the writing model said the title states the theme. It is a diagnostic, not a reference label.
- Descriptions are easier than real supplier copy: they state every planned mechanic plainly, and one model wrote all of them.
- Rates of mess are chosen to exercise the pipeline. They are not estimates of how often each defect occurs in real feeds.
- The catalogue is slots only, from one feed shape, with one jurisdiction per brand.
