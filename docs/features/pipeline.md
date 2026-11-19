# Pipeline

**Status:** built. 100 games from 104 raw rows, four versions of each game's text, 400 embeddings, one index.

**Purpose.** The offline steps that turn the raw catalogue into what the service reads. Code alone makes a canonical record from each game's raw rows. Four versions of the game's text are then built, embedded and written to a versioned, hashed index. Every model call in the product happens here, and every response is stored, so nothing downstream needs a key.

```mermaid
flowchart LR
  R[Raw rows] --> C[Canonical records<br/>code only]
  C --> V1[raw]
  C --> T[Synonym table] --> V2[table]
  T -->|thin records only| V3[model_where_thin]
  C --> M[Model answer<br/>one per record] --> V4[model_everywhere]
  M --> V3
  V1 & V2 & V3 & V4 --> E[Embeddings] --> I[Index]
```

## The four versions

What they are for is in [`eval/refs/evaluation-plan.md`](../../eval/refs/evaluation-plan.md): a ladder, compared rung by rung.

| Version | Text that is embedded | Model calls |
|---|---|---|
| `raw` | Title, description and the three tag lists exactly as delivered | none |
| `table` | Cleaned title and description, plus the labels the synonym table found in the tags | none |
| `model_where_thin` | The same, plus the model's labels on thin records only | thin records |
| `model_everywhere` | Cleaned title and description, plus the model's labels only | every record |

- **One stored answer per record serves both model versions.** The model is asked once per record, and the request never depends on the table. `model_where_thin` reads the answer only for thin records, and its cost on record is the cost of those calls alone.
- **Thin** (`thin-v1`, in `versions.ts` and in the manifest): the table leaves the record's themes or its mechanics without a usable label, because no delivered tag mapped to that field or because the mechanics tags are in conflict. A conflict is a reason to ask the model, so a record with one is thin even when the table filled both fields. The rule reads the raw record and the table's output and nothing else. 31 of 100 records are thin.
- **Conflict.** A delivered tag maps to one win system (paylines, ways or cluster pays) and the description names a win system but not that one. 5 records.
  - **`table`** cannot tell which side is right, so the whole mechanics field holds no label and adds nothing to the text.
  - **`model_where_thin` and `model_everywhere`** carry the model's reading: its mechanics labels quoted from the description or the title. A label backed by a tag list does not count on this field, whoever asserted it, because the tag lists are what is in dispute. The table's mechanics labels are left out for the same reason.
  - **With no reading of the text** (the model abstained, quoted only tags, or its answer was rejected) the field stays empty in the model versions too.
  - **The record says what happened**, in `conflict`: the contradicted tag, what the description states, `model_reading_used`, and any model labels held back as tag-backed.
  - In this build the model followed the description on all 5 games: 17 labels, every one quoted from the description, none held back.
- **Two win systems.** A game has one. Labels that assert two settle nothing, so the mechanics field then holds no label, in any version. No record does this in this build.
- **A field with no label adds no line to the text.** Its status says why: `abstained` or `conflict`.
- **One vector per text.** The provider does not return the same bytes for the same text twice. Left alone, the same text would sit at slightly different points in different versions, and a comparison between versions would measure that noise. So wherever a text occurs more than once, every occurrence gets the vector of the first: the earliest version on the ladder, and within it the earliest game. In this build 7 `table`, 72 `model_where_thin` and 94 `model_everywhere` vectors are ones an earlier version already had. Each version still embedded all 100 of its own texts, and the ledger charges it for that: what it would cost to build alone.

## Code

