/**
 * Drives the page in a real browser and checks what the tests cannot reach: what a reader sees without
 * scrolling, the switching between the four sections, the page script, the layout, keyboard focus,
 * reduced motion, late answers, and that moving a what-if slider with the keyboard changes no file.
 *
 *   node tools/console-check.ts                               every check
 *   node tools/console-check.ts --first-screens               only what a reader sees without scrolling
 *   node tools/console-check.ts --base http://127.0.0.1:8787  against a service that is already running
 *
 * What a reader sees is behaviour, not look. The check is made in two fixed windows: 1280 by 640, a short
 * laptop window, and 390 by 664, a phone with the browser's bars taken off. In each, for every game on
 * every brand in the served version and for each of the four sections, the line saying what the page is,
 * the section's question and the sentence that answers it must be wholly on screen with no scrolling,
 * and so must the first game of a result.
 *
 * The examples are found the way the page finds them, by asking the service, so no game is named here.
 * It needs a local Chrome or Chromium (set CHROME to its path when it is not found) and no package:
 * it speaks the DevTools protocol over Node's own WebSocket. Without --base it starts the service in
 * this process on a free port. It reads no key, calls no model and writes no file.
 *
 * It is not part of `npm test`, because a machine without a browser cannot run it. Without a
 * browser it fails and says so. It judges nothing about how the page looks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createService } from "../src/service/http.ts";
import { findExamples, SECTIONS, type Example } from "../src/console/view.js";
import { loadService } from "../src/service/state.ts";

/** The two fixed windows every check is made in, and a narrow one for the layout alone. */
const WIDTHS = [
  { name: "laptop", width: 1280, height: 640, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 664, scale: 2, mobile: true },
] as const;
const NARROW = { name: "narrow", width: 320, height: 664, scale: 2, mobile: true } as const;
type Width = (typeof WIDTHS)[number] | typeof NARROW;

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
    if (element.closest(".scroll, .sr, .menu-body")) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.right > width + 0.5 || box.left < -0.5) problems.push(element.tagName.toLowerCase() + "." + element.className + " runs from " + Math.round(box.left) + " to " + Math.round(box.right) + "px");
  }
  return problems.slice(0, 5);
})()`;

/**
 * What a reader sees of one section with no scrolling: what the page is, the way to the other sections,
 * the section's question and the sentence that answers it, and the first game of a result.
 * "On screen" means wholly inside the window: a sentence cut off by the bottom edge does not count.
 * It is a function in the page, so that one call can look at every game.
 */
const SEEN = `((section) => {
  const problems = [];
  const onScreen = (element) => { if (!element) return false; const box = element.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; };
  const where = (element) => { const box = element.getBoundingClientRect(); return "it runs from " + Math.round(box.top) + " to " + Math.round(box.bottom) + "px in a window " + innerHeight + "px tall"; };
  if (scrollY !== 0) problems.push("the page is scrolled to " + Math.round(scrollY) + "px");
  const says = document.querySelector("header .kicker");
  if (!onScreen(says) || !/not the (screen|page) a player/i.test(says.textContent)) problems.push("the line saying what this page is, is not on screen");
  if (![...document.querySelectorAll("#tabs a")].every(onScreen) || document.querySelectorAll("#tabs a").length !== 4) problems.push("the four sections to switch between are not all on screen");
  const open = [...document.querySelectorAll("#trace section[data-section]")].filter((pane) => !pane.hidden);
  if (open.length !== 1 || open[0].dataset.section !== section) return [...problems, "the open section is " + (open.map((pane) => pane.dataset.section).join(" and ") || "none") + ", not " + section];
  const question = open[0].querySelector("[data-question]");
  const answer = open[0].querySelector("[data-answer]");
  if (!onScreen(question)) problems.push("the question is not on screen");
  if (!answer || answer.textContent.trim().length < 40) problems.push("the section has no sentence that answers its question");
  else if (!onScreen(answer)) problems.push("the answer is not on screen: " + where(answer));
  const first = open[0].querySelector("[data-results] li");
  if (first && !onScreen(first)) problems.push("the first game of the result is not on screen: " + where(first));
  if (section === "shown" && !first && !open[0].querySelector("[data-decline], .label.amber, .label.red")) problems.push("the first section shows neither a result nor a decline");
  return problems;
})`;

/**
 * Every game on every brand in the served version, each of the four sections, driven through the page's own
 * pickers and section links. One call, so that a few thousand views take seconds. It runs with reduced motion,
 * so a section is measured where it rests.
 */
const SWEEP = `(async () => {
  const seen = ${SEEN};
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const game = document.getElementById("game");
  const brand = document.getElementById("brand");
  const failures = [];
  let views = 0;
  for (const b of [...brand.options].map((option) => option.value)) {
    for (const g of [...game.options].map((option) => option.value)) {
      brand.value = b;
      game.value = g;
      game.dispatchEvent(new Event("change", { bubbles: true }));
      let waited = 0;
      while (!document.querySelector('#trace section[data-game="' + CSS.escape(g) + '"][data-brand="' + CSS.escape(b) + '"]')) {
        if ((waited += 5) > 8000) return { views, failures: [...failures, g + " on " + b + ": the page did not show it within 8 seconds"] };
        await pause(5);
      }
      for (const section of ${JSON.stringify(SECTIONS.map((entry) => entry.id))}) {
        document.querySelector('#tabs a[data-tab="' + section + '"]').click();
        views += 1;
        const problems = seen(section);
        if (problems.length > 0) failures.push(g + " on " + b + ", " + section + ": " + problems.join("; "));
      }
      document.querySelector('#tabs a[data-tab="shown"]').click();
    }
  }
  return { views, failures };
})()`;

/** What each example has to show, once opened. */
const SHOWS: Record<Example["kind"], string> = {
  thin: `(() => {
    const problems = [];
    if (!/thin/.test(document.querySelector("#enrichment [data-story]")?.textContent ?? "")) problems.push("the page does not say the record is thin");
    if (document.querySelectorAll("#enrichment .holds ul.fields .tag.model").length === 0) problems.push("the index holds no label from the model");
    if (!document.querySelector("#enrichment [data-phrase]")) problems.push("no phrase the model read is shown");
    if (document.querySelectorAll("#enrichment .copy mark").length === 0) problems.push("no quote is marked in the supplier's text");
    return problems;
  })()`,
  plain: `(() => {
    const problems = [];
    if (document.querySelectorAll("#enrichment .holds ul.fields .tag.model").length > 0) problems.push("the index holds a label from the model");
    if (document.querySelectorAll("#enrichment .holds ul.fields .tag.table").length === 0) problems.push("the index holds no label from the supplier's tags");
    if (document.querySelector("#enrichment [data-phrase]")) problems.push("a phrase from the model is shown though it added nothing");
    return problems;
  })()`,
  conflict: `(() => {
    const problems = [];
    if (!document.querySelector("#enrichment .tag.contradicted")) problems.push("no supplier tag is marked as contradicted");
    if (!/A lookup cannot tell which is right/.test(document.querySelector("#enrichment [data-story]")?.textContent ?? "")) problems.push("the page does not say what the table did");
    return problems;
  })()`,
  filter: `(() => {
    const problems = [];
    if (!document.querySelector("#removals [data-focus]")) problems.push("the removed game is not pointed out");
    if (document.querySelectorAll("#removals button.step[aria-expanded=true]").length !== 1) problems.push("the step that removed it is not the one open step");
    const row = document.querySelector("#removals .step-panel:not([hidden]) li.focus");
    if (!row || row.getBoundingClientRect().height === 0) problems.push("the removed game is not visible in that step");
    return problems;
  })()`,
  decline: `(() => {
    const problems = [];
    if (!document.querySelector("#outcome [data-decline]")) problems.push("the outcome is not a decline");
    if (document.querySelector("#trace [data-results]")) problems.push("results are shown beside the decline");
    if (document.querySelector("#outcome .label.red")) problems.push("the decline carries a failure label");
    return problems;
  })()`,
  versions: `(() => {
    if (!document.querySelector("#versions")?.open) return ["the comparison of versions is not open"];
    const rows = [...document.querySelectorAll("#compare table.matrix tbody tr")];
    if (rows.length === 0) return ["no version recommends anything"];
    const columns = rows[0].querySelectorAll("td").length;
    const picks = [...Array(columns).keys()].map((column) => rows.map((row) => row.querySelectorAll("td")[column].textContent).join("|"));
    return new Set(picks).size > 1 ? [] : ["every version recommends the same games in the same order"];
  })()`,
  failure: `(() => (document.querySelector("#outcome [data-failure]") ? [] : ["the failure the evaluation lists is not said with the result"]))()`,
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { values: options } = parseArgs({ options: { base: { type: "string" }, "first-screens": { type: "boolean", default: false } }, strict: true });
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

/** A check that asks the page. If the page cannot even be asked, that is a failure of the check, and the run goes on. */
async function ask(name: string, work: () => Promise<readonly string[]>): Promise<void> {
  try {
    check(name, await work());
  } catch (error) {
    check(name, [error instanceof Error ? error.message : String(error)]);
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

const service = options.base === undefined ? createService(loadService()) : undefined;
if (service !== undefined) await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
const base = options.base ?? `http://127.0.0.1:${(service?.address() as AddressInfo).port}`;

