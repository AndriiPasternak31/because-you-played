# Build service, evaluation, console

- Kind: brief to a new agent (general-purpose)
- Sent: 2026-11-19T20:55:18.463Z

---

## Goal
Deliver issue #3 of the private GitHub repository `AndriiPasternak31/because-you-played` as a pull request: the service that answers "related games" for one game on one brand, the evaluation that decides which version of the index may be served, and the console that shows both. Your worktree is ready at `[cut: local path]` on branch `feat/service`. Read issue #3 first; it holds the acceptance criteria.

## Why, and what it feeds
This is a take-home build [cut: the role applied for], due tomorrow morning. It will be made public, and the people judging it weigh how the work is run and evaluated as heavily as the product. Issue #3 is where the project's argument becomes visible: a reviewer should be able to start it with no API key, ask for recommendations, see exactly what the system did and why, and see on evidence whether the language model earned its cost. The owner will record a two-minute walkthrough from this console, so four moments have to click through from a fresh clone: a thin record gaining labels with the quote behind each; recommendations for one game differing between versions; a filter removing an otherwise plausible result; and too little evidence producing a decline, not a guess.

The owner has limited attention tonight. Prefer the simplest design that fully meets the issue, with no build step and no framework that needs one.

## Context you can't see
- **Rules in force:** `AGENTS.md`, `REVIEW.md`, `.github/pull_request_template.md`, `docs/architecture.md`, `docs/development-workflow.md`, `docs/ui-guidelines.md`, `docs/features/*.md`, `LEARNINGS.md`. Read them and follow them as written. Pull-request descriptions are short and plain by rule, with the review table left as "Pending".
- **The evaluation is the owner's design.** `eval/refs/evaluation-plan.md` defines the answer key, every measure, the reviewer and its exact question text, the four versions and the rule for what ships. `eval/thresholds.json` holds every pass mark. Both were committed by the owner before any result existed, and that order matters to him: agents read these two files and never create or change anything under `eval/refs/` or `eval/thresholds.json`, and no pass mark or measure may be redefined in code. Where the plan leaves a detail open, choose the reading that is hardest to game and say what you chose.
- **Your branch is stacked on the pipeline branch,** which is open as pull request #11 and under review right now. It may change before it merges, and `main` will then hold it as one squashed commit. Bring those changes in by ordinary merges, never by rewriting pushed history, and open your pull request against `main`.
- **What the pipeline gives you:** `data/index/` with four versions of every game (`raw`, `table`, `model_where_thin`, `model_everywhere`), a loader that validates the index (`loadIndex` in `src/pipeline/index-store.ts`), per-version labels with quotes and provenance, a ledger with cost per version, and `docs/features/pipeline.md` describing all of it. Availability comes from `data/offerings.jsonl`; only `live` is eligible. One brand is deliberately small so that declining can be tested.
- **The hidden answer key** is `data/generation/`. The evaluation reads it; the service and the console's request path never do.
- **The reviewer model** in the plan is `gpt-6-luna`. A live test on this account showed it works through the Responses API with strict JSON-schema structured output and no reasoning setting, at about five seconds a call, and that it sometimes returns a "quote" stitched from two phrases, which the plan says must then count as unclear. Its answers have to be stored and committed so the evaluation re-runs with no key, in the way the dataset and pipeline store their model responses.
- **The owner's six check answers** do not exist yet and cannot until your evaluation has found the disagreements. He needs a way to answer six seeded questions without seeing the reviewer's answers, that ends with his answers in a file he commits himself under `eval/refs/`. The evaluation has to run, reach a verdict and say plainly that the owner's check is still outstanding when that file is absent.
- **The what-if sliders** in the console explore other pass marks against the measured numbers. They must change no file, and the panel has to make clear that the release gate reads only the committed marks.
- **How the console should look** is in `docs/ui-guidelines.md`. Make it clear and working; a later pass polishes it and the owner alone judges how it looks.
- **Lessons already paid for in this repository:** twice a proof stayed green when the thing it proved was broken, and once evidence could not be reproduced from a fresh clone. Tests are named after the invariant they prove, the test command fails when it finds nothing to run, and a failure names its cause.
- **The API key** exists only in the owner's secrets mount. Load it inside the one command that needs it and nowhere else [cut: the command that loads it on the owner's machine]. Never print, log, echo or store it, and never run a command that could reveal the environment.
- **Spending:** reviewer-model calls for this task are authorised up to 1.00 US dollar in total. Enforce the limit in code and report what was spent. Nothing else in this task may call a model, and nothing at all may call one while serving a request.

## Bar for done
1. Every acceptance criterion in issue #3 is met and matched to a command you ran on the final commit. The evaluation's result is reported as it fell, including if the model did not earn its place or a pass mark failed; do not adjust anything to change an outcome, and if no version passes, say so and stop there.
2. From a fresh clone with no key: install, type-check, test, evaluate, start the service, and one request each for a normal result and for every decline reason. Shown by doing it.
3. The four walkthrough moments each have a game and brand that demonstrates them, named in your report so the owner can click straight to them.
4. `docs/features/service.md` describes what is built, each invariant with a real proof command, and "last proved" recorded the way `AGENTS.md` prescribes.
5. A pull request is open against `main`, closes #3, has a Conventional Commits title, follows the short template with a small diagram, and ends with the two attribution lines below. The secret scan has been run and is listed in the checks.
6. Your final report: the pull request URL; how to start it and where to click; the evaluation's numbers in one small table per question, with which version ships and why; what was spent; how the owner answers his six questions; every deviation from the issue or the plan; and what you did not verify.

## Hard rules
- Work only in your worktree on `feat/service`. Push that branch and open the pull request; do not merge it, do not push to `main`, do not force-push, do not touch the main checkout, other worktrees or git configuration.
- Never create or change anything under `eval/refs/` or `eval/thresholds.json`.
- The three product rules in `AGENTS.md` hold without exception.
- Public repository: no file, commit message, branch name or pull-request text may name the hiring company, the owner's employer, any other project, or any real person. Do not claim a review, approval or run that did not happen.
- Scope is issue #3 only: no visual polish beyond clear and working, no load test, no monitoring stack, no authentication, no second enrichment method.
- End every commit message with:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XQowzYsc7Td6vaovV8cRtT`
- End the pull-request description with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  followed by a blank line and `https://claude.ai/code/session_01XQowzYsc7Td6vaovV8cRtT`
