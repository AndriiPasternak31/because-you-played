# Evaluation plan

Decided by the owner on 2026-11-19, before any evaluation result existed. The commit order is the evidence for that. Agents read this file and `eval/thresholds.json`; they do not change either.

## The two questions

1. **Is enrichment safe to automate?** Are the labels it adds right, is each one backed by a quote, and does it stay silent when a record gives it nothing?
2. **What does each step add to matching, and what does it cost?**

## The answer key

The generator's plan is the answer key (`data/generation/truth.games.jsonl` and `truth.rows.jsonl`). For each raw row and label:

| The plan says | Meaning | How it is scored |
|---|---|---|
| Recoverable | The evidence survived the damage | Enrichment should assert it. Missing it lowers recovery |
| Unknowable | The evidence was removed | Counts neither for nor against. Unknown is not wrong |
| Expected to abstain | Every label in that field is unknowable | The right output is nothing. Asserting anything is a missed abstention |
| Not assigned | The plan never gave the game this label | If enrichment asserts it, that is a disagreement, and the reviewer decides |

A label asserted on a row where the plan marks it unknowable is also a disagreement.

## The reviewer

Disagreements are decided by a second model, `gpt-6-luna`, asked one question per label in the words a person would be asked.

- Answers are stored and committed. The evaluation re-runs from the stored answers, with no key.
- A "yes" counts only if its quote appears word for word in the text that was shown. Otherwise the answer is recorded as unclear.
- Yes: the assertion is correct. No: it is wrong. Unclear: left out of precision, counted and listed.
- The question never says who made the claim, and the questions are asked in a seeded shuffled order.
- **Control.** The reviewer also answers a seeded sample of 20 labels on which the plan and the pipeline agree. Its agreement with the plan there is reported as a count.
- **Owner's check.** Six disagreement questions, drawn by seed, are answered by the owner without sight of the reviewer's answers. The report states how many of the six the reviewer matched. The owner commits those answers.

### Label question

```text
Here is the text a game supplier sent for one slot game.

"{title, description and tags exactly as delivered}"

Label: {name}. It means: {meaning}.

Does the text support this label? Answer yes, no or unclear. If yes, copy the exact words from the text that support it. Otherwise leave the quote empty.
```

Label meanings are the ones in `src/dataset/vocabulary.ts`. They are not restated here.

### Recommendation question

```text
A player has just played this slot game.

"{title, description and tags of the game played}"

Here is another game.

"{title, description and tags of the other game}"

Would the second game be a reasonable "you might also like" for that player? Answer yes, no or unclear, and name in a few words what the two games have in common, or say "nothing".
```

## Enrichment measures

Pass marks are in `eval/thresholds.json`. Every measure is reported as a count beside its rate.

| Measure | Definition |
|---|---|
| Precision | Of the labels asserted, the share that are correct: recoverable in the plan, or confirmed by the reviewer. Unclear answers and unknowable labels are left out |
| Recovery | Of the recoverable labels, the share asserted |
| Recovery without tags | The same, over recoverable labels whose evidence is only in the description or the title |
| Missed abstentions | Fields where the plan expects nothing and something was asserted |
| Invalid quotes | Asserted labels whose quote is not word for word in the record. Checked by code |

These apply to every version that asserts labels.

## Matching measures

**Related, by rule from the plan.** A win system is one of paylines, ways or cluster pays; every other mechanic is a feature.

| Grade | Rule |
|---|---|
| Strong | A shared theme and two or more shared features |
| Related | A shared theme and either one shared feature or the same win system |
| Weak | A shared theme only, or two or more shared features with no shared theme |
| Unrelated | None of the above |

- **Pairwise accuracy.** For each game, over every pair of one strong-or-related game and one unrelated game: how often the related one scores higher. Weak pairs, duplicates and members of the same family are left out. Reported pooled and as the mean per game.
- **Wrongly shown.** Six check games are drawn by seed. For each, the results the running service actually returns on the largest brand are judged. A result is wrongly shown when the rule calls it unrelated **and** the reviewer answers no to the recommendation question.

## The ladder, and what ships

Four versions of every game's text go through the same matching test, in order of cost:

1. **Raw text.** As delivered.
2. **Synonym table.** Delivered tags mapped onto the fixed labels by a plain table. No model.
3. **Model where thin.** The table, plus the model only on records the table leaves thin.
4. **Model everywhere.** The model reads every record.

- "Thin" is decided by a rule that uses only the raw record and the table's output. It is written into the code and recorded in the index before any evaluation runs.
- Results are also reported split by the condition of the record: full description, tags only, nearly empty.
- **What ships:** among the versions that pass their marks, the cheapest one whose pairwise accuracy is within the margin of the best. If none passes, the service does not start.
- The result is reported whichever way it falls. A model that does not earn its cost is a finding, not a failure.

## Rules for running it

- Every enrichment prompt version that was evaluated is recorded with its result. None is dropped. The gate applies to the last one.
- The console may show sliders that explore other pass marks against the measured numbers. They do not change this file's partner, `eval/thresholds.json`, and the release gate reads only that file.
- Real failures found are shown separately from failures injected on purpose.

## What this cannot show

- The answer key and the catalogue text come from one generator, and the reviewer is a model from the same vendor as the enrichment. Related models can share blind spots; the owner's six answers are the only outside check.
- The catalogue is easier than real supplier data. These numbers show direction and the absence of glaring failure, not production accuracy.
- "Related" here means shared structure in the plan. It is not a measure of what players go on to play.
