# Break-it review of dataset PR

- Kind: brief to a new agent (opus-high)
- Sent: 2026-11-19T01:04:37.469Z

---

## Goal
Review pull request #10 in the private GitHub repository `AndriiPasternak31/because-you-played` as the fresh reviewer its own protocol calls for. You have not seen how the change was built and are not being told the author's reasoning.

## Why, and what it feeds
The pull request delivers the foundation of the product: a deliberately messy fictional catalogue of 100 slot games, with availability per brand, the hidden clean truth it was degraded from, and the generator. Enrichment, embeddings, the service and the evaluation are all built on it next, so a defect here is paid for three times. The owner alone merges and wants to do so quickly once he knows whether anything is actually broken. The repository is built by AI coding agents and will later be public, so the review record is also evidence that the protocol is real.

## What you are given
- The repository: clone it fresh into `[cut: local path]` and work only there. `gh` is authenticated. Node 24 is installed. No API key is needed: the catalogue rebuilds from stored model responses, and you must not make model calls.
- The protocol: `REVIEW.md`. Read it first. Note that pull request #9 (open) shortens the format of review records, and the owner has asked for that shorter form already: follow #9's wording for how you report.
- The task and acceptance criteria: issue #1.
- What the change must hold: `AGENTS.md`, and the invariants in `docs/features/dataset.md` as updated by this pull request.
- The commit under review: the head of pull request #10.

Running the change here means trying to make its claims false: that the catalogue rebuilds identically without a key, that bad stored responses stop the build loudly, that the model's text cannot alter facts or availability, that every kind of mess the data README lists is really present in the counts it states, that the hidden truth and the raw rows are consistent with each other in the way the README says, that the offerings join to the raw rows, that the test command cannot pass by finding nothing, and that nothing in the data or code names a real company, product or person. Decide for yourself what else can be broken; where a set is small enough, check all of it rather than a sample.

## Bar for done
1. For each acceptance criterion in issue #1 and each invariant in `docs/features/dataset.md`: either one command that shows it broken, which anyone can re-run, or a plain statement of what you tried and that it held.
2. Findings kept apart by how they were found (ran it, read it) and whether they reproduced. A concern you could not reproduce is unconfirmed and does not block.
3. Your record is on the pull request, and it is **short and plain**: the owner has said review records must not contain commit hashes, transcripts, pasted logs or lists of scripts, should use simple language, and should prefer a small diagram or chart to a paragraph. Fill the Review table in the description with one row per finding (what was found, how, reproduced or not; leave the fix column empty for the author), and add one brief comment with your verdict and, for anything broken, the single command that shows it. Keep any long output on disk in your review folder, not on GitHub.
4. A plain verdict for the owner: safe to merge as it stands, or what blocks.
5. Your final message back: the verdict, the findings with reproduced or not, and what you could not check.

## Hard rules
- Review only. Do not push commits, change files on the branch, merge, close or approve the pull request, or change anything under `[cut: local path]`.
- On GitHub you may write only the one comment and the Review section of the description; leave the rest of the description exactly as the author wrote it.
- Nothing you write on GitHub may name any company, any person, or any other project.
- Do not claim a check you did not run. Do not read the owner's secrets mount.
- End your comment with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  followed by a blank line and `https://claude.ai/code/session_01XQowzc3CQfJeVS3AdXi4Lx`
