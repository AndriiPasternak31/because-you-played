/**
 * Drives the page in a real browser and checks what the tests cannot reach: what a visitor sees on
 * arrival, the four sections and their transitions, the evidence drawer, the keyboard, reduced motion,
 * a browser without WebGL2, a slow connection, a bad address, and that nothing is asked of another machine.
 *
 *   node tools/console-check.ts                                  every check
 *   node tools/console-check.ts --first-screens                  only what a visitor sees on arrival
 *   node tools/console-check.ts --every-request                  the first screen of every game on every brand (minutes)
 *   node tools/console-check.ts --base http://127.0.0.1:8787     against a service that is already running
 *   node tools/console-check.ts --also "/?game=<id>&brand=<brand>"   the first screen of that address too (repeatable)
 *
 * The first screen is behaviour, not look: on arrival, with no scrolling, the top panel, the one question
 * that is open, the sentence that answers it and the first thing of the answer are wholly inside the window.
 * It is checked for the landing page and every example at four windows (a desktop, a short laptop, a phone,
 * and the same phone with the browser's bars taken off), and with --every-request for every game on every
 * brand in the served version at the short laptop and the phone without bars, and for every other version
 * at the phone without bars.
 *
 * The examples are found the way the page finds them, by asking the service, so no game is named here.
 * It needs a local Chrome or Chromium (set CHROME to its path when it is not found) and no package beyond
 * the repository's own: it speaks the DevTools protocol over Node's own WebSocket. Without --base it starts
 * the service in this process on a free port. It reads no key and calls no model.
 *
 * It is not part of `npm test`, because a machine without a browser cannot run it. Without a browser it
 * fails and says so. It judges nothing about how the page looks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EVIDENCE } from "../src/console/view.ts";
import { TABS, addressOf, findExamples, type Catalogue, type Evaluation, type Example } from "../src/console/read.ts";
import { createService } from "../src/service/http.ts";
import { loadService } from "../src/service/state.ts";

/** The windows a first screen is checked in. The first and the third are the ones every other check is made in. */
const WIDTHS = [
  { name: "desktop", width: 1280, height: 900, scale: 1, mobile: false },
  { name: "short laptop", width: 1366, height: 657, scale: 1, mobile: false },
  { name: "phone", width: 390, height: 844, scale: 2, mobile: true },
  { name: "phone without bars", width: 390, height: 664, scale: 2, mobile: true },
] as const;
type Width = { name: string; width: number; height: number; scale: number; mobile: boolean };
const NARROW: Width = { name: "narrow phone", width: 320, height: 568, scale: 2, mobile: true };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const windowOf = (view: Width): Record<string, unknown> => ({ width: view.width, height: view.height, deviceScaleFactor: view.scale, mobile: view.mobile });

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

interface Browser {
  port: number;
  child: ChildProcess;
  profile: string;
}

/** A browser of its own: a fresh profile and a debugging port the system picks. `flags` are added to its command line. */
async function launchChrome(flags: readonly string[] = []): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "console-check-"));
  const child = spawn(findChrome(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", ...flags, "about:blank"], { stdio: "ignore" });
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

function closeChrome(browser: Browser): void {
  browser.child.kill();
  rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5 });
}