// The examples, found the way the page finds them: by asking the service.
const get = async (url: string): Promise<unknown> => {
  const response = await fetch(`${base}${url}`);
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
};
const catalogue = (await get("/api/catalogue")) as { brands: { brand: string }[]; games: { game_id: string }[]; served: { version: string } };
const examples = await findExamples(get, catalogue, await get("/api/evaluation"));
const found = examples.filter((example) => example.found && example.href !== undefined);
check("the service's data holds every kind of example", examples.filter((example) => !example.found).map((example) => `no game shows: ${example.name}`));

const chrome = await launchChrome();

/** Arrives at an address as a reader does, and waits until the page has settled. Nothing here scrolls. */
async function arrive(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.waitFor("document.querySelector('#trace section[data-section]') && document.querySelector('#evaluation-body')?.children.length > 1 && document.querySelector('#examples a')", "the sections, the evaluation and the examples");
  await sleep(700); // the section has finished arriving and the bars have finished growing
}
const sectionOf = (example: Example): string => example.section ?? "shown";

try {
  for (const view of WIDTHS) {
    const at = `${view.name} ${view.width}x${view.height}`;

    // 1. UI-13. Every game on every brand, each of the four sections: the question and its answer are on screen.
    const still = await openPage(chrome.port, view, true);
    await ask(`${at}: UI-13: for every game on every brand in the served version, each of the four sections shows its question and its answer without scrolling`, async () => {
      await arrive(still, "/");
      const swept = await still.evaluate<{ views: number; failures: string[] }>(SWEEP);
      const expected = catalogue.brands.length * catalogue.games.length * SECTIONS.length;
      const problems = swept.views === expected ? [] : [`${swept.views} views were looked at, not the ${expected} that ${catalogue.games.length} games on ${catalogue.brands.length} brands in ${SECTIONS.length} sections make`];
      return [...problems, ...(swept.failures.length > 8 ? [...swept.failures.slice(0, 8), `and ${swept.failures.length - 8} more`] : swept.failures)];
    });
    check(`${at}: the page script raised no error while every game was shown`, still.errors);
    await still.close();

    // 2. The same on arrival, with motion as a reader has it: the landing page, then every example at its own section.
    const page = await openPage(chrome.port, view);
    for (const [name, path, section] of [["landing", "/", "shown"], ...found.map((example) => [example.kind, example.href as string, sectionOf(example)])] as [string, string, string][]) {
      await ask(`${at}: UI-13: ${name}: on arrival the question and its answer are on screen`, async () => {
        await arrive(page, path);
        return page.evaluate<string[]>(`${SEEN}(${JSON.stringify(section)})`);
      });
      if (options["first-screens"]) continue;
      await ask(`${at}: ${name}: nothing is wider than the window`, () => page.evaluate<string[]>(LAYOUT));
      const example = found.find((entry) => entry.kind === name);
      if (example === undefined) continue;
      await ask(`${at}: ${name}: the example shows what it says (${example.name})`, async () => {
        if (example.kind === "versions") await page.waitFor("document.querySelector('#compare table.matrix')", "the comparison of versions");
        return page.evaluate<string[]>(SHOWS[example.kind]);
      });
    }
    if (options["first-screens"]) {
      await page.close();
      continue;
    }

    // 3. Switching sections: one is open at a time, the address says which, and that address opens the same view.
    await ask(`${at}: a section link opens that section alone, keeps focus, moves with a transition, and the address opens the same view`, async () => {
      await arrive(page, "/");
      const problems: string[] = [];
      for (const section of SECTIONS.map((entry) => entry.id).reverse()) {
        await page.evaluate(`document.querySelector('#tabs a[data-tab="${section}"]').click()`);
        const now = await page.evaluate<{ open: string[]; current: string[]; focus: string | null; address: string | null; moving: string; evaluation: boolean }>(`(() => ({
          open: [...document.querySelectorAll("#trace section[data-section]")].filter((pane) => !pane.hidden).map((pane) => pane.dataset.section),
          current: [...document.querySelectorAll('#tabs a[aria-current="true"]')].map((tab) => tab.dataset.tab),
          focus: document.activeElement?.dataset?.tab ?? null,
          address: new URLSearchParams(location.search).get("section"),
          moving: getComputedStyle(document.querySelector("#trace section:not([hidden]) .reply")).animationName,
          evaluation: !document.getElementById("evaluation").hidden,
        }))()`);
        if (now.open.join() !== section) problems.push(`${section}: the open sections are ${now.open.join(" and ") || "none"}`);
        if (now.current.join() !== section) problems.push(`${section}: the link marked as open is ${now.current.join(" and ") || "none"}`);
        if (now.focus !== section) problems.push(`${section}: focus left the link that was used`);
        if (now.address !== section) problems.push(`${section}: the address says ${now.address}`);
        if (now.moving === "none") problems.push(`${section}: the section arrived with no transition`);
        if (now.evaluation !== (section === "worth")) problems.push(`${section}: the evidence for the fourth section is ${now.evaluation ? "shown" : "hidden"}`);
        await sleep(450);
        problems.push(...(await page.evaluate<string[]>(`${SEEN}(${JSON.stringify(section)})`)).map((problem) => `${section}: ${problem}`));
        const address = await page.evaluate<string>("location.pathname + location.search");
        await arrive(page, address);
        problems.push(...(await page.evaluate<string[]>(`${SEEN}(${JSON.stringify(section)})`)).map((problem) => `${section}, opened by its address: ${problem}`));
      }
      return problems;
    });

    // 4. The examples are a menu: closed on arrival, every example the data holds is in it, and choosing one opens its section.
    await ask(`${at}: the examples are a closed menu that offers every example, and choosing one opens the section that shows it`, async () => {
      await arrive(page, "/");
      const problems: string[] = [];
      if (await page.evaluate<boolean>("document.getElementById('examples-menu').open")) problems.push("the menu is open on arrival");
      await page.evaluate("document.querySelector('#examples-menu summary').click()");
      const offered = await page.evaluate<string[]>("[...document.querySelectorAll('#examples a[data-example]')].filter((a) => a.getBoundingClientRect().height > 0).map((a) => a.getAttribute('href'))");
      problems.push(...found.filter((example) => !offered.includes(example.href as string)).map((example) => `the menu does not offer: ${example.name}`));
      const pick = found.find((example) => example.kind === "filter") ?? found.at(-1);
      if (pick === undefined) return [...problems, "there is no example to choose"];
      await page.evaluate(`document.querySelector('#examples a[data-example="${pick.kind}"]').click()`);
      await page.waitFor(`document.querySelector('#trace section[data-game="${pick.game}"]')`, "the chosen example");
      await sleep(600);
      if (await page.evaluate<boolean>("document.getElementById('examples-menu').open")) problems.push("the menu stayed open over the page");
      return [...problems, ...(await page.evaluate<string[]>(`${SEEN}(${JSON.stringify(sectionOf(pick))})`)), ...(await page.evaluate<string[]>(SHOWS[pick.kind]))];
    });

    // 5. A step of the path opens what it removed, and only one is open at a time.
    await ask(`${at}: a step opens what it removed, one at a time`, async () => {
      const example = found.find((entry) => entry.kind === "thin") ?? found[0];
      if (example === undefined) return ["there is no example to open"];
      await arrive(page, `/?${new URLSearchParams({ game: example.game as string, brand: example.brand as string, section: "removed" })}`);
      return page.evaluate<string[]>(`(() => {
        const steps = [...document.querySelectorAll("#removals button.step")];
        if (steps.length < 2) return ["the path has fewer than two steps"];
        const panel = (button) => document.getElementById(button.getAttribute("aria-controls"));
        const problems = [];
        if (steps.some((step) => !panel(step).hidden)) problems.push("a step is open before any is asked for");
        steps[0].click();
        if (panel(steps[0]).hidden || steps[0].getAttribute("aria-expanded") !== "true") problems.push("the first step did not open");
        steps[1].click();
        if (!panel(steps[0]).hidden || panel(steps[1]).hidden) problems.push("opening a second step left the first open");
        steps[1].click();
        if (!panel(steps[1]).hidden) problems.push("a step did not close");
        return problems;
      })()`);
    });

    // 6. UI-17. Two requests in quick succession over a slow connection: the page shows the second, whichever answer comes last.
    await ask(`${at}: UI-17: with 100 ms of network delay, choosing two examples in quick succession leaves the page showing the second`, async () => {
      const [slow, quick] = [found.find((example) => example.kind === "thin"), found.find((example) => example.kind === "decline")];
      if (slow === undefined || quick === undefined) return ["the data holds no pair of examples to choose"];
      await arrive(page, "/");
      await page.send("Network.enable");
      await page.send("Network.emulateNetworkConditions", { offline: false, latency: 100, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        // The first needs more requests than the second, so its answer arrives last.
        await page.evaluate(`document.querySelector('#examples a[data-example="${quick.kind}"]').click()`);
        await page.waitFor(`document.querySelector('#trace section[data-game="${quick.game}"]')`, "the page to settle on a first request");
        await page.evaluate(`document.querySelector('#examples a[data-example="${slow.kind}"]').click(); document.querySelector('#examples a[data-example="${quick.kind}"]').click();`);
        await sleep(4000);
      } finally {
        await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
      const now = await page.evaluate<{ picker: string; shown: string | null }>("({ picker: document.getElementById('game').value, shown: document.querySelector('#trace section[data-game]')?.dataset.game ?? null })");
      const problems = now.picker === quick.game ? [] : [`the picker holds ${now.picker}, not the second choice`];
      return now.shown === now.picker ? problems : [...problems, `the picker and the address say ${now.picker}, and the page shows ${now.shown}`];
    });

    // 7. UI-18. An address is taken as written.
    await ask(`${at}: UI-18: a brand in the wrong case is reported as unknown, in the service's words, and a brand with no game is kept`, async () => {
      const home = found[0]?.brand ?? (catalogue.brands[0]?.brand as string);
      const loud = home.toUpperCase();
      const problems: string[] = [];
      const errorsBefore = page.errors.length;
      await page.goto(`${base}/?${new URLSearchParams({ game: catalogue.games[0]?.game_id as string, brand: loud })}`);
      await page.waitFor("document.querySelector('#trace .label') && !/Loading/.test(document.getElementById('trace').textContent)", "an answer to a brand in the wrong case");
      const said = await page.evaluate<{ text: string; brand: string }>("({ text: document.getElementById('trace').textContent, brand: document.getElementById('brand').value })");
      if (!said.text.includes("unknown brand") || !said.text.includes(loud)) problems.push(`the page says: ${said.text.trim().slice(0, 120)}`);
      if (said.text.includes("is required")) problems.push("the brand is called missing");
      if (said.brand !== loud) problems.push(`the brand picker holds ${said.brand}, not the brand as written`);
      // The service's refusals of that brand are what was asked for, not errors of the page script.
      page.errors.splice(errorsBefore, page.errors.length, ...page.errors.slice(errorsBefore).filter((error) => !(error.includes("400") && error.includes(`brand=${loud}`))));
      const other = catalogue.brands.map((entry) => entry.brand).find((brand) => brand !== home) ?? home;
      await arrive(page, `/?${new URLSearchParams({ brand: other })}`);
      const kept = await page.evaluate<{ brand: string; shown: string | null }>("({ brand: document.getElementById('brand').value, shown: document.querySelector('#trace section[data-brand]')?.dataset.brand ?? null })");
      if (kept.brand !== other || kept.shown !== other) problems.push(`asked for ${other} with no game: the picker holds ${kept.brand} and the page shows ${kept.shown}`);
      return problems;
    });

    // 8. The evidence for the fourth section, then the what-if panel driven with the keyboard alone.
    const before = service === undefined ? "" : hashTree(["eval", "data"]);
    const rings: string[] = [];
    const focused = (): Promise<{ id: string; type: string; ring: boolean; what: string }> =>
      page.evaluate(`(() => { const a = document.activeElement; const s = getComputedStyle(a); return { id: a.id, type: a.type ?? "", ring: s.outlineStyle === "solid" && parseFloat(s.outlineWidth) >= 2, what: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.className && typeof a.className === "string" ? "." + a.className.split(" ")[0] : "") }; })()`);
    const tabTo = async (wanted: (element: { id: string; type: string }) => boolean, what: string): Promise<void> => {
      for (let presses = 0; presses < 300; presses += 1) {
        await page.key("Tab", 9);
        const now = await focused();
        if (now.what === "body") continue;
        if (!now.ring) rings.push(`${now.what} takes focus with no visible ring`);
        if (wanted(now)) return;
      }
      throw new Error(`300 presses of Tab did not reach ${what}`);
    };
    await ask(`${at}: the what-if panel opens and moves with the keyboard, says what the gate reads, and changes no file${service === undefined ? " (files not hashed: the service is not this checkout's)" : ""}`, async () => {
      await arrive(page, "/?section=worth");
      await page.evaluate("document.body.focus(); window.scrollTo(0, 0)");
      await tabTo((element) => element.id === "what-if-open", "the what-if button");
      await page.key("Enter", 13, "\r");
      await page.waitFor("document.querySelector('#what-if .mark')", "the what-if panel");
      const committedFails = await page.evaluate<number>("document.querySelectorAll('#what-if .label.red').length");
      await tabTo((element) => element.type === "range" && element.id === "mark-min_pairwise_accuracy", "the pairwise accuracy slider");
      // Raise the mark a step at a time until a version that passed now fails.
      for (let step = 1; step <= 25; step += 1) {
        await page.key("ArrowRight", 39);
        await page.waitFor("document.querySelectorAll('#what-if .mark.moved').length === 1", "the moved mark");
        await sleep(200);
        if ((await page.evaluate<number>("document.querySelectorAll('#what-if .label.red').length")) > committedFails) break;
      }
      const problems = await page.evaluate<string[]>(`(() => {
        const panel = document.querySelector("#what-if");
        const problems = [];
        if (!panel.textContent.includes("The release gate reads only the committed file")) problems.push("the panel does not say what the gate reads");
        if (panel.querySelectorAll(".tick").length !== panel.querySelectorAll("input[type=range]").length) problems.push("a slider has no committed tick");
        if (panel.querySelectorAll(".label.amber").length < 2) problems.push("the moved mark is not labelled");
        if (document.activeElement?.id !== "mark-min_pairwise_accuracy") problems.push("the slider lost focus when the panel was redrawn");
        if (panel.querySelectorAll(".label.red").length <= ${committedFails}) problems.push("raising the mark failed no version");
        return problems;
      })()`);
      return service === undefined || hashTree(["eval", "data"]) === before ? problems : [...problems, "a file under eval/ or data/ changed"];
    });
    check(`${at}: every control reached with Tab shows a focus ring`, rings);
    await ask(`${at}: the open what-if panel is no wider than the window`, () => page.evaluate<string[]>(LAYOUT));

    // 9. Every drawer open, in every section: nothing is wider than the window. Then the same in a narrow window.
    const OPEN_ALL = "for (const drawer of document.querySelectorAll('details.drawer, .gallery details')) drawer.open = true";
    for (const window of [view, NARROW] as const) {
      await ask(`${at}: with every drawer open, no section is wider than a ${window.width} px window`, async () => {
        const example = found.find((entry) => entry.kind === "conflict") ?? found[0];
        if (example === undefined) return ["there is no example to open"];
        await page.send("Emulation.setDeviceMetricsOverride", windowOf(window));
        const problems: string[] = [];
        for (const section of SECTIONS) {
          await arrive(page, `/?${new URLSearchParams({ game: example.game as string, brand: example.brand as string, section: section.id })}`);
          await page.evaluate(OPEN_ALL);
          await page.waitFor("document.querySelector('#compare table') || document.getElementById('evaluation').hidden", "the comparison of versions");
          problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `${section.id}: ${problem}`));
        }
        return problems;
      });
    }
    await page.send("Emulation.setDeviceMetricsOverride", windowOf(view));
    check(`${at}: the page script raised no error`, page.errors);
    await page.close();

    // 10. Motion: there is some by default, and none for a reader who asked for less.
    const animated = `(() => { document.querySelector('#tabs a[data-tab="worth"]').click(); return ["#trace section:not([hidden]) .ask", "#trace section:not([hidden]) .reply", "#outcome ol.results li", "aside.worth .track .fill"].map((selector) => { const element = document.querySelector(selector); return element ? getComputedStyle(element).animationName : "missing: " + selector; }); })()`;
    const path = (found.find((example) => example.kind === "thin") ?? found[0])?.href ?? "/";
    for (const [reduced, name] of [[true, "nothing animates under prefers-reduced-motion"], [false, "the same parts do animate otherwise"]] as const) {
      const probe = await openPage(chrome.port, view, reduced);
      await ask(`${at}: ${name}`, async () => {
        await arrive(probe, path);
        const names = await probe.evaluate<string[]>(animated);
        return names.every((animation) => (reduced ? animation === "none" : animation !== "none" && !animation.startsWith("missing"))) ? [] : [`animations: ${names.join(", ")}`];
      });
      await probe.close();
    }
  }
} finally {
  chrome.child.kill();
  service?.close();
  rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 });
}

if (checks === 0) throw new Error("no check ran, so nothing was checked");
console.log(`\n${checks - failures.length} of ${checks} checks passed`);
if (failures.length > 0) process.exitCode = 1;
