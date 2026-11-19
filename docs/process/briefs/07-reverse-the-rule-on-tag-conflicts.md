# Owner decision: let the model resolve tag conflicts

- Kind: follow-up to a running agent
- Sent: 2026-11-19T21:17:02.278Z

---

The owner has decided the question you left for him: on the games where a delivered tag contradicts the description, the model should be allowed to resolve the contradiction instead of the mechanics field being blanked in every version. Please make that change on `feat/pipeline`, on top of what is there.

## Why
The whole point of comparing the four versions is to show what each step adds. A contradiction between a tag and the description is exactly the case a plain table cannot settle and a reader can. Today the comparison hides that: the model read all five descriptions, followed the description each time, quoted it, and then had 17 correct labels thrown away. The owner wants the ladder to show that difference honestly, in both directions.

## What has to be true afterwards
- **The table version is unchanged on those games.** It cannot tell which side is right, so the disputed field still contributes nothing there.
- **In the two model versions, the model's labels stand** on those games, each still carrying a word-for-word quote. A label on a disputed field must be supported by the description or the title, not by the very tag list that is in dispute.
- **A conflict is a reason to call the model.** A record with a conflict counts as one the table leaves thin, so the "model where thin" version uses the model there, and its call count and cost in the ledger reflect it.
- **The record says what happened:** that there was a conflict, which delivered tag was contradicted, and that the model's reading was used. The console will show this to a person.
- **No new enrichment call is needed or allowed:** the stored answers already contain the model's reading. Only the affected embedding texts change, so only those embeddings are re-made, within the spending limit already authorised. Everything else in the index stays byte-identical, and you say which records and versions changed.
- Issue #2 has been updated to say this (the line about conflicting fields). `docs/features/pipeline.md` and `data/README.md` must describe the new behaviour and stop describing the old one.

## Bar for done
- Proofs named after their invariants that failed before and pass after, including one that fails if the table version starts trusting a disputed tag and one that fails if a model label on a disputed field is backed only by the disputed tag list.
- The keyless rebuild is byte-identical when run twice in a fresh clone; type-check and the full test run pass; the index validates.
- "Last proved" handled the way `AGENTS.md` prescribes.
- The pull request's "What changed" and checks table reflect the new head, in the short form, with this change named as a difference from the first reviewed version. Add a row to the Review table only for the reviewer's existing findings; a fresh reviewer will look at this change separately, so leave nothing marked accepted.
- Tell me exactly what the stacked service branch needs to know: which fields or values in the index changed shape or meaning.

All earlier limits apply: no merge, no push to `main`, no force-push, nothing under `eval/`, nothing naming any company or person, same commit trailer lines.
