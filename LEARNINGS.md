# Learnings

One line per class of mistake, newest last, added in the pull request that fixes the cause:

`YYYY-MM-DD · what went wrong, as a rule for next time · pull request · the check that now catches it, or "nothing yet"`

2026-11-19 · An error raised while reading a stored file names the file, and the line where it has lines: a bare parse error from one of a hundred files costs the next person the search · #10 · `npm test -- DS-5`
2026-11-19 · A proof has to go red when the thing it proves is broken: break the invariant on purpose and watch the proof fail before trusting it · #10 · `npm test -- DS-2` for that proof; nothing yet for proofs in general
2026-11-19 · A proof that reads a committed artifact checks the artifact, not the code: rebuild with the current code inside the test, or a broken build stays green until someone regenerates · #11 · `npm test -- "PL-12:"` for that proof, and the index-wide proofs rebuild first; nothing yet for proofs in general
2026-11-19 · A check proves only the cases its test feeds it: "word for word" was a substring test that took a piece of a word for a quote, so test the near misses of a check, not only the clear ones · #11 · `npm test -- "PL-2:"`
2026-11-19 · When versions are compared, the same input must give the same output in each: a model asked twice for the same text answers slightly differently, so share one stored answer per text instead of asking per version · #11 · `npm test -- "PL-8:"`
2026-11-19 · A check that a stored response is not stale does not show it is unedited: seal what is stored and try the edit a person would make, not only the damage a tool would cause · #11 · `npm test -- "PL-11:"`
2026-11-19 · A test that breaks two things at once proves neither: the failed verdict in the refusal test also named no version, so dropping the "passed" check stayed green. One fault per case · #12 · `npm test -- "SV-5:"` for that proof; nothing yet for proofs in general
2026-11-19 · Hiding a field does not hide what it says: a total that includes the hidden answers gives them back by subtraction, and so does a document that states one. To hold something back, compute nothing from it, and prove the output is the same whatever it is · #12 · `npm test -- "EV-6:"`
2026-11-19 · A hash binds a file, not what the file says: a verdict edited by hand kept its report's hash and was served. Compare the decision itself, and re-apply the rule that made it · #12 · `npm test -- "SV-5:"`
2026-11-19 · "The reader sees the result first" was treated as look and left to the owner's eye, so a restyle kept the result at the bottom of the page and the browser check only confirmed the element existed. What a reader sees on arrival is behaviour: state the window size, check the thing is inside it without scrolling, and look at the uncropped first screen · #17 · `node tools/console-check.ts --first-screens`
2026-11-20 · A built file that the repository must hold sat under an ignore rule, and every local run passed because the file was on disk. A promise about a fresh clone is proved from what the repository holds, not from the working directory · #17 · `npm test -- "UI-14:"`
2026-11-20 · A picker was judged by its closed look, and opened it listed nothing. Check a control by using it: open it and count what it offers · #17 · `node tools/console-check.ts`
2026-11-20 · A bar that grows into place contradicts the number beside it until it arrives, and a capture taken early records the contradiction. What states a measurement is drawn at its value from the first frame · #17 · `node tools/console-check.ts`
