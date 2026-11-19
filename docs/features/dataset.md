# Dataset

**Status:** built. 100 games as 104 raw rows, with 170 offerings on three brands.

**Purpose.** A fictional catalogue of slot games that looks like it came from a real source system: thin, inconsistent and partly wrong, with a hidden record of what each game really is so that later stages can be scored against it. A model writes the descriptive text; seeded code decides everything else.

## Code

| Path | What it holds |
|---|---|
| `src/dataset/vocabulary.ts` | The closed vocabulary: twelve themes, twelve mechanics, and what each means |
| `src/dataset/model.ts` | The record shapes, validated wherever a record is read or written: raw record, offering, truth game, truth row, the kinds of mess |
| `src/dataset/rng.ts` | Seeded random streams, one per purpose and slot |
| `src/dataset/plan.ts` | Stage 1. Seeded code decides each game: studio, themes, mechanics, facts, relations, offerings, and the defects its rows will carry |
| `src/dataset/truth-writer.ts` | Stage 2. The model request, the validation of its answer, the stored responses and their replay, the blocked-name list |
| `src/dataset/degrade.ts` | Stage 3. Seeded code turns the truth into raw rows and records what was lost |
| `src/dataset/report.ts` | The mess report, the coverage check that refuses a catalogue lacking a required case, the cost ledger |
| `src/dataset/generate.ts` | The command that runs the three stages and writes the files |
| `src/dataset/generate.test.ts` | The tests. Each name starts with the invariant it proves |
| `tools/run-tests.ts` | What `npm test` runs. It fails when no test file is found, when a test file has no passing test, and when a name pattern matches no test |

## Data

| Path | What it is |
|---|---|
| `data/catalogue.raw.jsonl` | The raw rows. With the offerings, the only data later parts may read |
| `data/offerings.jsonl` | Availability per game and brand. `game_id` here is `payload.game_code` there |
| `data/generation/` | Hidden from the pipeline and the service: the truth, every stored model attempt (`responses/`), the retired attempts, the ledger, the mess report |
| `data/README.md` | The record model, the questions the generator had to assume an answer to, the kinds of mess with their counts, the cost, the limits |

## Commands

```sh
npm run dataset -- --count 100    # rebuild from the stored responses: no key, no network; prints the mess table
npm test                          # every test
npm test -- DS-4                  # the tests of one invariant
```

`--count` is the only thing that separates a pilot from the full catalogue. A live run that calls the model needs `--live` and `OPENAI_API_KEY`; see `data/README.md`.

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| DS-1 | Re-running the seeded degradation over the committed model responses reproduces the catalogue byte for byte | `npm test -- DS-1` | - |
| DS-2 | The model writes descriptive text only. Facts of record and availability rows are written by seeded code | `npm test -- DS-2` | - |
| DS-3 | The catalogue contains every kind of mess it is meant to, and the count for each kind is printed | `npm run -s dataset -- --count 100 && npm test -- DS-3` | - |
| DS-4 | Model output that is refused, cut short or malformed is rejected with its reason and counted. It is never repaired | `npm test -- DS-4` | - |
| DS-5 | A rebuild stops, names the cause and writes nothing when a stored response no longer matches its request, no longer passes validation, or is missing while no key is set | `npm test -- DS-5` | - |
| DS-6 | No word on the blocked-name list is in any committed data file. A rejected answer that used one is stored with the name removed | `npm test -- DS-6` | - |

What each proof does:

- **DS-1** copies the stored responses to a scratch directory, runs the generator there with no key in its environment, and compares all six written files with the committed ones byte for byte. Run in place it is `env -u OPENAI_API_KEY npm run -s dataset -- --count 100 && test -z "$(git status --porcelain -- data)"`.
- **DS-2** has two halves. The answer shape is closed, so an answer carrying a fact or an availability field is rejected. And with every description rewritten, the offerings, the truth facts and every raw key other than `name`, `description`, `features`, `themes` and `tags` come out unchanged. A description may still restate a fact in prose; the plan decides which, and those sentences are text, not the fact of record.
- **DS-3** rebuilds, which prints the table and exits non-zero if a required case is absent; then checks that the committed report passes the coverage check, that the check refuses a report with a case removed, and that `data/README.md` lists exactly the kinds in the code with the committed counts.
- **DS-4** feeds the validator refused, incomplete, malformed and rule-breaking answers, checks that each stored attempt is counted in the ledger under its outcome, and that retiring a response keeps the outcome and token counts of its attempts.
- **DS-5** breaks one stored response in a scratch copy in each of the three ways, and separately asks for a live run with no key. Each time it expects exit 1, the cause on stderr and no file written.
- **DS-6** hashes every word in every file under `data/` against the blocked list.

## Known limits

No proof covers these; `data/README.md` says more under "Names" and "Limits".

- The names were searched for and the hits replaced. That is screening, not trademark clearance, and DS-6 only shows that the names already found are absent.
- The truth text is model-written and was not independently labelled. The proofs check that each quote is verbatim, not that it is good evidence.
- The live path has only been exercised by the runs that produced the stored responses. No recorded attempt, stored or retired, is a refusal, a cut-short answer or an API error; their handling is proved on constructed responses only.
