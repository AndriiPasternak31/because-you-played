/**
 * Drives the console in a real browser and checks what the tests cannot reach: the page script,
 * the layout at desktop and phone width, keyboard focus, reduced motion, and that moving a
 * what-if slider with the keyboard changes no file. It also writes the screenshots.
 *
 *   node tools/console-check.ts                                  checks only
 *   node tools/console-check.ts --screenshots docs/screenshots   checks, then writes the screenshots there
 *
 * It needs a local Chrome or Chromium (set CHROME to its path when it is not found) and no package:
 * it speaks the DevTools protocol over Node's own WebSocket. It starts the service in this process
 * on a free port, reads no key and calls no model.
 *
 * It is not part of `npm test`, because a machine without a browser cannot run it. Without a
 * browser it fails and says so. It judges nothing about how the page looks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createService } from "../src/service/http.ts";
import { loadService } from "../src/service/state.ts";

/**
 * The requests the walkthrough shows, and what each has to demonstrate. When the catalogue or the
 * evaluation changes and a game no longer shows its moment, the check for that moment fails and names it.
 */
const MOMENTS = {
  thin: { game: "okk-62483", brand: "tavrenmoor" },
  versions: { game: "qfi-87623", brand: "tavrenmoor" },
  filter: { game: "okk-50023", brand: "tavrenmoor", brandBefore: "copperjay" },
  decline: { game: "qfi-40239", brand: "tavrenmoor" },
  conflict: { game: "okk-17457", brand: "tavrenmoor" },
} as const;

const WIDTHS = [
  { name: "desktop", width: 1280, height: 900, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
] as const;
type Width = (typeof WIDTHS)[number];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const windowOf = (view: Width, height: number = view.height): Record<string, unknown> => ({ width: view.width, height, deviceScaleFactor: view.scale, mobile: view.mobile });

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

function findChrome(): string {
  const candidates = [
    process.env["CHROME"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => path !== undefined && path.length > 0);
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`no Chrome or Chromium found (looked at ${candidates.join(", ")}), so nothing was checked. Set CHROME to its path.`);
  return found;
}

async function launchChrome(): Promise<{ port: number; child: ChildProcess; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), "console-check-"));
  const child = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 15000; waited += 100) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return { port, child, profile };
    }
    await sleep(100);
  }
  child.kill();
  throw new Error("Chrome started but did not open its DevTools port within 15 seconds, so nothing was checked");
}

interface Page {
  errors: string[];
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate<T>(expression: string): Promise<T>;
  waitFor(expression: string, what: string): Promise<void>;
  goto(url: string): Promise<void>;
  key(key: string, code: number, text?: string): Promise<void>;
  close(): Promise<void>;
}

