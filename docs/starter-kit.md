# The reusable artifact: an agent starter kit

Nine pieces a new repository copies before any product code exists, so that coding agents start under the same discipline this build ran on. They are the first commit after the empty repository: 241 lines in 13 files (piece 6 is four files, piece 8 is two), with no code beyond one shell script.

## What it is

| # | Piece | File | What it settles |
|---|---|---|---|
| 1 | Working rules | [`AGENTS.md`](../AGENTS.md) | What "done" means, what a test is, the product rules, what only the owner decides, where each kind of state lives |
| 2 | Import for the coding agent | [`CLAUDE.md`](../CLAUDE.md) | One line, so there is one set of rules and not two |
| 3 | Agent permissions | [`.claude/settings.json`](../.claude/settings.json) | Denies edits to the owner's files, a force-push and a push that names `main` |
| 4 | Pull-request template | [`.github/pull_request_template.md`](../.github/pull_request_template.md) | Evidence as a table: what must be true, the command, the result. What was not verified. The review record |
| 5 | Review protocol | [`REVIEW.md`](../REVIEW.md) | A review is an attempt to break the change by running it. A finding with no reproduction does not block |
| 6 | One file per part | [`docs/features/`](features/) | Each promise a part makes, the command that proves it, and the commit it was last proved on |
| 7 | Lessons | [`LEARNINGS.md`](../LEARNINGS.md) | One line per class of mistake, with the check that now catches it |
| 8 | Ignore rules and environment example | [`.gitignore`](../.gitignore), [`.env.example`](../.env.example) | Worktrees and scratch stay out; the key has a name and no value |
| 9 | Secret scan | [`tools/secret-scan.sh`](../tools/secret-scan.sh) | Run before every push that opens or updates a pull request. Fails when it could not scan |

## Why it has this shape

- **It is what the build needed in order to start, and no more.** Rules an agent cannot misread, a place for evidence, a way to review by breaking, and predictable homes for state. The first proposal was 37 items with checking tools of their own; the [README](../README.md#one-ai-output-that-was-rejected) tells that story.
- **Process is added only when the build shows the need.** One thing was added later: the shorter pull-request format (#9), after the first descriptions proved too long to scan.
- **Plain files, no framework.** Markdown, one JSON file and one shell script. Nothing to install, and any coding agent that reads a rules file can use it.
- **A promise is tied to a command.** Each part file pairs every invariant with the command that proves it and the commit it last passed on, so "is this still true?" has one answer and it is a run, not a reading.
- **It says what it does not enforce.** The permission file stops the file-editing tools, not a program that writes the file itself. There is no continuous integration, and nothing checks that the template was filled in. [`AGENTS.md`](../AGENTS.md#what-is-the-owners) and [`docs/development-workflow.md`](development-workflow.md#what-is-not-in-place) list these gaps.

## How it applies to the next prototype

1. Copy the nine pieces into the empty repository.
2. In `AGENTS.md`, replace three things: the product rules, the owner's paths, and the commands. Everything else carries over as it stands.
3. Point the two deny rules in `.claude/settings.json` at the new owner's paths.
4. Write one file under `docs/features/` per planned part, with its status as "planned" and its invariants with `-` for last proved.
5. Open the first issue. From there the loop is the one in [`docs/development-workflow.md`](development-workflow.md): brief, build, evidence, break-it review, owner's decision, squash merge.

Step 2 is where the time goes. The product rules are the part worth it: they are the three sentences every later review is held against.

## What it produced here

The review record up to this note, taken from the Review tables of #8, #10, #11 and #12. #9 was merged without a review.

| Pull request | Findings | Found by running | Found by reading | Reproduced as a failure | What happened |
|---|---|---|---|---|---|
| #8 documents | 8 | 1 | 7 | 2 | All 8 led to a change |
| #10 catalogue | 4 | 3 | 1 | 4 | 2 fixed, 1 partly fixed and written down as a limit, 1 left as it was, the owner's call |
| #11 pipeline | 6 | 5 | 1 | 3 | 3 fixed, 1 reversed by the owner's decision, 2 written down as limits |
| #12 service, evaluation, console | 6 | 4 | 2 | 4 | 4 fixed, 2 of them minor. 1 wording corrected. 1 answered by keeping every evaluation run on record |
| **All** | **24** | **13** | **11** | **13** | |

| How it was found | Findings | A failure anyone can reproduce | No failure shown |
|---|---|---|---|
| Ran it | 13 | 11 | 2 |
| Read it | 11 | 2 | 9 |

- **Of 13 findings made by running the change, 11 were failures anyone could reproduce.** The other 2 showed the code doing what its documents said; the owner reversed one of those rules anyway.
- **Of 11 made by reading, 2 were.** Both were then confirmed by a search or a count. The other 9 could not be shown by a command, or were about wording; most still led to an edit.
- **Among the reproduced ones:** evidence that did not run from a fresh clone; a proof that stayed green with its invariant broken; an error that did not name the broken file; a quote check that took a piece of a word for a quote; a stored response edited by hand and accepted silently; the same text given slightly different vectors in different versions, which would have added noise to the one comparison the project exists to show; a report that gave away reviewer answers it marked as withheld; a service that served a version its own report said had failed, once the verdict file was edited by hand.
- **In #10, #11 and #12 the fixes came with new proofs**, named in those Review tables, and the classes of mistake are in [`LEARNINGS.md`](../LEARNINGS.md).

**How far this goes.** It is a log of what review produced on four pull requests. No reading-only review was run beside it, the builders and the reviewers were models of one family, and 24 findings are few. It shows that the protocol found real faults here. It does not compare review methods.
