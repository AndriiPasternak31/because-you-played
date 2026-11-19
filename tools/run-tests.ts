/**
 * Runs the tests, and fails when nothing was checked.
 *
 *   node tools/run-tests.ts              every test in every file
 *   node tools/run-tests.ts DS-4         only tests whose name matches the pattern
 *
 * `node --test` on its own exits 0 when its file pattern matches no file, and when a name
 * pattern matches no test. Here both are failures, and so is a test file in which no test passed.
 */
import { globSync } from "node:fs";
import { relative } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const FILE_PATTERN = "src/**/*.test.ts";

const [namePattern, ...extra] = process.argv.slice(2);
if (extra.length > 0) throw new Error(`expected at most one name pattern, got ${extra.length + 1} arguments`);

const files = globSync(FILE_PATTERN).sort();
if (files.length === 0) throw new Error(`no test file matches ${FILE_PATTERN}, so nothing was tested`);

const passedByFile = new Map<string, number>();
let succeeded = false;
const stream = run({ files, ...(namePattern === undefined ? {} : { testNamePatterns: [namePattern] }) });
stream.on("test:summary", (summary) => {
  if (summary.file === undefined) succeeded = summary.success;
  else passedByFile.set(relative(process.cwd(), summary.file), summary.counts.passed);
});
stream.compose(spec).pipe(process.stdout);

process.on("exit", () => {
  const problems: string[] = [];
  if (!succeeded) problems.push("a test failed, or the run did not finish");
  // A file that holds no test reports nothing at all, so a file without a count has none.
  const empty = files.filter((file) => (passedByFile.get(file) ?? 0) === 0);
  if (namePattern === undefined) {
    if (empty.length > 0) problems.push(`no test passed in ${empty.join(", ")}, so nothing was tested there`);
  } else if (empty.length === files.length) {
    problems.push(`no test with a name matching "${namePattern}" passed, so nothing was tested`);
  }
  if (problems.length === 0) return;
  console.error(`\ntests did not pass: ${problems.join("; ")}`);
  process.exitCode = 1;
});