async function openPage(port: number, view: Width, reducedMotion = false): Promise<Page> {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("could not connect to the browser tab")));
  });
  let lastId = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const errors: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: Record<string, unknown>; method?: string; params?: Record<string, unknown> };
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(JSON.stringify(message.error)));
      else waiting?.resolve(message.result ?? {});
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(JSON.stringify((message.params as { exceptionDetails: { exception?: { description?: string }; text: string } }).exceptionDetails.exception?.description ?? "an exception"));
    } else if (message.method === "Log.entryAdded") {
      const entry = (message.params as { entry: { level: string; text: string; url?: string } }).entry;
      if (entry.level === "error") errors.push(`${entry.text} ${entry.url ?? ""}`);
    }
  });
  const send: Page["send"] = (method, params = {}) =>
    new Promise((resolve, reject) => {
      lastId += 1;
      pending.set(lastId, { resolve, reject });
      socket.send(JSON.stringify({ id: lastId, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", windowOf(view));
  if (reducedMotion) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (reply.exceptionDetails !== undefined) throw new Error(`the page threw while evaluating ${expression.slice(0, 80)}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value;
  };
  const waitFor = async (expression: string, what: string): Promise<void> => {
    for (let waited = 0; waited < 10000; waited += 100) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`waited 10 seconds for ${what}, and it did not appear`);
  };
  return {
    errors,
    send,
    evaluate,
    waitFor,
    async goto(url) {
      await send("Page.navigate", { url });
      await waitFor("document.readyState === 'complete'", `${url} to load`);
    },
    async key(key, code, text) {
      await send("Input.dispatchKeyEvent", { type: text === undefined ? "rawKeyDown" : "keyDown", key, code: key, windowsVirtualKeyCode: code, ...(text === undefined ? {} : { text }) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    },
    async close() {
      socket.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    },
  };
}

// ---------------------------------------------------------------------------
// What is asked of the page. Each expression runs in the page and returns the problems it found.
// ---------------------------------------------------------------------------

/** Nothing on the page may be wider than the window, except what scrolls inside its own box. */
const LAYOUT = `(() => {
  const width = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > width) problems.push("the page is " + document.documentElement.scrollWidth + "px wide in a " + width + "px window");
  for (const element of document.querySelectorAll("main *")) {
    if (element.closest(".scroll, .sr, table.race thead")) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.right > width + 0.5 || box.left < -0.5) problems.push(element.tagName.toLowerCase() + "." + element.className + " runs from " + Math.round(box.left) + " to " + Math.round(box.right) + "px");
  }
  return problems.slice(0, 5);
})()`;

const SHOWS: Record<keyof typeof MOMENTS, string> = {
  thin: `(() => {
    const record = document.querySelector("ol.flow li .v")?.textContent;
    if (record !== "thin") return ["the record is shown as " + record + ", not thin"];
    if (document.querySelectorAll("#enrichment .context mark").length === 0) return ["no quote is marked in the record's text"];
    if (document.querySelectorAll("#enrichment .holds .tag.model").length === 0) return ["the served version holds no label from the model"];
    return document.querySelector("#outcome [data-results]") ? [] : ["there are no results"];
  })()`,
  versions: `(() => {
    const rows = [...document.querySelectorAll("#compare table.matrix tbody tr")];
    if (rows.length === 0) return ["no version recommends anything"];
    const columns = rows[0].querySelectorAll("td").length;
    const picks = [...Array(columns).keys()].map((column) => rows.map((row) => row.querySelectorAll("td")[column].textContent).join("|"));
    return new Set(picks).size > 1 ? [] : ["every version recommends the same games in the same order"];
  })()`,
  filter: "[]",
  decline: `(() => {
    const problems = [];
    if (!document.querySelector("#outcome [data-decline]")) problems.push("the outcome is not a decline");
    if (document.querySelector("#trace [data-results]")) problems.push("results are shown beside the decline");
    if (document.querySelector("#trace .label.red")) problems.push("the decline carries a failure label");
    if (!document.querySelector("ol.flow li:last-child.amber")) problems.push("the last step is not marked as declined");
    return problems;
  })()`,
  conflict: `(() => {
    if (!document.querySelector("#enrichment [data-conflict]")) return ["no conflict is shown"];
    const mechanics = [...document.querySelectorAll("#enrichment .holds ul.fields li")].find((line) => line.textContent.startsWith("Mechanics"));
    return mechanics?.querySelector(".tag.model") ? [] : ["the served version does not hold the model's reading of the mechanics"];
  })()`,
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { values: options } = parseArgs({ options: { screenshots: { type: "string" } }, strict: true });
const failures: string[] = [];
let checks = 0;

function check(name: string, problems: readonly string[]): void {
  checks += 1;
  if (problems.length === 0) console.log(`ok    ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}\n        ${problems.join("\n        ")}`);
  }
}

/** A hash of every file under the directories a slider must not touch. */
function hashTree(directories: readonly string[]): string {
  const hash = createHash("sha256");
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true }).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      hash.update(path).update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

const service = createService(loadService());
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
const chrome = await launchChrome();

async function shot(page: Page, view: Width, name: string, from: string, to = from): Promise<void> {
  if (options.screenshots === undefined) return;
  const box = await page.evaluate<{ top: number; bottom: number; page: number } | null>(
    `(() => { const a = document.querySelector(${JSON.stringify(from)}); const b = document.querySelector(${JSON.stringify(to)}); if (!a || !b) return null; return { top: a.getBoundingClientRect().top + scrollY, bottom: b.getBoundingClientRect().bottom + scrollY, page: document.documentElement.scrollHeight }; })()`,
  );
  if (box === null) throw new Error(`screenshot ${name}: the page has no ${from} or no ${to}`);
  const top = Math.max(0, Math.floor(box.top - 16));
  const height = Math.ceil(Math.min(box.bottom + 16, box.page) - top);
  // The window is made as tall as the part wanted, so the picture is of the page as a reader would scroll to it.
  await page.send("Emulation.setDeviceMetricsOverride", windowOf(view, height));
  await page.evaluate(`window.scrollTo({ top: ${top}, behavior: "instant" })`);
  await sleep(300);
  const { data } = (await page.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  mkdirSync(options.screenshots, { recursive: true });
  writeFileSync(join(options.screenshots, `${view.name}-${name}.png`), Buffer.from(data, "base64"));
  await page.send("Emulation.setDeviceMetricsOverride", windowOf(view));
}

const link = (moment: { game: string; brand: string }, brand: string = moment.brand): string => `${base}/?${new URLSearchParams({ game: moment.game, brand })}`;

async function openRequest(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitFor("document.querySelector('#outcome') && document.querySelector('#compare table.compare') && document.querySelector('#race')", "the trace, the comparison and the evaluation");
  await sleep(1300); // the bars and the steps have finished appearing
}

try {
  for (const view of WIDTHS) {
    const page = await openPage(chrome.port, view);

    for (const name of ["thin", "versions", "decline", "conflict"] as const) {
      await openRequest(page, link(MOMENTS[name]));
      check(`${view.name}: ${name} (${MOMENTS[name].game} on ${MOMENTS[name].brand}) shows its moment`, await page.evaluate<string[]>(SHOWS[name]));
      check(`${view.name}: ${name} fits the window`, await page.evaluate<string[]>(LAYOUT));
      if (name === "thin") {
        await shot(page, view, "0-one-request", "header", "#raw-record");
        await shot(page, view, "1-thin-record-gains-labels", "#enrichment");
      }
      if (name === "versions") await shot(page, view, "2-versions-differ", "#side-by-side");
      if (name === "decline") await shot(page, view, "4-decline-instead-of-a-guess", ".trace-title", ".provenance");
      if (name === "conflict") await shot(page, view, "5-tag-contradicts-description", "#enrichment");
    }

    // A filter removes a plausible result: the best result on one brand is not live on the other, and is named there as removed.
    const filter = MOMENTS.filter;
    await openRequest(page, link(filter, filter.brandBefore));
    const best = await page.evaluate<string | null>("document.querySelector('#outcome ol.results li code')?.textContent ?? null");
    await shot(page, view, `3a-best-result-on-${filter.brandBefore}`, "#outcome");
    await openRequest(page, link(filter));
    const removal = await page.evaluate<string[]>(`(() => {
      const best = ${JSON.stringify(best)};
      if (best === null) return ["there is no result on ${filter.brandBefore} to lose"];
      const first = document.querySelector("#removals ol.funnel > li");
      const details = first?.querySelector("details");
      if (details) details.open = true;
      const removed = [...(first?.querySelectorAll("ul.removed code") ?? [])].map((code) => code.textContent);
      const problems = [];
      if (!removed.includes(best)) problems.push("the first filter on ${filter.brand} does not name " + best + " as removed");
      if ([...document.querySelectorAll("#outcome code, #scores code")].some((code) => code.textContent === best)) problems.push(best + " is still scored or returned on ${filter.brand}");
      return problems;
    })()`);
    check(`${view.name}: filter (${filter.game}, ${filter.brandBefore} then ${filter.brand}) removes the best result before scoring`, removal);
    check(`${view.name}: filter fits the window`, await page.evaluate<string[]>(LAYOUT));
    await shot(page, view, `3b-removed-before-scoring-on-${filter.brand}`, "#removals", "#removals ol.funnel > li");

    // The evaluation, then the what-if panel driven with the keyboard alone.
    await shot(page, view, "6-race-and-where-it-helps", "#evaluation", "#where-it-helps");
    const before = hashTree(["eval", "data"]);
    const rings: string[] = [];
    const focused = (): Promise<{ id: string; type: string; ring: boolean; what: string }> =>
      page.evaluate(`(() => { const a = document.activeElement; const s = getComputedStyle(a); return { id: a.id, type: a.type ?? "", ring: s.outlineStyle === "solid" && parseFloat(s.outlineWidth) >= 2, what: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") }; })()`);
    const tabTo = async (wanted: (element: { id: string; type: string }) => boolean, what: string): Promise<void> => {
      for (let presses = 0; presses < 200; presses += 1) {
        await page.key("Tab", 9);
        const now = await focused();
        if (now.what === "body") continue;
        if (!now.ring) rings.push(`${now.what} takes focus with no visible ring`);
        if (wanted(now)) return;
      }
      throw new Error(`200 presses of Tab did not reach ${what}`);
    };
    await page.evaluate("document.body.focus(); window.scrollTo(0, 0)");
    await tabTo((element) => element.id === "what-if-open", "the what-if button");
    await page.key("Enter", 13, "\r");
    await page.waitFor("document.querySelector('#what-if .mark')", "the what-if panel");
    const committedFails = await page.evaluate<number>("document.querySelectorAll('#what-if .label.red').length");
    await tabTo((element) => element.type === "range" && element.id === "mark-min_pairwise_accuracy", "the pairwise accuracy slider");
    // Raise the mark a step at a time until a version that passed now fails.
    for (let step = 1; step <= 25; step += 1) {
      await page.key("ArrowRight", 39);
      await page.waitFor(`document.querySelector('#what-if .mark.moved output')?.textContent !== undefined && document.querySelectorAll('#what-if .mark.moved').length === 1`, "the moved mark");
      await sleep(200);
      if ((await page.evaluate<number>("document.querySelectorAll('#what-if .label.red').length")) > committedFails) break;
    }
    check(
      `${view.name}: the what-if panel opens and moves with the keyboard, says what the gate reads, and changes no file`,
      await page.evaluate<string[]>(`(() => {
        const panel = document.querySelector("#what-if");
        const problems = [];
        if (!panel.textContent.includes("The release gate reads only the committed file")) problems.push("the panel does not say what the gate reads");
        if (panel.querySelectorAll(".tick").length !== panel.querySelectorAll("input[type=range]").length) problems.push("a slider has no committed tick");
        if (panel.querySelectorAll(".label.amber").length < 2) problems.push("the moved mark is not labelled");
        if (document.activeElement?.id !== "mark-min_pairwise_accuracy") problems.push("the slider lost focus when the panel was redrawn");
        if (panel.querySelectorAll(".label.red").length <= ${committedFails}) problems.push("raising the mark failed no version");
        return problems;
      })()`).then((problems) => (hashTree(["eval", "data"]) === before ? problems : [...problems, "a file under eval/ or data/ changed"])),
    );
    check(`${view.name}: every control reached with Tab shows a focus ring`, rings);
    check(`${view.name}: the open what-if panel fits the window`, await page.evaluate<string[]>(LAYOUT));
    await shot(page, view, "7-what-if-a-mark-moved", "#what-if");
    check(`${view.name}: the page script raised no error`, page.errors);
    await page.close();

    // Motion: there is some by default, and none for a reader who asked for less.
    const animated = `["#outcome ol.results li", "#removals .track .fill"].map((selector) => getComputedStyle(document.querySelector(selector)).animationName).concat(getComputedStyle(document.querySelector("ol.flow li"), "::before").animationName)`;
    const still = await openPage(chrome.port, view, true);
    await openRequest(still, link(MOMENTS.thin));
    const reduced = await still.evaluate<string[]>(animated);
    check(`${view.name}: nothing animates under prefers-reduced-motion`, reduced.every((name) => name === "none") ? [] : [`animations still set: ${reduced.join(", ")}`]);
    await still.close();
    const moving = await openPage(chrome.port, view);
    await openRequest(moving, link(MOMENTS.thin));
    const usual = await moving.evaluate<string[]>(animated);
    check(`${view.name}: the same parts do animate otherwise`, usual.every((name) => name !== "none") ? [] : [`no animation on: ${usual.join(", ")}`]);
    await moving.close();
  }
} finally {
  chrome.child.kill();
  service.close();
  rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 });
}

if (checks === 0) throw new Error("no check ran, so nothing was checked");
console.log(`\n${checks - failures.length} of ${checks} checks passed${options.screenshots === undefined ? "" : `; screenshots written to ${options.screenshots}`}`);
if (failures.length > 0) process.exitCode = 1;
