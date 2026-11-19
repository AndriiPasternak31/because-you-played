# Learnings

One line per class of mistake, newest last, added in the pull request that fixes the cause:

`YYYY-MM-DD · what went wrong, as a rule for next time · pull request · the check that now catches it, or "nothing yet"`

2026-11-19 · An error raised while reading a stored file names the file, and the line where it has lines: a bare parse error from one of a hundred files costs the next person the search · #10 · `npm test -- DS-5`
2026-11-19 · A proof has to go red when the thing it proves is broken: break the invariant on purpose and watch the proof fail before trusting it · #10 · `npm test -- DS-2` for that proof; nothing yet for proofs in general
2026-11-19 · A proof that reads a committed artifact checks the artifact, not the code: rebuild with the current code inside the test, or a broken build stays green until someone regenerates · #11 · `npm test -- "PL-12:"` for that proof, and the index-wide proofs rebuild first; nothing yet for proofs in general
2026-11-19 · A check proves only the cases its test feeds it: "word for word" was a substring test that took a piece of a word for a quote, so test the near misses of a check, not only the clear ones · #11 · `npm test -- "PL-2:"`
2026-11-19 · A test that breaks two things at once proves neither: the failed verdict in the refusal test also named no version, so dropping the "passed" check stayed green. One fault per case · #3 · `npm test -- "SV-5:"` for that proof; nothing yet for proofs in general
