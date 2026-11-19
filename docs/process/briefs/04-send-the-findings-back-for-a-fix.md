# Fix the reviewer's findings on PR #10

- Kind: follow-up to a running agent
- Sent: 2026-11-19T01:18:07.913Z

---

The fresh reviewer has finished with pull request #10. Its findings are in the Review table of the description and in one comment on the pull request; read both first. The data itself held up: the reviewer recounted every kind of mess from the raw rows independently and everything matched. Four findings reproduced.

## What needs to change, and why
- **A (blocks under the protocol).** When a stored response file or a line of the retired-attempts file is damaged, the build stops and writes nothing, which is right, but the error does not say which file or line is broken. The repository's rule is that a failure names its cause, and with 100 response files an unnamed parse error costs the next person real time.
- **B.** The proof for the invariant that the model's text cannot move facts or offerings stays green when a fact is made to depend on the title or on the description's length, because its rewrite barely changes the text. Today the byte-identical rebuild catches such a dependency, but after any regeneration nothing would. A proof has to fail when the thing it proves is broken.
- **C.** The copy check can be passed by describing volatility in other words (for example "low-variance" for a high-volatility game). No committed description does this. Close it if that is cheap and does not disturb the committed data; otherwise state it as a known limit where the part's invariants are documented.
- **D is the owner's decision, not yours.** Leave the model and provider names in the data and code as they are.

## Bar for done
- For A and B, a check that failed before your change and passes after it, run on the new head.
- The keyless rebuild is still byte-identical to the committed data, and type-check and the full test run pass on the new head.
- `docs/features/dataset.md` stays truthful, with "last proved" handled the way `AGENTS.md` prescribes.
- In the pull request, the Fix column of the Review table is filled in plain words for what you fixed, and the checks table reflects the new head. Keep the description in the short form: no hashes, logs or transcripts. Leave the reviewer's comment untouched and do not mark anything accepted.

All earlier limits apply: no merge, no push to `main`, no force-push, no model calls, nothing naming any company or person, same commit trailer lines.

Final report: what changed for each finding, what you ran with results, and what is left for the owner.