interface Page {
  errors: string[];
  /** Every address the page asked for. */
  requests: string[];
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
  const requests: string[] = [];
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
    } else if (message.method === "Runtime.consoleAPICalled") {
      const call = message.params as { type: string; args: { value?: unknown; description?: string }[] };
      if (call.type === "error") errors.push(`console.error: ${call.args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" ").slice(0, 300)}`);
    } else if (message.method === "Network.requestWillBeSent") {
      requests.push((message.params as { request: { url: string } }).request.url);
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
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", windowOf(view));
  if (reducedMotion) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (reply.exceptionDetails !== undefined) throw new Error(`the page threw while evaluating ${expression.slice(0, 80)}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
    return reply.result.value;
  };
  const waitFor = async (expression: string, what: string): Promise<void> => {
    for (let waited = 0; waited < 10000; waited += 50) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await sleep(50);
    }
    throw new Error(`waited 10 seconds for ${what}, and it did not appear`);
  };
  return {
    errors,
    requests,
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

/** The page has its answer, has found its examples, and its section has finished arriving. */
const SETTLED = `document.querySelector("main[data-ready][data-examples=found] [data-section]") && document.querySelectorAll("[data-slot=tabs-panel]").length === 1 && !document.querySelector("[data-starting-style], [data-ending-style]")`;

/**
 * Nothing on the page may be wider than the window, except what scrolls inside its own box.
 * The glow the metal effect draws around its button is clipped by the top panel, so it is not counted.
 */
const LAYOUT = `(() => {
  const width = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > width) problems.push("the page is " + document.documentElement.scrollWidth + "px wide in a " + width + "px window");
  if (document.body.scrollWidth > width) problems.push("the body is " + document.body.scrollWidth + "px wide in a " + width + "px window");
  for (const element of document.querySelectorAll("body *")) {
    if (element.closest(".scroll, .sr, canvas, .removed") || element.tagName === "CANVAS") continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // A sheet that slides in rests within a pixel of the edge; what matters is that the page itself does not scroll (above).
    if (box.right > width + 1.5 || box.left < -1.5) problems.push(element.tagName.toLowerCase() + "." + (typeof element.className === "string" ? element.className : "") + " runs from " + Math.round(box.left) + " to " + Math.round(box.right) + "px");
  }
  return problems.slice(0, 5);
})()`;

/**
 * What a visitor sees on arrival, with no scrolling: the top panel, one question, and its answer.
 * "On screen" means wholly inside the window: a result cut off by the bottom edge does not count.
 */
const FIRST_SCREEN = `(() => {
  const problems = [];
  const where = (element) => { const box = element.getBoundingClientRect(); return "it runs from " + Math.round(box.top) + " to " + Math.round(box.bottom) + "px in a window " + innerHeight + "px tall"; };
  const onScreen = (element) => { if (!element) return false; const box = element.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; };
  if (scrollY !== 0) problems.push("the page arrived scrolled to " + Math.round(scrollY) + "px");
  const what = document.querySelector("[data-what]");
  if (!onScreen(what) || !/not the (screen|page) a player/i.test(what.textContent)) problems.push("the line saying what this page is, is not on screen");
  const tabs = [...document.querySelectorAll("[role=tablist] [role=tab]")];
  if (tabs.length !== 4 || !tabs.every(onScreen)) problems.push("the four tabs of the top panel are not all on screen");
  if (tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length !== 1) problems.push("not exactly one tab is selected");
  const sections = [...document.querySelectorAll("[data-section]")].filter((section) => section.getBoundingClientRect().height > 0);
  if (sections.length !== 1) return [...problems, sections.length + " sections are on the page, not one"];
  const section = sections[0];
  for (const [name, selector] of [["the question", "[data-question]"], ["the sentence that answers it", "[data-answer]"], ["the first thing of the answer", "[data-first]"]]) {
    const element = section.querySelector(selector);
    if (!element) problems.push(name + " is missing from the section " + section.dataset.section);
    else if (!onScreen(element)) problems.push(name + " is not on screen: " + where(element));
  }
  const question = section.querySelector("[data-question]");
  const answer = section.querySelector("[data-answer]");
  if (question && answer && innerWidth >= 900 && question.getBoundingClientRect().right > answer.getBoundingClientRect().left) problems.push("the question is not to the left of its answer");
  return problems;
})()`;

/** What each example has to show, once opened, in the section it opens. */
const SHOWS: Record<Example["kind"], string> = {
  thin: `(() => {
    const problems = [];
    const section = document.querySelector("[data-section=added]");
    if (!section) return ["the section Added is not the one open"];
    if (!/thin/.test(section.querySelector("[data-story]")?.textContent ?? "")) problems.push("the page does not say the record is thin");
    if (section.querySelectorAll(".holds ul.fields .tag.model").length === 0) problems.push("the index holds no label from the model");
    if (section.querySelectorAll(".copy mark").length === 0) problems.push("no quote is marked in the supplier's text");
    return problems;
  })()`,
  plain: `(() => {
    const problems = [];
    const section = document.querySelector("[data-section=added]");
    if (!section) return ["the section Added is not the one open"];
    if (section.querySelectorAll(".holds ul.fields .tag.model").length > 0) problems.push("the index holds a label from the model");
    if (section.querySelectorAll(".holds ul.fields .tag.table").length === 0) problems.push("the index holds no label from the supplier's tags");
    return problems;
  })()`,
  conflict: `(() => {
    const problems = [];
    const section = document.querySelector("[data-section=added]");
    if (!section) return ["the section Added is not the one open"];
    if (!section.querySelector(".tag.contradicted")) problems.push("no supplier tag is marked as contradicted");
    if (!/A lookup cannot tell which is right/.test(section.querySelector("[data-story]")?.textContent ?? "")) problems.push("the page does not say what the table did");
    return problems;
  })()`,
  filter: `(() => {
    const problems = [];
    const section = document.querySelector("[data-section=removed]");
    if (!section) return ["the section Removed is not the one open"];
    if (!section.querySelector("[data-focus]")) problems.push("the removed game is not pointed out");
    if (section.querySelectorAll("button.step[aria-expanded=true]").length !== 1) problems.push("the step that removed it is not the one open step");
    const row = section.querySelector(".step-panel li.focus");
    if (!row || row.getBoundingClientRect().height === 0) problems.push("the removed game is not visible in that step");
    return problems;
  })()`,
  decline: `(() => {
    const problems = [];
    const section = document.querySelector("[data-section=shown]");
    if (!section) return ["the section Shown is not the one open"];
    if (!section.querySelector("[data-decline]")) problems.push("the outcome is not a decline");
    if (section.querySelector("[data-results]")) problems.push("results are shown beside the decline");
    if (section.querySelector(".label.red")) problems.push("the decline carries a failure label");
    return problems;
  })()`,
  versions: `(() => {
    const section = document.querySelector("[data-section=worth]");
    if (!section) return ["the section Worth it is not the one open"];
    const lines = [...section.querySelectorAll("[data-others] li")].map((line) => line.lastElementChild.textContent);
    if (lines.length === 0) return ["no other version is compared"];
    return lines.some((line) => line !== "the same games, same order") ? [] : ["every version returns the same games in the same order"];
  })()`,
  failure: `(() => (document.querySelector("[data-section] [data-failure]") ? [] : ["the failure the evaluation lists is not said in the section the example opens"]))()`,
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { values: options } = parseArgs({ options: { base: { type: "string" }, "first-screens": { type: "boolean", default: false }, "every-request": { type: "boolean", default: false }, also: { type: "string", multiple: true, default: [] } }, strict: true });
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
const catalogue = (await get("/api/catalogue")) as Catalogue;
const examples = await findExamples(get, catalogue, (await get("/api/evaluation")) as Evaluation);
const found = examples.filter((example) => example.found && example.href !== undefined);
check("the service's data holds every kind of example", examples.filter((example) => !example.found).map((example) => `no game shows: ${example.name}`));

/** Arrives at an address as a visitor does, and waits until the page has settled. Nothing here scrolls. */
async function arrive(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.waitFor(SETTLED, `${path} to show its section`);
  await sleep(450); // the section has finished arriving
}

const everyAsked: string[] = [];
const chrome = await launchChrome(["--enable-unsafe-swiftshader"]);

/** The first screen of many addresses, several tabs at a time. Returns the addresses that failed, each with what was wrong. */
async function firstScreens(view: Width, paths: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const queue = [...paths];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const page = await openPage(chrome.port, view);
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        try {
          await page.goto(`${base}${path}`);
          await page.waitFor(`document.querySelector("main[data-ready] [data-section]") && !document.querySelector("[data-starting-style], [data-ending-style]")`, `${path} to show its section`);
          await sleep(380);
          const wrong = await page.evaluate<string[]>(FIRST_SCREEN);
          if (wrong.length > 0) problems.push(`${path}: ${wrong.join("; ")}`);
        } catch (error) {
          problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      everyAsked.push(...page.requests);
      await page.close();
    }),
  );
  return problems;
}

try {
  if (options["every-request"]) {
    // Every game on every brand: the served version at a short laptop and a phone without its bars, every other version at that phone.
    const laptop = WIDTHS[1];
    const phone = WIDTHS[3];
    const all = (version: string): string[] => catalogue.brands.flatMap(({ brand }) => catalogue.games.map((game) => addressOf({ game: game.game_id, brand, version }, catalogue.served.version)));
    for (const [view, version] of [[laptop, catalogue.served.version], [phone, catalogue.served.version], ...catalogue.versions.filter((version) => version !== catalogue.served.version).map((version) => [phone, version] as const)] as const) {
      const paths = all(version);
      const problems = await firstScreens(view, paths);
      check(`${view.name} ${view.width}x${view.height}: ${version}: the first screen of every game on every brand shows the top panel, the question and its answer, without scrolling (${paths.length} addresses)`, problems.length > 8 ? [...problems.slice(0, 8), `and ${problems.length - 8} more`] : problems);
    }
  } else {
    for (const view of WIDTHS) {
      const page = await openPage(chrome.port, view);
      const at = `${view.name} ${view.width}x${view.height}`;
      const full = (view.name === "desktop" || view.name === "phone") && !options["first-screens"];

      // 1. The first screen: the landing page, then every example, each on arrival.
      const arrivals = [["landing", "/"], ...found.map((example) => [example.kind, example.href as string]), ...options.also.map((path, index) => [`address ${index + 1} (${path})`, path])] as [string, string][];
      for (const [name, path] of arrivals) {
        await ask(`${at}: ${name}: on arrival the top panel, one question and its answer are on screen, without scrolling`, async () => {
          await arrive(page, path);
          return page.evaluate<string[]>(FIRST_SCREEN);
        });
        if (!full) continue;
        await ask(`${at}: ${name}: nothing is wider than the window`, () => page.evaluate<string[]>(LAYOUT));
        const example = found.find((entry) => entry.kind === name);
        if (example !== undefined) await ask(`${at}: ${name}: the example shows what it says (${example.name})`, () => page.evaluate<string[]>(SHOWS[example.kind]));
      }
      if (!full) {
        everyAsked.push(...page.requests);
        await page.close();
        continue;
      }

      // 2. The four sections: one at a time, switched from the top panel by a press and by the arrow keys.
      await ask(`${at}: the top panel switches between four sections, one on screen at a time, by a press and by the arrow keys`, async () => {
        await arrive(page, "/");
        const problems: string[] = [];
        const open = (): Promise<string[]> => page.evaluate<string[]>(`[...document.querySelectorAll("[data-section]")].filter((section) => section.getBoundingClientRect().height > 0).map((section) => section.dataset.section)`);
        for (const tab of TABS) {
          await page.evaluate(`[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes(${JSON.stringify(tab.name)})).click()`);
          await page.waitFor(SETTLED, `the section ${tab.name}`);
          const now = await open();
          if (now.length !== 1 || now[0] !== tab.id) problems.push(`after a press on ${tab.name} the page shows: ${now.join(", ") || "nothing"}`);
          if (!(await page.evaluate<boolean>(`new URLSearchParams(location.search).get("tab") === ${JSON.stringify(tab.id === "shown" ? null : tab.id)}`))) problems.push(`the address does not follow the section ${tab.name}`);
          problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `${tab.name}: ${problem}`));
        }
        // From the last tab, the left arrow goes back one section, and Home to the first.
        await page.evaluate(`document.querySelector("[role=tab][aria-selected=true]").focus()`);
        await page.key("ArrowLeft", 37);
        await page.waitFor(SETTLED, "the section before the last");
        if ((await open())[0] !== TABS[2].id) problems.push("the left arrow did not open the section before");
        await page.key("Home", 36);
        await page.waitFor(SETTLED, "the first section");
        if ((await open())[0] !== TABS[0].id) problems.push("Home did not open the first section");
        return problems;
      });

      // 3. The examples are the ones the data holds, behind one button, and one press opens one with its answer on screen.
      await ask(`${at}: the Examples button offers every example, out of sight until pressed, and a press on one opens it with its answer on screen`, async () => {
        await arrive(page, "/");
        const problems: string[] = [];
        if ((await page.evaluate<number>(`[...document.querySelectorAll("a[data-example]")].filter((a) => a.getBoundingClientRect().height > 0).length`)) > 0) problems.push("the examples are on screen before they are asked for");
        await page.evaluate(`document.querySelector("#examples-open").click()`);
        await page.waitFor(`document.querySelectorAll("a[data-example]").length > 0`, "the examples");
        const offered = await page.evaluate<string[]>("[...document.querySelectorAll('a[data-example]')].map((a) => a.getAttribute('href'))");
        problems.push(...found.filter((example) => !offered.includes(example.href as string)).map((example) => `the page does not offer: ${example.name}`));
        problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `with the examples open: ${problem}`));
        const pick = found.find((example) => example.kind === "decline") ?? found.at(-1);
        if (pick === undefined) return [...problems, "there is no example to press"];
        await page.evaluate(`document.querySelector('a[data-example="${pick.kind}"]').click()`);
        await page.waitFor(`document.querySelector("main").dataset.request?.startsWith(${JSON.stringify(`${pick.game} ${pick.brand} `)}) && ${SETTLED}`, "the pressed example to open");
        await sleep(450);
        if (!(await page.evaluate<boolean>(`location.pathname + location.search === ${JSON.stringify(pick.href)}`))) problems.push("the address is not the example's");
        return [...problems, ...(await page.evaluate<string[]>(FIRST_SCREEN)), ...(await page.evaluate<string[]>(SHOWS[pick.kind]))];
      });

      // 4. A step of the path opens what it removed, and only one is open at a time.
      await ask(`${at}: a step opens what it removed, one at a time`, async () => {
        const example = found.find((entry) => entry.kind === "thin") ?? found[0];
        if (example?.game === undefined || example.brand === undefined) return ["there is no example to open"];
        await arrive(page, addressOf({ game: example.game, brand: example.brand, tab: "removed" }, catalogue.served.version));
        const openSteps = `[...document.querySelectorAll("[data-section=removed] button.step")].filter((step) => step.getAttribute("aria-expanded") === "true").length`;
        const problems: string[] = [];
        if ((await page.evaluate<number>(`document.querySelectorAll("[data-section=removed] button.step").length`)) < 2) return ["the path has fewer than two steps"];
        if ((await page.evaluate<number>(openSteps)) !== 0 || (await page.evaluate<number>(`document.querySelectorAll(".step-panel").length`)) !== 0) problems.push("a step is open before any is asked for");
        for (const [index, want] of [[0, 1], [1, 1], [1, 0]] as const) {
          await page.evaluate(`document.querySelectorAll("[data-section=removed] button.step")[${index}].click()`);
          await sleep(350);
          const [open, panels] = [await page.evaluate<number>(openSteps), await page.evaluate<number>(`[...document.querySelectorAll(".step-panel")].filter((panel) => panel.getBoundingClientRect().height > 0).length`)];
          if (open !== want || panels !== want) problems.push(`after a press on step ${index + 1}, ${open} steps are open and ${panels} lists are shown; expected ${want}`);
        }
        return problems;
      });

      // 5. Every piece of evidence opens under its own name, is no wider than the window, and closes back to its button.
      for (const narrow of view.name === "phone" ? [view, NARROW] : [view]) {
        await ask(`${narrow.name} ${narrow.width}x${narrow.height}: every piece of evidence opens under its own name, nothing scrolls sideways with it open, and Escape returns to its button`, async () => {
          await page.send("Emulation.setDeviceMetricsOverride", windowOf(narrow));
          await arrive(page, "/");
          const problems: string[] = [];
          const opened = new Set<string>();
          for (const tab of TABS) {
            await page.evaluate(`[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes(${JSON.stringify(tab.name)})).click()`);
            await page.waitFor(SETTLED, `the section ${tab.name}`);
            problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `${tab.name}: ${problem}`));
            for (const id of await page.evaluate<string[]>(`[...document.querySelectorAll("[data-section] [data-evidence]")].map((button) => button.dataset.evidence)`)) {
              opened.add(id);
              const name = (EVIDENCE as Record<string, string>)[id];
              await page.evaluate(`document.querySelector('[data-section] [data-evidence="${id}"]').click()`);
              await page.waitFor(`document.querySelector('[data-evidence-body="${id}"]')?.getBoundingClientRect().height > 0 && !document.querySelector(".sheet")?.matches("[data-starting-style]")`, `the evidence ${id}`);
              await sleep(id === "what-if" ? 900 : 500);
              if ((await page.evaluate<string>(`document.querySelector(".sheet-title").textContent`)) !== name) problems.push(`${id} opens under another name than "${name}"`);
              if ((await page.evaluate<number>(`document.querySelector('[data-evidence-body="${id}"]').textContent.length`)) < 80) problems.push(`${id} opens empty`);
              problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `with "${name}" open: ${problem}`));
              await page.key("Escape", 27);
              await page.waitFor(`!document.querySelector("[data-evidence-body]") || document.querySelector(".sheet")?.getBoundingClientRect().height === 0 || document.querySelector(".sheet")?.matches("[data-closed]")`, `the evidence ${id} to close`);
              await sleep(500);
              if (!(await page.evaluate<boolean>(`document.activeElement?.dataset?.evidence === "${id}"`))) problems.push(`after Escape, focus is not back on the button of ${id}`);
            }
          }
          for (const id of Object.keys(EVIDENCE)) if (!opened.has(id)) problems.push(`no section offers the evidence ${id}`);
          await page.send("Emulation.setDeviceMetricsOverride", windowOf(view));
          return problems;
        });
      }

      // 6. The keyboard alone: every control shows where focus is, and the what-if panel can be opened and moved.
      const before = service === undefined ? "" : hashTree(["eval", "data"]);
      const rings: string[] = [];
      const focused = (): Promise<{ evidence: string; mark: string; ring: boolean; what: string }> =>
        page.evaluate(`(() => {
          const a = document.activeElement;
          const ringed = (element) => { if (!element) return false; const s = getComputedStyle(element); return s.outlineStyle === "solid" && parseFloat(s.outlineWidth) >= 2; };
          return { evidence: a.dataset?.evidence ?? "", mark: a.closest?.("[data-mark]")?.dataset.mark ?? "", ring: ringed(a) || ringed(a.parentElement) || ringed(a.closest(".metal-fx-root")), what: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.className && typeof a.className === "string" ? "." + a.className.split(" ")[0] : "") + (a.getAttribute("role") ? "[" + a.getAttribute("role") + "]" : "") };
        })()`);
      const tabTo = async (wanted: (element: { evidence: string; mark: string; what: string }) => boolean, what: string): Promise<void> => {
        for (let presses = 0; presses < 200; presses += 1) {
          await page.key("Tab", 9);
          const now = await focused();
          if (now.what === "body") continue;
          if (!now.ring) rings.push(`${now.what} takes focus with no visible ring`);
          if (wanted(now)) return;
        }
        throw new Error(`200 presses of Tab did not reach ${what}`);
      };
      await ask(`${at}: with the keyboard alone the what-if panel opens and moves, says what the gate reads, keeps focus, and changes no file${service === undefined ? " (files not hashed: the service is not this checkout's)" : ""}`, async () => {
        await arrive(page, "/?" + new URLSearchParams({ game: found[0]?.game ?? "", brand: found[0]?.brand ?? "", tab: "worth" }).toString());
        await page.evaluate("document.activeElement?.blur(); window.scrollTo(0, 0)");
        await tabTo((element) => element.evidence === "what-if", "the what-if button");
        await page.key("Enter", 13, "\r");
        await page.waitFor("document.querySelector('[data-what-if] .mark')", "the what-if panel");
        await sleep(600);
        const committedFails = await page.evaluate<number>("document.querySelectorAll('[data-what-if] .label.red').length");
        await tabTo((element) => element.mark === "min_pairwise_accuracy", "the pairwise accuracy slider");
        // Raise the mark a step at a time until a version that passed now fails.
        for (let step = 1; step <= 25; step += 1) {
          await page.key("ArrowRight", 39);
          await page.waitFor("document.querySelectorAll('[data-what-if] .mark.moved').length === 1", "the moved mark");
          await sleep(150);
          if ((await page.evaluate<number>("document.querySelectorAll('[data-what-if] .label.red').length")) > committedFails) break;
        }
        const problems = await page.evaluate<string[]>(`(() => {
          const panel = document.querySelector("[data-what-if]");
          const problems = [];
          if (!panel.textContent.includes("The release gate reads only the committed file")) problems.push("the panel does not say what the gate reads");
          if (panel.querySelectorAll(".tick").length !== panel.querySelectorAll("input[type=range]").length) problems.push("a slider has no committed tick");
          if (panel.querySelectorAll(".label.amber").length < 2) problems.push("the moved mark is not labelled");
          if (document.activeElement?.closest("[data-mark]")?.dataset.mark !== "min_pairwise_accuracy") problems.push("the slider lost focus when the panel was redrawn");
          if (panel.querySelectorAll(".label.red").length <= ${committedFails}) problems.push("raising the mark failed no version");
          return problems;
        })()`);
        problems.push(...(await page.evaluate<string[]>(LAYOUT)).map((problem) => `with a mark moved: ${problem}`));
        return service === undefined || hashTree(["eval", "data"]) === before ? problems : [...problems, "a file under eval/ or data/ changed"];
      });
      await ask(`${at}: every control reached with Tab, from the top panel to the evidence, shows a focus ring`, async () => {
        await arrive(page, "/");
        await page.evaluate("document.activeElement?.blur(); window.scrollTo(0, 0)");
        const seen = new Set<string>();
        for (let presses = 0; presses < 40; presses += 1) {
          await page.key("Tab", 9);
          const now = await focused();
          if (now.what === "body") continue;
          seen.add(now.what);
          if (!now.ring) rings.push(`${now.what} takes focus with no visible ring`);
        }
        const missing = ["#pick-game", "#pick-brand", "#pick-version", "#examples-open", "[tab]", ".chip"].filter((part) => ![...seen].some((what) => what.includes(part)));
        return [...new Set(rings), ...missing.map((part) => `Tab never reached a control like ${part}`)];
      });

      // 7. A slow connection: the answer on screen is the answer to the request the panel shows, never an earlier one.
      await ask(`${at}: on a slow connection, two requests made in quick succession leave the second one's answer on screen`, async () => {
        const [first, second] = [found.find((example) => example.kind === "thin"), found.find((example) => example.kind === "decline")];
        if (first?.game === undefined || second?.game === undefined || first.game === second.game) return ["there are no two examples to open one after the other"];
        await arrive(page, "/");
        await page.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: -1, uploadThroughput: -1 });
        try {
          await page.evaluate(`document.querySelector("#examples-open").click()`);
          await page.waitFor(`document.querySelectorAll("a[data-example]").length > 0`, "the examples");
          await page.evaluate(`document.querySelector('a[data-example="${second.kind}"]').click()`);
          await page.evaluate(`document.querySelector("#examples-open").click()`);
          await page.waitFor(`document.querySelector('a[data-example="${first.kind}"]')`, "the examples again");
          await page.evaluate(`document.querySelector('a[data-example="${first.kind}"]').click()`);
          await sleep(30);
          await page.evaluate(`document.querySelector("#examples-open").click()`);
          await page.waitFor(`document.querySelector('a[data-example="${second.kind}"]')`, "the examples a third time");
          await page.evaluate(`document.querySelector('a[data-example="${second.kind}"]').click()`);
          // While the answer is on its way the page says Loading, not the answer to another request.
          const during = await page.evaluate<string>(`document.querySelector("main").dataset.request ?? "loading"`);
          await sleep(2500);
          await page.waitFor(`document.querySelector("main[data-ready] [data-section]")`, "the last request to be answered");
          const after = await page.evaluate<{ request: string; picker: string; heading: string }>(`({ request: document.querySelector("main").dataset.request, picker: document.querySelector("#pick-game").textContent, heading: document.querySelector("[data-section]").textContent })`);
          const title = catalogue.games.find((game) => game.game_id === second.game)?.title ?? "";
          const problems: string[] = [];
          if (during !== "loading" && !during.startsWith(`${second.game} `)) problems.push(`while the second request was on its way the page showed the answer to ${during}`);
          if (!after.request.startsWith(`${second.game} ${second.brand} `)) problems.push(`the answer on screen is for ${after.request}, and the request is ${second.game} on ${second.brand}`);
          if (!after.picker.includes(title) || !after.heading.includes(title)) problems.push("the picker and the section do not name the same game");
          return problems;
        } finally {
          await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        }
      });

      // 8. A bad address is reported for what it is.
      await ask(`${at}: a brand in the wrong case, and a brand with no game, are reported for what they are`, async () => {
        const example = found[0];
        if (example?.game === undefined || example.brand === undefined) return ["there is no example to take a game and a brand from"];
        const problems: string[] = [];
        await page.goto(`${base}/?game=${example.game}&brand=${example.brand.toUpperCase()}`);
        await page.waitFor(`document.querySelector("[data-address-problem]")`, "the report of the bad address");
        const said = await page.evaluate<string>(`document.querySelector("[data-address-problem]").textContent`);
        if (!said.includes(`"${example.brand.toUpperCase()}"`) || !said.includes(example.brand) || /required|missing/i.test(said)) problems.push(`the wrong-case brand is reported as: ${said}`);
        if (await page.evaluate<boolean>(`Boolean(document.querySelector("[data-results], [data-decline]"))`)) problems.push("an answer is shown though the brand is not one the service has");
        await page.goto(`${base}/?brand=${example.brand}`);
        await page.waitFor(`document.querySelector("[data-address-problem]")`, "the report of the address with no game");
        const alone = await page.evaluate<{ said: string; brand: string }>(`({ said: document.querySelector("[data-address-problem]").textContent, brand: document.querySelector("#pick-brand").textContent })`);
        if (!alone.said.includes(`names the brand "${example.brand}" and no game`)) problems.push(`the brand with no game is reported as: ${alone.said}`);
        if (!alone.brand.includes(example.brand)) problems.push(`the brand picker shows "${alone.brand}", not the brand the address named`);
        return problems;
      });

      check(`${at}: the page script raised no error`, page.errors);
      everyAsked.push(...page.requests);
      await page.close();

      // 9. Motion: there is some by default, and none for a reader who asked for less.
      const moving = (selectors: readonly string[]): string =>
        `${JSON.stringify(selectors)}.map((selector) => { const element = document.querySelector(selector); if (!element) return "missing: " + selector; const s = getComputedStyle(element); return s.animationName !== "none" || parseFloat(s.transitionDuration) > 0 ? "moves" : "still"; })`;
      const metal = `(async () => { const canvas = document.querySelector(".tabs canvas.metal-fx-canvas"); if (!canvas) return "no canvas"; const a = canvas.toDataURL(); await new Promise((resolve) => setTimeout(resolve, 700)); return a === canvas.toDataURL() ? "still" : "moves"; })()`;
      for (const [reduced, name] of [[true, "nothing moves under prefers-reduced-motion, the metal effect included, and the sections still switch"], [false, "the same parts do move otherwise"]] as const) {
        const probe = await openPage(chrome.port, view, reduced);
        await ask(`${at}: ${name}`, async () => {
          await arrive(probe, "/");
          const states = [...(await probe.evaluate<string[]>(moving([".results li", ".panel"]))), await probe.evaluate<string>(metal)];
          await probe.evaluate(`document.querySelectorAll("[role=tab]")[2].click()`);
          await probe.waitFor(SETTLED, "the third section");
          const problems = (await probe.evaluate<string>(`document.querySelector("[data-section]").dataset.section`)) === TABS[2].id ? [] : ["the section did not switch"];
          // The marker of the open tab travels only once a tab has been chosen, and the bars are in the third section.
          states.push(...(await probe.evaluate<string[]>(moving([".indicator", ".fill"]))));
          if (!states.every((state) => state === (reduced ? "still" : "moves"))) problems.push(`results, section, metal, marker, bar: ${states.join(", ")}`);
          return [...problems, ...probe.errors];
        });
        everyAsked.push(...probe.requests);
        await probe.close();
      }
    }

    // 10. A browser without WebGL2: the metal effect is absent, and the page is whole.
    if (!options["first-screens"]) {
      const plain = await launchChrome(["--disable-3d-apis"]);
      try {
        const page = await openPage(plain.port, WIDTHS[0]);
        await ask("desktop 1280x900, no WebGL2: the page is whole, its sections switch, and the open tab is marked without the metal effect", async () => {
          await arrive(page, "/");
          const problems = await page.evaluate<string[]>(FIRST_SCREEN);
          const state = await page.evaluate<{ canvases: number; fallback: number; marked: boolean }>(`(() => { const pill = document.querySelector(".indicator .indicator-pill"); return { canvases: document.querySelectorAll("canvas").length, fallback: document.querySelectorAll(".metal-fx-fallback").length, marked: Boolean(pill) && pill.getBoundingClientRect().width > 20 && getComputedStyle(pill).boxShadow !== "none" }; })()`);
          if (state.canvases > 0) problems.push("a canvas is drawn though WebGL is off, so this run did not test the fallback");
          if (state.fallback < 2) problems.push("the metal effect did not fall back to the plain element");
          if (!state.marked) problems.push("the open tab has no visible marker without the metal effect");
          for (const tab of TABS.slice(1)) {
            await page.evaluate(`[...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent.includes(${JSON.stringify(tab.name)})).click()`);
            await page.waitFor(SETTLED, `the section ${tab.name}`);
            if ((await page.evaluate<string>(`document.querySelector("[data-section]").dataset.section`)) !== tab.id) problems.push(`the section ${tab.name} did not open`);
          }
          return [...problems, ...page.errors];
        });
        everyAsked.push(...page.requests);
        await page.close();
      } finally {
        closeChrome(plain);
      }
    }
  }
  // Whatever ran: the page asked for nothing outside this machine's own service.
  const outside = [...new Set(everyAsked.filter((address) => !address.startsWith(`${base}/`) && !/^(data|blob|about):/.test(address)))];
  check(`the page asked for nothing outside this service (${everyAsked.length} requests seen)`, everyAsked.length === 0 ? ["no request was seen, so nothing was checked"] : outside.slice(0, 5));
} finally {
  closeChrome(chrome);
  service?.close();
}

if (checks === 0) throw new Error("no check ran, so nothing was checked");
console.log(`\n${checks - failures.length} of ${checks} checks passed`);
if (failures.length > 0) process.exitCode = 1;
