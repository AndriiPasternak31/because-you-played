/**
 * The one command: from a fresh clone it installs what is missing and starts the service.
 *
 *   npm start                      http://127.0.0.1:8787
 *   npm start -- --port 9000       every option of src/service/serve.ts passes through
 *
 * `npm start` checks the Node.js version first (tools/check-node.cjs, in the script's own line). Then
 * this installs the dependencies when a declared package is absent from node_modules or is not the
 * version the lockfile names, and does nothing otherwise, so a second start needs no network. It then
 * becomes the service: the same code, the same release gate and the same refusals as `npm run serve`.
 *
 * It imports nothing that has to be installed, because it runs before anything is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Each declared package that is not installed at the version the lockfile names, with what is there instead. */
function notInstalled(): string[] {
  const manifest = readJson(join(ROOT, "package.json"));
  const locked = readJson(join(ROOT, "package-lock.json"))["packages"] as Record<string, { version?: string }> | undefined;
  if (locked === undefined) throw new Error("package-lock.json has no \"packages\", so there is nothing to compare node_modules with");
  const declared = [manifest["dependencies"], manifest["devDependencies"]].flatMap((group) => Object.keys((group ?? {}) as Record<string, string>));
  const problems: string[] = [];
  for (const name of declared) {
    const wanted = locked[`node_modules/${name}`]?.version;
    if (wanted === undefined) throw new Error(`package.json declares ${name} and package-lock.json does not lock it. Run npm install and commit the lockfile.`);
    const installed = join(ROOT, "node_modules", name, "package.json");
    const found = existsSync(installed) ? readJson(installed)["version"] : undefined;
    if (found === undefined) problems.push(`${name} is not installed`);
    else if (found !== wanted) problems.push(`${name} is ${String(found)}, and the lockfile names ${wanted}`);
  }
  return problems;
}

/** `npm ci`, through the npm that started this when npm did, and the one on the PATH otherwise. */
function install(): void {
  const npmCli = process.env["npm_execpath"];
  const run =
    npmCli !== undefined && /npm-cli\.js$/.test(npmCli)
      ? spawnSync(process.execPath, [npmCli, "ci"], { cwd: ROOT, stdio: "inherit" })
      : spawnSync("npm", ["ci"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (run.error !== undefined) throw new Error(`npm ci could not be run, so nothing was installed: ${run.error.message}`, { cause: run.error });
  if (run.status !== 0) throw new Error(`npm ci failed (${run.signal ?? `exit ${run.status}`}), so the service was not started. Its own message is above.`);
}

try {
  const missing = notInstalled();
  if (missing.length > 0) {
    console.log(`Installing the dependencies with npm ci: ${missing.join("; ")}.`);
    install();
    const still = notInstalled();
    if (still.length > 0) throw new Error(`npm ci finished and the dependencies are still not as locked: ${still.join("; ")}`);
  }
  // The service reads its data by paths relative to the repository.
  process.chdir(ROOT);
  await import("../src/service/serve.ts");
} catch (error) {
  console.error(`npm start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
