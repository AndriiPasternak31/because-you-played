/**
 * The owner's check: six of the reviewer's questions, answered by the owner at a terminal.
 *
 *   npm run owner-check
 *
 * It prints each question exactly as the reviewer was asked it, and never the reviewer's answer:
 * while the owner has not answered, those answers are not in the tree and this command has none to show.
 * It writes the owner's answers to eval/refs/owner-check.json, which the owner then commits himself,
 * and then says how to bring the reviewer's answers back.
 * It refuses to run without a terminal, so that no script or agent can answer in the owner's place.
 */
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { sha256 } from "../src/pipeline/io.ts";
import { analyse, type Analysis, type OwnerAnswers } from "./evaluate.ts";
import { DEFAULT_EVAL_PATHS, OWNER_ANSWERS_PATH, loadInputs, readHeldBack } from "./run.ts";
import { answerPath, type Question } from "./reviewer.ts";

const WORDS = { y: "yes", yes: "yes", n: "no", no: "no", u: "unclear", unclear: "unclear" } as const;

/** The six questions, in the order they are drawn, each with its source. */
export function ownerQuestions(analysis: Analysis): { question: Question; source: "disagreement" | "control" }[] {
  return analysis.ownerQuestions.map((entry) => {
    const question = analysis.questions.find((candidate) => candidate.id === entry.question_id);
    if (question === undefined) throw new Error(`the owner's question ${entry.question_id} is not among the reviewer's questions`);
    return { question, source: entry.source };
  });
}

/** The file the evaluation reads. `answers` are in the order of `ownerQuestions`. */
export function ownerFile(analysis: Analysis, answers: readonly ("yes" | "no" | "unclear")[], answeredOn: string): OwnerAnswers & { answered_on: string } {
  const questions = ownerQuestions(analysis);
  if (answers.length !== questions.length) throw new Error(`expected ${questions.length} answers, got ${answers.length}`);
  return {
    answered_on: answeredOn,
    answers: questions.map(({ question }, position) => ({ question_id: question.id, question_sha256: sha256(question.text), answer: answers[position] as "yes" | "no" | "unclear" })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: "string", default: OWNER_ANSWERS_PATH }, again: { type: "boolean", default: false } },
    strict: true,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("this is the owner's check and it needs a person at a terminal: it does not read answers from a pipe or a file");
  }
  if (existsSync(values.out) && !values.again) throw new Error(`${values.out} already holds answers. Pass --again to answer the questions afresh.`);

  // Any earlier answers are not read: the questions depend only on the evaluation's own inputs.
  const analysis = analyse(loadInputs({ ...DEFAULT_EVAL_PATHS, ownerAnswers: null }));
  const questions = ownerQuestions(analysis);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThe owner's check: ${questions.length} questions the reviewer model has also answered.`);
  console.log("You will not be shown its answers. Answer from the text alone: y (yes), n (no) or u (unclear).");
  const fromControl = questions.filter((entry) => entry.source === "control").length;
  if (fromControl > 0) {
    console.log(`Only ${questions.length - fromControl} disagreement(s) exist in this evaluation, so ${fromControl} of the questions come from the control sample. They are mixed in and not marked.`);
  }
  const answers: ("yes" | "no" | "unclear")[] = [];
  // Asked in id order, not draw order, so that the position of a question says nothing about its source.
  const asked = [...questions].sort((a, b) => (a.question.id < b.question.id ? -1 : 1));
  const given = new Map<string, "yes" | "no" | "unclear">();
  for (const [position, { question }] of asked.entries()) {
    console.log(`\n--- Question ${position + 1} of ${asked.length} ${"-".repeat(40)}\n\n${question.text}\n`);
    for (;;) {
      const typed = (await terminal.question("Your answer [y/n/u]: ")).trim().toLowerCase();
      const word = (WORDS as Record<string, "yes" | "no" | "unclear" | undefined>)[typed];
      if (word !== undefined) {
        given.set(question.id, word);
        break;
      }
      console.log("Please type y, n or u.");
    }
  }
  terminal.close();
  for (const { question } of questions) answers.push(given.get(question.id) as "yes" | "no" | "unclear");
  const file = ownerFile(analysis, answers, new Date().toISOString().slice(0, 10));
  writeFileSync(values.out, `${JSON.stringify(file, null, 2)}\n`);
  const heldBack = readHeldBack(DEFAULT_EVAL_PATHS.heldBack);
  const files = questions.map(({ question }) => answerPath(DEFAULT_EVAL_PATHS.answersDir, question.id));
  console.log(
    `\nWrote ${values.out}. Your answers are in; the reviewer's can now come back. In this order:\n\n` +
      `  1. Bring back the reviewer's six answers as it gave them on ${heldBack.asked_on}:\n` +
      `       git checkout ${heldBack.answers_stored_in_commit} -- ${files.join(" ")}\n` +
      "     If that commit is not in this clone, ask the reviewer again instead (six calls, under one cent, needs OPENAI_API_KEY):\n" +
      "       npm run eval -- --live\n" +
      "  2. npm run eval          # reports how many of the six the reviewer matched\n" +
      `  3. git add ${values.out} eval/reviewer/answers eval/results && git commit -m "docs(eval): add the owner's six check answers"`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`owner-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
