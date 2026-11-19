# Review

A review here is an attempt to break the change by running it. Reading the diff and listing concerns is not a review.

**Who.** A fresh agent that has not seen the builder's conversation. It gets the task, its acceptance criteria, the part files for what changed (`docs/features/`) and the commit. It does not get the builder's reasoning.

**What it does.** For each acceptance criterion, and each invariant of the parts touched, it tries to construct a counterexample and runs it against the commit. Where the domain is small it checks all of it rather than a sample: every game against every brand, every status value. Where a rule can be made impossible to break, such as a type that cannot express the forbidden write, it checks that the structure is there.

**What it returns.** Either a failing command that anyone can re-run on that commit, with its output; or the attempts it ran, each as a command with its output, and the statement that none broke the change.

**What blocks.** A reproduced failure blocks until it is fixed and its command passes; that command becomes a test. A concern with no reproduction is recorded as unconfirmed and does not block.

**Approval.** Each acceptance criterion is matched to a command that was run, with its output, on the commit being merged. A criterion with no such command is not met.

**Second opinion.** For decisions and design, not for diffs: a model from a different family answers the same question without seeing the first model's view. A disagreement is settled by running something, or by the owner.

**The interface.** Agents show that it works. How it looks and feels is the owner's judgement, made by looking at it.

**The record.** Every finding goes into the pull request with how it was found (break attempt, reading, second model), whether it reproduced, and what happened to it. That is a log of what review produced on these pull requests. With no reading-only review to compare against and only a handful of cases, it says nothing about review methods in general.