| Path | What it holds |
|---|---|
| `src/pipeline/canonical.ts` | Raw rows to canonical records. No model, and no import of anything that calls one |
| `src/pipeline/synonyms.ts` | The synonym table, and the shape of a label with its quote and provenance |
| `src/pipeline/versions.ts` | The four versions, the thin rule, the conflict rule |
| `src/pipeline/enrich.ts` | The model request, the check of its answer, the stored attempts and their replay |
| `src/pipeline/embed.ts` | The embedding request, its stored response and its replay |
| `src/pipeline/index-store.ts` | Writing the index, and `loadIndex`, which validates all of it |
| `src/pipeline/report.ts` | The ledger and the build report |
| `src/pipeline/costs.ts` | Prices, the spend limit, the HTTP call |
| `src/pipeline/io.ts` | The one way the pipeline reads a file; refuses the hidden truth directory |
| `src/pipeline/build.ts` | The command |
| `src/pipeline/pipeline.test.ts` | The tests. Each name starts with the invariant it proves |
| `prompts/enrich-v1.md` | The enrichment prompt. The vocabulary and its meanings are appended from `src/dataset/vocabulary.ts` |

## Data

| Path | What it is |
|---|---|
| `data/pipeline/responses/enrichment/<prompt version>/<game id>.json` | Every stored model attempt for one record: outcome, seconds, tokens, and the body as received. Sealed (see below) |
| `data/pipeline/responses/embeddings/<version>.json` | Every stored embedding response for one version, oldest first. Each call lists what it embedded, as game id and text hash in request order, beside the body as received. A text is looked up by that pair, so when texts change only those are sent again and every other vector keeps its bytes. Sealed |
| `data/index/` | The index. Everything the service and the console read from the pipeline |

A new prompt version gets a new directory, so the answers to an earlier prompt are kept and still counted in what was spent.

Every stored response carries `seal_sha256`: the SHA-256 of everything else in the file, set when the pipeline stores it. A file whose content no longer matches its seal, or that has none, stops the build and is named. So an edit made by hand is refused whatever it changes: which vector belongs to which game, a label in a stored answer, a token count.

## The index

| File | Contents |
|---|---|
| `manifest.json` | `format_version`, `index_hash`, the catalogue's SHA-256 and row counts, both model ids, the prompt version and the hash of the prompt as sent, `dimensions`, the version names, the thin rule, the game ids in row order, and the size and SHA-256 of every other file |
| `records.jsonl` | One line per game, sorted by game id |
| `vectors.<version>.f32` | One vector per game in the same order: 1,536 little-endian 32-bit floats each, unit length as the provider returns them. Two rows with the same text, in any versions, hold the same bytes |
| `ledger.json` | Calls, tokens, estimated cost and seconds per version, and what was spent in total. An embedding entry counts every stored call for its version, so `texts` passes the number of games once a text was embedded again |
| `report.json` | Tags mapped, dropped and unknown; each conflict with how many model labels were used and held back; thin records; model answers by outcome; labels stripped by reason; per version, how many vectors were taken from an earlier occurrence of the same text |

`index_hash` is the SHA-256 of the manifest without that key. It changes when anything in the index does, so it names one index.

One record holds:

- `canonical`: the game as code alone reads it from the raw rows. Title, description (cleaned, and as delivered), provider, family, the two attribute tag lists and the merchandising list verbatim, the facts verbatim, and which raw row it came from.
- `evidence`: `description`, `tags_only` or `none`. `none` means no description and no tag the table maps: the record is too thin to use, and the service is expected to decline on it.
- `table`: the table's labels, the tags it dropped and the tags it did not know.
- `conflict`: null, or the contradicted `tag`, the win system it asserts (`tag_asserts`), what the description states (`description_states`, `description_quote`), `model_reading_used` (true when the two model versions carry the model's reading; false leaves the field empty in every version) and `model_labels_withheld` (the model's mechanics labels that were backed by a tag list).
- `thin`: the thin rule applied to this record.
- `model`: the model's checked labels for this record, and what was stripped from its answer and why.
- `versions.<version>`: the `text` that was embedded, and for every version but `raw` the `themes` and `mechanics` fields. Each label carries `quote`, `source_field` (`title`, `description`, `features` or `themes`), `method` (`synonym_table` or `model`), and for a model label the `model` and `prompt_version`.

To load it:

```ts
import { loadIndex } from "./src/pipeline/index-store.ts";

const index = loadIndex("data/index", { cataloguePath: "data/catalogue.raw.jsonl" });
const row = index.manifest.game_ids.indexOf("ulv-17288");
const record = index.records[row];
const vector = index.vectors.table.subarray(row * 1536, (row + 1) * 1536);
```

