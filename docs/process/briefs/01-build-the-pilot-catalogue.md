# Generate pilot catalogue subset

- Kind: brief to a new agent (general-purpose)
- Sent: 2026-11-18T23:42:06.583Z

---

## Goal
Produce a first, small, committed **pilot subset** of a fictional online-casino game catalogue, together with the TypeScript script that generated it, on the branch `feat/dataset` of a repository whose worktree for you is already prepared at `[cut: local path]` (GitHub: private repo `because-you-played`). The pilot must prove the generator end to end, so that producing the full catalogue of about 100 games later is the same command with a larger count.

## Why, and what it feeds
This repository is a take-home engineering assessment that will be made public and read as a whole, history included. The product is a "Because you played X, you might like…" recommender: an offline pipeline (LLM enrichment of thin records, then embeddings) and a small TypeScript service. The catalogue is the foundation, and [cut: a sentence that follows the assignment's wording too closely to publish. Its point: how a game is modelled carries the most weight, and a clean catalogue would leave the later stages untested.] The owner wants generation started now on a subset so that problems with the record model and the messiness surface before the full run. The next piece of work (the dataset pull request, then the enrichment pipeline) builds directly on what you leave.

## Context you can't see
- **Where the design lives** (read these; they are outside the repository and must stay outside it):
  - `[cut: local path]` (the product spec) — section 2 is the game model (which fields exist, who may write them, what is carried raw and never interpreted); items M2 and M3 describe the model and the generator and their acceptance checks.
  - `[cut: local path]` (two files) — research into how real catalogues look: realistic value formats, population mix, and the kinds of mess found in real feeds.
  - `[cut: local path]` (the evaluation design) — sections 2.2 and 3.2 describe the kinds of record the later evaluation needs to exist in the catalogue.
- **The design in one paragraph:** an LLM writes rich "truth" records for fictional slot games; seeded deterministic code then degrades them into the messy raw records a source system would deliver; availability lives in a separate offerings file (game × brand, with jurisdiction and status). The truth stays hidden from the later pipeline and exists so evaluation can tell recoverable facts from genuinely unknown ones.
- **Provider:** OpenAI. Confirmed by a live call a few minutes ago: the Responses API with strict JSON-schema structured output works on model `gpt-6.2-sol` (about 4 seconds for a tiny request). The key is available as `OPENAI_API_KEY` from the owner's secrets mount, loaded only inside the command that needs it [cut: the command that loads it on the owner's machine].
- **State of the repository:** `main` has a single commit containing only `.gitignore` and a placeholder `README.md`; your branch starts from it. There is no package manifest or TypeScript setup yet, so the minimum needed to run and type-check your script is yours to add; keep it minimal and say exactly what you added. A separate first commit carrying agent instruction files and delivery templates will be pushed to `main` by someone else shortly, and your branch will be rebased onto it afterwards, so avoid touching `README.md` and `.gitignore` unless you must, and say so if you do.
- The main checkout one level up (`[cut: local path]`) belongs to someone else's work: do not change anything there. Your worktree lives inside it under `wt/`, which is excluded from the main checkout's status.
- Node 24, npm, pnpm and bun are installed.

## Bar for done
1. **A pilot of about 12 to 15 games, not the full catalogue.** It contains the hidden truth records, the degraded raw records, and the offerings across at least two fictional brands. Between them the records cover: each kind of mess the spec lists at least once; at least one clean control record; one family with at least two members; one pair of different games from different studios that share a name; one true duplicate that shares a supplier id; one near-empty record; one record whose description contains instruction-like text; and at least one game that is withdrawn or limited to a single brand.
2. **Everything fictional.** No real game titles, studios, operators, brands or trademarks.
3. **Reproducible without a key.** The raw LLM responses are committed, and re-running the seeded degradation over those committed responses produces byte-identical output. Prove it by running it twice and showing the comparison.
4. **Same command for the full run.** The count is a parameter. Do not run the full catalogue.
5. **A ledger** for the generation run: tokens in and out, estimated cost, seconds per record and retries, printed and committed.
6. **Boundaries are validated and failures are loud.** Model output that does not match the expected shape is rejected with a clear error, never silently repaired or skipped.
7. **The project's own checks pass** on what you wrote (strict type-check at minimum), shown by their output.
8. **Committed on `feat/dataset`** with conventional-commit style subjects, in focused commits.
9. **Your final report** states: the commit hashes; the files added; the exact commands you ran with their real output and counts; a table of how many records carry each kind of mess; what the run cost; every deviation from the spec and why; the questions about the record model that the pilot raised; and the risks for whoever builds enrichment next. Separate what you verified by running from what you did not verify.

## Hard rules
- **Secrets:** never print, log, echo or write the key or any other value from the secrets mount; never run `env`, `printenv`, `set` or shell tracing where secrets are loaded; never put a secret in a file. If a provider error message could echo part of the key, do not print the message.
- **Spend:** this should cost cents. Stop and report if you approach one US dollar.
- **Scope:** generator, record model types, the pilot data and minimal tooling only. Do not build enrichment, embeddings, the service, evaluation, CI, or any agent instruction or template files.
- **Git:** work only on `feat/dataset` in your worktree. Do not commit to or push `main`, do not open a pull request, do not force-push, do not change git configuration, do not create or remove worktrees. Pushing `feat/dataset` to the remote is fine.
- **Public-repo hygiene:** nothing in any file, commit message or branch name may name the hiring company or any real person. The assignment brief (a `.docx` in the main checkout) and the design documents listed above must not be copied into the repository; paraphrase what you need in code comments or a short data README.
- End every commit message with these two lines:
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01XQowzc3CQfJeVS3AdXi4Lx`
