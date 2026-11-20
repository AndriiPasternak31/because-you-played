# Second opinion: the page's layout

A model from another vendor was asked to criticise the proposed new layout of the page, after the owner rejected the first one. The [README](../../README.md#one-ai-output-that-was-rejected) tells why. This file holds the prompt as sent and the answer as it came back, both unedited.

| | |
|---|---|
| Sent | 19 November 2026, 22:18 GMT |
| Through | OpenAI's Codex command-line tool, version 0.160.0 |
| Model | `gpt-6-astra`, at high reasoning effort |
| What it could see | The prompt and one screenshot of the old page, from a folder holding nothing else, with a read-only sandbox |

The screenshot is not included. It showed the page as #12 merged it, for one game on the largest brand.

## The prompt

> You are reviewing the layout of one web page, shown in the attached screenshot, for a small demo of a 'related games' recommender. Technical reviewers will give it about two minutes and must come away knowing what the system recommended, why, what a language model added to thin catalogue records, and whether the model was worth its cost. The owner finds the current page unintuitive and overloaded. The proposed fix is to reorder it as four questions answered in turn (what does it do; why these games; what did the model add; was it worth it), with the recommendations first, a five-step flow of counts from catalogue to result, evidence behind a 'show details' control, and one-click example scenarios. Criticise this proposal: say what is wrong or missing in it, what you would cut or reorder, and what a sceptical engineer would still not understand in the first ten seconds; answer as a ranked list of at most seven concrete changes, most important first, in plain language. Do not read or run anything on this machine; judge only the screenshot and this description.

## The answer

1. **Make the first screen answer the question, not introduce four more questions.** “Recommendations first” still risks showing five unfamiliar game names. A sceptical engineer needs to see: “Given Lions of Eshavari on tavrenmoor, we return five related games available on that brand,” followed by the results and a short reason for each. The current title, “Because you played,” does not explain what this demo proves.

2. **Move the model’s value beside the results.** “Was it worth it?” is the decision reviewers came to make; putting it fourth risks losing it below the fold again. Show the same request with and without model enrichment, with changed recommendations highlighted. Include measured quality improvement and cost—or state plainly that improvement has not yet been established. Different results alone do not mean better results.

3. **Separate “why these games?” from “why these labels?”** The screenshot shows evidence for assigning *Animals*, *Free spins*, and other labels to the source game. That does not explain why Jen vai the Lion Dancer ranks first. Each recommendation needs a concrete connection to the source game, with evidence from both records. If the ranking cannot attribute its score to particular features, describe those connections as supporting evidence, not a proven explanation of the score.

4. **Show one model contribution before asking anyone to open details.** Use a compact before/after: “Structured themes and mechanics: empty → model extracted Animals, Ways, Free spins, Multipliers, Cascading reels from the description.” Keep one quoted phrase visible. This makes clear that the model supplied missing structure from existing text; reviewers should not have to inspect the raw record to discover that.

5. **Demote the count flow; distinguish eligibility, relevance, and the output limit.** A five-step pipeline is still an implementation tour if it appears before the useful evidence. Here, 100 catalogue entries become 72 scored candidates, six clear the similarity floor, and five are returned. Explain why the sixth is omitted. Also explain that the displayed floor comes from a score distribution; it is not, by itself, evidence that users find the results relevant.

6. **Replace one generic “show details” control with specific ones.** Cut the full raw record, complete score table, and removal lists from the main reading path. Use controls such as “See extracted-label evidence,” “See excluded games,” and “See all scores.” Keep the active index version and any limitations affecting the conclusion visible.

7. **Make example scenarios test claims, including failure.** Offer “Missing labels,” “Already well described,” and “No strong matches,” with a one-line statement of what each demonstrates. Include a case where the model adds little or gets something wrong. Otherwise, one-click examples merely make a curated success easier to replay.

## What was done with it

Point 3 is the one the README quotes: a quote shows that a label belongs to a game, and does not explain why another game ranks first. What the page became is in [`docs/features/interface.md`](../features/interface.md) and its pull request, #14. This file makes no claim about which of the seven points were taken.