`loadIndex` is the only way in. It throws unless every check of PL-4 passes, and with `cataloguePath` unless the index was built from that file. Availability is not in the index: it is read from `data/offerings.jsonl`, whose `game_id` is the record's `game_id`.

## Commands

```sh
npm run pipeline                                     # rebuild the index from the stored responses: no key, no network
npm run pipeline -- --validate                       # load the committed index and check all of it
OPENAI_API_KEY=... npm run pipeline -- --live        # also call the models where no response is stored
OPENAI_API_KEY=... npm run pipeline -- --live --limit 5   # enrich five records and print the answers; writes no index
npm test -- "PL-4:"                                  # the tests of one invariant
```

A live run stops before any call that could take the total past `--max-usd` (default 2.50). The total starts from what the stored responses already cost, so the limit holds across runs.

## Record model: the open questions, answered

`data/README.md` lists what the catalogue had to assume. The pipeline's answers:

| Question | Answer | Where |
|---|---|---|
| What mints `game_id`? | The supplier game code, confirmed. Two rows with one code are one game | `canonical.ts` |
| How are the three tag lists carried? | **Changed.** `features` and `themes` stay two lists, verbatim and in delivered order, because a label's provenance names the list its tag came from. Merchandising `tags` are kept apart and never looked up | `canonical.ts`, `synonyms.ts` |
| Do quotes match the raw or the cleaned description? | The cleaned one, confirmed. The model is shown the cleaned text, and the index stores it, so a quote can be found and shown. Table quotes are whole tags as delivered | `enrich.ts` |
| Which row of a duplicate wins? | The later `fetched_at`, confirmed. The other row's id is recorded. Two rows fetched at the same time stop the build | `canonical.ts` |
| What is the cleaned title? | The delivered title without trademark signs and with spaces collapsed. Case is left alone | `canonical.ts` |
| Is a family inferred? | No, confirmed. `family_id` is what the feed supplied, or null | `canonical.ts` |
| What does a missing description mean? | Absent, null, empty and blank all mean no description, confirmed | `canonical.ts` |
| A non-English description? | Kept as delivered, confirmed. Labels are vocabulary terms and a quote is in the language of the text | `prompts/enrich-v1.md` |
| Do facts in a description count? | They are left in the text, confirmed. The facts of record are separate and never parsed | `canonical.ts` |
| When is a record too thin to use? | **Changed.** When it has no description and no tag the table maps: `evidence: none`, 7 records, not only the 4 near-empty rows. It is still indexed; declining is the service's decision | `versions.ts` |
| Is a tag that contradicts a raw fact a conflict? | No, confirmed. Facts are never read. Only a win-system tag that the description contradicts is a conflict. The table then says nothing for that field, and the model versions carry what the model quoted from the text | `versions.ts` |

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| PL-1 | Canonical facts are written by code only. A model answer has no place for a fact or an availability status, and one that carries either is rejected whole | `npm test -- "PL-1:"` | - |
| PL-2 | Every label is a term of its field's vocabulary and carries a quote found word for word in the field it names, as whole words, with its provenance. Anything else is stripped and counted | `npm test -- "PL-2:"` | - |
| PL-3 | A refusal, a cut-short answer, malformed output and an API error are each rejected and counted under their own name. None is repaired | `npm test -- "PL-3:"` | - |
| PL-4 | The index carries its version, model ids, prompt version, dimensions, catalogue hash and thin rule. Loading fails on a non-finite value, a wrong dimension, misaligned ids, a hash mismatch, an altered quote, a disputed field that trusts a tag, one text with two vectors, or another catalogue | `npm test -- "PL-4:"` | - |
| PL-5 | The synonym table maps delivered tags onto the 24 labels by lookup. Non-attribute and merchandising tags are dropped. A tag it does not know is counted and listed, never guessed | `npm test -- "PL-5:"` | - |
| PL-6 | The model's answers do not reach the `raw` or `table` version, and reach `model_where_thin` on thin records only. A conflict makes a record thin. The thin rule is recorded in the index | `npm test -- "PL-6:"` | - |
| PL-7 | Where a delivered tag contradicts the description, the `table` version adds nothing for that field. The two model versions carry only the model's labels quoted from the description or the title, never one backed by a tag list, and the record says the model's reading was used | `npm test -- "PL-7:"` | - |
| PL-8 | All four versions of every game have an embedding of 1,536 dimensions from the same model. The same text has the same vector wherever it occurs. When a text changes, only that text is embedded again | `npm test -- "PL-8:"` | - |
| PL-9 | Rebuilding with no key over the stored responses reproduces the committed index byte for byte | `npm test -- "PL-9:"` | - |
| PL-10 | The pipeline never reads the hidden truth directory | `npm test -- "PL-10:"` | - |
| PL-11 | A stored response that is stale, damaged, missing or edited by hand stops the rebuild, names the file and writes nothing | `npm test -- "PL-11:"` | - |
| PL-12 | The ledger reports calls, tokens, estimated cost and seconds per version, and a live run stops before the call that could pass the spend limit | `npm test -- "PL-12:"` | - |

