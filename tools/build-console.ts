/**
 * Builds the page's script and stylesheet from src/console into src/console/dist, which is committed.
 *
 *   node tools/build-console.ts            write the built files
 *   node tools/build-console.ts --check    write nothing; fail when a committed file differs from a fresh build
 *
 * The service serves the committed files, so `npm install` and `npm run serve` need no build, no key
 * and no network. React, the two interface libraries and the bundler are development dependencies:
 * only this script and the tests load them. The same build runs inside `npm test` (UI-14), so what is
 * served cannot drift from its source without a test going red.
 *
 * It also writes the licence notices of every package whose code is inside the built script.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..");
export const DIST = join(ROOT, "src", "console", "dist");
export const NOTICES = "THIRD-PARTY-NOTICES.txt";

/** The name of the package a bundled file belongs to, or null for this repository's own files. */
function packageOf(path: string): string | null {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
  return match?.[1] ?? null;
}

function notices(packages: readonly string[]): string {
  const parts = [
    "Third-party software inside src/console/dist/app.js and src/console/dist/console.css.",
    "Written by tools/build-console.ts from the packages the build pulled in. Do not edit by hand.",
  ];
  for (const name of [...packages].sort()) {
    const dir = join(ROOT, "node_modules", name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    parts.push(`${"=".repeat(78)}\n${name} ${manifest.version} · ${manifest.license ?? "licence not stated in its package.json"}\n${"=".repeat(78)}`);
    const files = readdirSync(dir).filter((file) => /^(licen[cs]e|notice)(\.|$)/i.test(file)).sort();
    if (files.length === 0) throw new Error(`${name} is inside the built page and ships no licence file, so its notice cannot be written`);
    for (const file of files) parts.push(`--- ${name}/${file} ---\n${readFileSync(join(dir, file), "utf8").replaceAll("\r\n", "\n").trim()}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Builds in memory. Returns each built file's name and text. Throws on any build warning: a warning here is a broken page later. */
export async function buildConsole(): Promise<Map<string, string>> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: { app: "src/console/main.ts", console: "src/console/styles.css" },
    outdir: "src/console/dist",
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  if (result.warnings.length > 0) throw new Error(`the build warned: ${result.warnings.map((warning) => warning.text).join("; ")}`);
  const files = new Map<string, string>();
  for (const file of result.outputFiles) files.set(relative(DIST, file.path), file.text);
  for (const name of ["app.js", "console.css"]) if (!files.has(name)) throw new Error(`the build did not produce ${name}`);
  const packages = new Set<string>();
  for (const input of Object.keys(result.metafile.inputs)) {
    const name = packageOf(input);
    if (name !== null) packages.add(name);
  }
  files.set(NOTICES, notices([...packages]));
  return files;
}

/** The names of the built files whose committed text differs from `built`, or is missing. */
export function drift(built: ReadonlyMap<string, string>): string[] {
  return [...built].filter(([name, text]) => !existsSync(join(DIST, name)) || readFileSync(join(DIST, name), "utf8") !== text).map(([name]) => name);
}

if (import.meta.main) {
  const built = await buildConsole();
  if (process.argv.includes("--check")) {
    const changed = drift(built);
    if (changed.length > 0) {
      console.error(`src/console/dist is not what the source builds: ${changed.join(", ")}. Run "npm run build" and commit the result.`);
      process.exitCode = 1;
    } else console.log(`src/console/dist matches a fresh build (${[...built.keys()].join(", ")})`);
  } else {
    mkdirSync(DIST, { recursive: true });
    for (const [name, text] of built) writeFileSync(join(DIST, name), text);
    console.log([...built].map(([name, text]) => `${name} ${(Buffer.byteLength(text) / 1024).toFixed(0)} kB`).join(" · "));
  }
}
