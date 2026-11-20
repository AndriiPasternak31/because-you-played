/**
 * Proofs for starting the service by hand: SV-9 to SV-12 in docs/features/service.md.
 *
 * They run the commands themselves. What they cannot run is an older Node.js, because the tests
 * run on a version the project accepts: `tools/old-node-check.sh` does that, in a container.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

interface Started {
  output: string;
  open: string;
  request: string;
  stop: () => Promise<void>;
}

/** Runs a command that should start the service on a free port, and resolves once it has printed what to open and what to request. */
function start(script: string): Promise<Started> {
  const child = spawn(process.execPath, [script, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    });
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const giveUp = setTimeout(() => void stop().then(() => reject(new Error(`${script} printed no address within 20 seconds. stdout: ${output} stderr: ${errors}`))), 20_000);
    child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(giveUp);
      reject(new Error(`${script} exited with ${code} before it served. stdout: ${output} stderr: ${errors}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const open = /^ {2}Open {3}(\S+)$/m.exec(output)?.[1];
      const request = /^ {2}Try {4}curl '([^']+)'$/m.exec(output)?.[1];
      if (open === undefined || request === undefined || !/^ {2}Stop /m.test(output)) return;
      clearTimeout(giveUp);
      resolve({ output, open, request, stop });
    });
  });
}

for (const script of ["src/service/serve.ts", "tools/start.ts"]) {
  test(`SV-10: ${script} prints the address to open and a request to try, and both answer: the page, and results`, async () => {
    const started = await start(script);
    try {
      const page = await fetch(started.open);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      const answer = await fetch(started.request);
      assert.equal(answer.status, 200);
      const body = (await answer.json()) as { outcome: string; results: unknown[] };
      assert.equal(body.outcome, "results", `the request printed as the one to try was ${started.request}`);
      assert.ok(body.results.length > 0);
      // The port asked for was 0, "any free one": the address printed has to be the one actually bound.
      assert.doesNotMatch(started.open, /:0\//);
    } finally {
      await started.stop();
    }
  });
}

/** Holds a free port on an address, or says why this machine cannot. */
async function hold(address: string): Promise<{ port: number; release: () => Promise<void> } | string> {
  const holder = net.createServer();
  const failure = await new Promise<string | undefined>((resolve) => {
    holder.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    holder.listen(0, address, () => resolve(undefined));
  });
  if (failure !== undefined) return failure;
  const bound = holder.address();
  assert.ok(typeof bound === "object" && bound !== null);
  return { port: bound.port, release: () => new Promise((resolve) => holder.close(() => resolve())) };
}

test("SV-9: a taken port stops the start with exit 1, the port named as taken and the way to choose another, and no stack trace", async () => {
  const held = await hold("127.0.0.1");
  assert.ok(typeof held !== "string");
  const taken: number = held.port;
  try {
    for (const script of ["src/service/serve.ts", "tools/start.ts"]) {
      const run = spawnSync(process.execPath, [script, "--port", String(taken)], { encoding: "utf8", timeout: 20_000 });
      assert.equal(run.status, 1, `${script}: ${run.stderr}`);
      assert.match(run.stderr, new RegExp(`not serving: port ${taken} on 127\\.0\\.0\\.1 is already in use`));
      assert.match(run.stderr, new RegExp(`--port ${taken + 1}\\b`));
      assert.doesNotMatch(run.stderr, /\n\s+at /);
      assert.equal(run.stdout, "");
    }
  } finally {
    await held.release();
  }
});

test("SV-9: a port another program holds on every interface, or on the other loopback address, stops the start as well", async (t) => {
  let checked = 0;
  for (const address of ["0.0.0.0", "::", "::1"]) {
    const held = await hold(address);
    if (typeof held === "string") {
      // A machine without IPv6 cannot hold a port there. The first address exists everywhere, so something is always checked.
      assert.notEqual(address, "0.0.0.0", `a port on 0.0.0.0 could not be held: ${held}`);
      t.diagnostic(`not checked on ${address}: this machine cannot listen there (${held})`);
      continue;
    }
    const port: number = held.port;
    try {
      for (const script of ["src/service/serve.ts", "tools/start.ts"]) {
        const run = spawnSync(process.execPath, [script, "--port", String(port)], { encoding: "utf8", timeout: 20_000 });
        assert.equal(run.status, 1, `${script} beside a program on ${address}:${port} printed: ${run.stdout}${run.stderr}`);
        assert.match(run.stderr, new RegExp(`not serving: port ${port} on \\S+ is already in use by another program`));
        assert.match(run.stderr, new RegExp(`--port ${port + 1}\\b`));
        assert.equal(run.stdout, "");
      }
      checked += 1;
    } finally {
      await held.release();
    }
  }
  assert.ok(checked >= 1);
});

test("SV-9: PORT in the environment chooses the port, and --port wins over it", async () => {
  const held = await hold("127.0.0.1");
  assert.ok(typeof held !== "string");
  try {
    const fromEnvironment = spawnSync(process.execPath, ["src/service/serve.ts"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: String(held.port) } });
    assert.equal(fromEnvironment.status, 1);
    assert.match(fromEnvironment.stderr, new RegExp(`not serving: port ${held.port} on 127\\.0\\.0\\.1 is already in use`));
    const optionWins = spawnSync(process.execPath, ["src/service/serve.ts", "--port", String(held.port)], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: "1" } });
    assert.equal(optionWins.status, 1);
    assert.match(optionWins.stderr, new RegExp(`not serving: port ${held.port} on 127\\.0\\.0\\.1 is already in use`));
    const unreadable = spawnSync(process.execPath, ["src/service/serve.ts"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PORT: "nine thousand" } });
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /the port, from --port or PORT, must be a number from 0 to 65535, got "nine thousand"/);
  } finally {
    await held.release();
  }
});

test("SV-9: an option given without the bare -- that npm needs is refused, with the form that works", () => {
  // What `npm start --port 9000` hands the script: the number alone.
  const run = spawnSync(process.execPath, ["tools/start.ts", "9000"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /npm start -- --port 9000/);
  assert.equal(run.stdout, "");
});

test("SV-11: the version check names the version found, the version needed and how to get it, and passes this version in silence", () => {
  const check = createRequire(import.meta.url)("../../tools/check-node.cjs") as {
    neededMajor: () => number;
    problem: (found: string, needed: number, executable: string) => string | null;
  };
  const needed = check.neededMajor();
  const reason = check.problem(`${needed - 1}.20.2`, needed, "/somewhere/node");
  assert.ok(reason !== null);
  assert.match(reason, new RegExp(`needs Node\\.js ${needed} or newer, and this is Node\\.js ${needed - 1}\\.20\\.2 \\(/somewhere/node\\)`));
  assert.match(reason, new RegExp(`nvm install ${needed}`));
  assert.match(reason, /docker compose up --build {3}\(needs Docker with its Compose plugin\)/);
  // The comparison is of numbers: as text, "9" would sort after "24".
  assert.ok(check.problem("9.11.2", needed, "node") !== null);
  assert.equal(check.problem(`${needed}.0.0`, needed, "node"), null);
  assert.equal(check.problem(`${needed + 2}.13.1`, needed, "node"), null);

  const run = spawnSync(process.execPath, ["tools/check-node.cjs"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(run.stdout + run.stderr, "");
});

/** A copy of the start command beside a manifest and a lockfile, with nothing installed, and a stand-in for npm that records its call. */
function uninstalledCopy(npmExit: number): { script: string; env: NodeJS.ProcessEnv; called: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "start-test-"));
  mkdirSync(join(dir, "tools"));
  cpSync("tools/start.ts", join(dir, "tools", "start.ts"));
  cpSync("package.json", join(dir, "package.json"));
  cpSync("package-lock.json", join(dir, "package-lock.json"));
  const record = join(dir, "npm-was-called");
  writeFileSync(record, "");
  // Named as npm names its own entry point, which is how the start command knows npm started it.
  const npm = join(dir, "npm-cli.js");
  writeFileSync(npm, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, process.argv.slice(2).join(" "));\nprocess.exit(${npmExit});\n`);
  return { script: join(dir, "tools", "start.ts"), env: { ...process.env, npm_execpath: npm }, called: () => readFileSync(record, "utf8") };
}

test("SV-12: with a dependency missing the start command runs npm ci, and when that fails or installs nothing it says so and starts nothing", () => {
  const failing = uninstalledCopy(7);
  const failed = spawnSync(process.execPath, [failing.script, "--port", "0"], { encoding: "utf8", env: failing.env, timeout: 20_000 });
  assert.equal(failing.called(), "ci");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Installing the dependencies with npm ci: zod is not installed/);
  assert.match(failed.stderr, /npm start: npm ci failed \(exit 7\), so the service was not started/);
  assert.doesNotMatch(failed.stdout, /Serving/);

  const idle = uninstalledCopy(0);
  const nothing = spawnSync(process.execPath, [idle.script, "--port", "0"], { encoding: "utf8", env: idle.env, timeout: 20_000 });
  assert.equal(idle.called(), "ci");
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /npm start: npm ci finished and the dependencies are still not as locked: zod is not installed/);
  assert.doesNotMatch(nothing.stdout, /Serving/);
});