The colon in the pattern matters: without it `PL-1` also matches PL-10 to PL-12.

What each proof does:

- **PL-1** sends answers carrying `rtp`, a `facts` object, a `status` inside a label and an `availability` list, and expects each rejected whole; it checks that the schema sent to the model is closed to two keys. It rebuilds the index and compares every canonical record with what the canonicaliser alone makes of the raw rows, and every fact with the delivered value.
- **PL-2** answers with a label outside the list, a mechanic in the themes field, an invented quote, real words attributed to the wrong field, part of a tag, an empty quote and a repeated label, and expects each stripped under its reason and counted. It takes quotes that start or end inside a word, such as "ri" from "riddles", and expects each refused, beside whole-word quotes at the start, the end and before punctuation that must pass. It then re-checks every label of the rebuilt index with its own whole-word test, not the pipeline's.
- **PL-3** feeds a refusal, a cut-short answer and nine malformed answers that a lenient reader could have fixed. Through a transport that needs no network it plays a server error, a refusal and a cut-short answer for one record, and checks the three stored attempts, their counts, and that the record ends with no labels; then an error a retry cannot cure, and one that keeps coming.
- **PL-4** corrupts a copy of the index thirteen ways, among them a quote cut to a piece of a word, a disputed tag put back into the table version, a model label on a disputed field backed by the disputed tag, and one text given two vectors. For the faults a file hash would catch first, it brings the hashes up to date so that the deeper check has to catch them.
- **PL-5** runs the table over tags it knows, near-misses, non-attributes and merchandising labels, and checks that all 24 labels are reachable and that every delivered tag is accounted for.
- **PL-6** builds every record twice, with no model labels and with loud ones, and compares the versions; then checks every record of the rebuilt index against the rule restated in the test, and that every record in conflict is thin.
- **PL-7** builds one record with and without the contradiction: the control shows the delivered tags do reach the table version otherwise; with it, the table version carries nothing for the field and both model versions carry exactly the model's text-backed labels, with the tag-backed one held back and listed. It then gives the model only tag-backed labels, no labels, and two win systems, and expects the field to stay empty each time. Over the rebuilt index it works out each disputed field from the model's checked answer alone and compares.
- **PL-8** works out, from the stored responses alone, the vector each text should have (the answer of the first version on the ladder to embed it) and compares every row of the rebuilt index with it; it checks that every version did embed each of its own texts. It groups all 400 rows by text and expects one vector per group. It breaks a stored response three ways. Through the network-free transport it embeds three texts, changes one, and checks that only that one is sent, that the other two keep their bytes, that one game's stored vector is never handed to another, and that two stored vectors for one text are refused.
- **PL-9** copies the catalogue and the stored responses to a scratch directory, runs the build there twice with no key in its environment, and compares all eight files with the committed ones.
- **PL-10** runs the build in a tree that has no `generation` directory at all and gets the committed manifest, and checks that the reader refuses a path inside the real one.
- **PL-11** breaks a scratch copy six ways: a changed record, a cut-short file, an answer edited to carry a fact, a missing answer, a stored embedding of another text for one game, missing embeddings. Where the break is an edit of a stored file it is sealed again, so that the deeper check has to catch it. A second proof edits stored files the way a person would, leaving the seal alone: two games swapped in the list of what was embedded, two vectors swapped in a body, a model answer changed into another that would pass every check, a token count, the seal removed. Each must be refused with the file named.
- **PL-12** adds up the stored responses itself and compares with the ledger of a rebuild; then runs a live build through the network-free transport under a limit it cannot fit in, and checks where it stopped, what it kept, and that the key it was given is in no file.

Each proof was also checked the other way: 27 one-line breaks of the pipeline code were tried, one at a time, to see the matching proof fail. 25 failed at once. One did not, because the proof read the committed index instead of running the code; the proofs over the whole index now rebuild it first. The other was a badly made break that showed only on some runs; made to show on every run, it fails PL-9.

A fresh review then found a fault none of those breaks had: the quote check was a substring test, so it took a piece of a word for a quote. No stored label was affected and the index did not change. The check now requires whole words, and PL-2 and PL-4 fail without that.

The change that lets the model's reading stand on a conflict was checked the same way: 16 breaks, 15 of them red. The other, making an earlier embedding call win over a later one, could not turn anything red because nothing depended on it: a stored text is never sent again. The comment that claimed otherwise is gone, and two stored vectors for one text are now refused.

A second review found two faults older than that change: the same text had slightly different vectors in different versions, and a stored embedding file edited by hand was accepted. Both now have proofs that failed before; 10 breaks of the two fixes all turned a proof red.

## Known limits

- **No bad output came back in the live run.** All 100 answers were accepted and no label was stripped. The handling of a refusal, a cut-short answer, malformed output, a label outside the list, an invented quote and an API error is proved on constructed responses only.
- **A verbatim quote is not a good quote.** Code checks that the words are in the field as whole words, not that they support the label. Whether the labels are right is the evaluation's question. On a conflict this cuts deepest: a model label for the win system the tag claims, quoted from description words that name another one, would stand. None of the 5 does.
- **The conflict rule cannot be seen to lose here.** In all 5 planted conflicts the description is right and the tag is wrong, by how the catalogue was made. What trusting the text costs where the tag is the right one is not measured.
- **The synonym table was written against this catalogue's tags.** It knows all 105 spellings here, so nothing is unknown in this build. A new feed will bring spellings it does not know.
- **The conflict rule reads English only**, by phrase. A contradiction in one of the five German descriptions is not seen by it. If the model then reads a second win system out of such a text on a thin record, `model_where_thin` holds two win systems and its mechanics field is emptied; that does not happen in this build.
- **`raw` is exempt from the conflict rule.** It is the delivered text, contradiction included; it has no descriptor fields.
- **On a conflict the table version loses the whole mechanics field**, including delivered tags that were not in dispute. That is the price of not guessing which side is right without a model.
- **A replaced embedding stays stored.** The ten vectors of the texts that changed are still in the first stored calls and are still counted in what was spent. They are not in the index.
- **A version is charged for vectors it does not use.** Each version embeds all its texts, and the index then takes the earlier version's vector where the text is the same. The ledger shows what each version costs alone, not the least that all four could have cost together.
- **The seal sits in the file it seals.** It refuses an edit that leaves the seal as it was. Someone who edits a stored response and recomputes the seal is not caught; version control is the record of that.
- **Boilerplate is not detected.** A filler description counts as a description, in the text and in `evidence`.
- **Costs are estimates:** reported tokens at list price, read on the date recorded in `ledger.json`. Seconds are call durations added up; calls ran eight at a time, so they are not time on the clock.
- **A failed embedding call leaves no record.** It reports no usage and costs nothing, but it is not counted.
- **The hidden-truth guard matches a directory name.** A checkout under a directory called `generation` would be refused in full.
