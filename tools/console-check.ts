/**
 * Drives the console in a real browser and checks what the tests cannot reach: what a visitor sees on
 * the first screen, the page script, the layout at a fixed desktop and a fixed phone size, keyboard
 * focus, reduced motion, and that moving a what-if slider with the keyboard changes no file.
 *
 *   node tools/console-check.ts                                  every check
 *   node tools/console-check.ts --first-screens                  only what a visitor sees on arrival
 *   node tools/console-check.ts --screenshots docs/screenshots   every check, then the screenshots
 *   node tools/console-check.ts --base http://127.0.0.1:8787     against a service that is already running
 *   node tools/console-check.ts --also "/?game=<id>&brand=<brand>"   the first screen of that link too (repeatable)
 *
 * The first screen is behaviour, not look: for the landing page and for every example the page offers,
 * the result or the decline must be on screen without scrolling, at 1280 by 900 and at 390 by 844.
 * The screenshot of each first screen is the window as it is on arrival: not resized, not scrolled, not cropped.
 *
 * The examples are found the way the page finds them, by asking the service, so no game is named here.
 * It needs a local Chrome or Chromium (set CHROME to its path when it is not found) and no package:
 * it speaks the DevTools protocol over Node's own WebSocket. Without --base it starts the service in
 * this process on a free port. It reads no key and calls no model.
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
import { findExamples, type Example } from "../src/console/view.js";
import { loadService } from "../src/service/state.ts";

/** The two fixed windows every check is made in. */
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
    if (element.closest(".scroll, .sr, ol.examples")) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.right > width + 0.5 || box.left < -0.5) problems.push(element.tagName.toLowerCase() + "." + element.className + " runs from " + Math.round(box.left) + " to " + Math.round(box.right) + "px");
  }
  return problems.slice(0, 5);
})()`;

/**
 * What a visitor sees on arrival, with no scrolling: what the page is, and the result or the decline.
 * "On screen" means wholly inside the window: a result cut off by the bottom edge does not count.
 */
const FIRST_SCREEN = `(() => {
  const problems = [];
  const onScreen = (element) => { if (!element) return false; const box = element.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight; };
  if (scrollY !== 0) problems.push("the page arrived scrolled to " + Math.round(scrollY) + "px");
  const header = document.querySelector("header");
  if (!onScreen(header) || !/not the (screen|page) a player/i.test(header.textContent)) problems.push("the line saying what this page is, is not on screen");
  const result = document.querySelector("#outcome [data-results] li");
  const decline = document.querySelector("#outcome [data-decline]");
  if (!result && !decline) problems.push("the page shows neither a result nor a decline");
  else if (!onScreen(result ?? decline)) problems.push("the " + (result ? "first result" : "decline") + " is not on screen: it runs from " + Math.round((result ?? decline).getBoundingClientRect().top) + " to " + Math.round((result ?? decline).getBoundingClientRect().bottom) + "px in a window " + innerHeight + "px tall");
  const sentence = [...document.querySelectorAll("#outcome p")].find((p) => /^\\s*(result|declined)?\\s*Given /i.test(p.textContent));
  if (!onScreen(sentence)) problems.push("the sentence that states the outcome is not on screen");
  return problems;
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
    if (document.querySelector("#outcome .main .label.red")) problems.push("the decline carries a failure label");
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

/** The part of the page that holds each example's evidence, for its picture. */
const EVIDENCE: Partial<Record<Example["kind"], string>> = { thin: "#enrichment", conflict: "#enrichment", filter: "#removals", versions: "#versions" };

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const { values: options } = parseArgs({ options: { screenshots: { type: "string" }, base: { type: "string" }, "first-screens": { type: "boolean", default: false }, also: { type: "string", multiple: true, default: [] } }, strict: true });
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
const examples = await findExamples(get, await get("/api/catalogue"), await get("/api/evaluation"));
const found = examples.filter((example) => example.found && example.href !== undefined);
check("the service's data holds every kind of example", examples.filter((example) => !example.found).map((example) => `no game shows: ${example.name}`));

const chrome = await launchChrome();

/** The window as it is: not resized, not scrolled, not cropped. */
async function firstScreenShot(page: Page, view: Width, name: string): Promise<void> {
  if (options.screenshots === undefined) return;
  const { data } = (await page.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  mkdirSync(options.screenshots, { recursive: true });
  writeFileSync(join(options.screenshots, `${view.name}-first-screen-${name}.png`), Buffer.from(data, "base64"));
}

/** One part of the page, for a picture of evidence that sits below the first screen. The window is made as tall as the part. */
async function partShot(page: Page, view: Width, name: string, from: string, to = from): Promise<void> {
  if (options.screenshots === undefined) return;
  const box = await page.evaluate<{ top: number; bottom: number; page: number } | null>(
    `(() => { const a = document.querySelector(${JSON.stringify(from)}); const b = document.querySelector(${JSON.stringify(to)}); if (!a || !b) return null; return { top: a.getBoundingClientRect().top + scrollY, bottom: b.getBoundingClientRect().bottom + scrollY, page: document.documentElement.scrollHeight }; })()`,
  );
  if (box === null) throw new Error(`picture ${name}: the page has no ${from} or no ${to}`);
  const top = Math.max(0, Math.floor(box.top - 16));
  const height = Math.ceil(Math.min(box.bottom + 16, box.page) - top);
  await page.send("Emulation.setDeviceMetricsOverride", windowOf(view, height));
  await page.evaluate(`window.scrollTo({ top: ${top}, behavior: "instant" })`);
  await sleep(300);
  const { data } = (await page.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  mkdirSync(options.screenshots, { recursive: true });
  writeFileSync(join(options.screenshots, `${view.name}-evidence-${name}.png`), Buffer.from(data, "base64"));
  await page.send("Emulation.setDeviceMetricsOverride", windowOf(view));
  await page.evaluate("window.scrollTo({ top: 0, behavior: 'instant' })");
}

/** Arrives at a page as a visitor does, and waits until it has settled. Nothing here scrolls. */
async function arrive(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.waitFor("document.querySelector('#outcome') && document.querySelector('#evaluation-body')?.children.length > 1", "the outcome and the evaluation");
  await sleep(1500); // the page has stopped loading and the bars have finished appearing
}

try {
  for (const view of WIDTHS) {
    const page = await openPage(chrome.port, view);
    const at = `${view.name} ${view.width}x${view.height}`;

    // 1. The first screen: the landing page, then every example, each on arrival.
    const arrivals = [["landing", "/"], ...found.map((example) => [example.kind, example.href as string]), ...options.also.map((path, index) => [`link ${index + 1} (${path})`, path])] as [string, string][];
    for (const [name, path] of arrivals) {
      await ask(`${at}: ${name}: the first screen says what the page is and shows the result or the decline, without scrolling`, async () => {
        await arrive(page, path);
        const problems = await page.evaluate<string[]>(FIRST_SCREEN);
        if (!name.startsWith("link ")) await firstScreenShot(page, view, name);
        return problems;
      });
      if (options["first-screens"]) continue;
      await ask(`${at}: ${name}: nothing is wider than the window`, () => page.evaluate<string[]>(LAYOUT));
      const example = found.find((entry) => entry.kind === name);
      if (example === undefined) continue;
      await ask(`${at}: ${name}: the example shows what it says (${example.name})`, async () => {
        if (example.kind === "versions") await page.waitFor("document.querySelector('#compare table.matrix')", "the comparison of versions");
        return page.evaluate<string[]>(SHOWS[example.kind]);
      });
      const part = EVIDENCE[example.kind];
      if (part !== undefined) await partShot(page, view, example.kind, part);
    }
    if (options["first-screens"]) {
      await page.close();
      continue;
    }

    // 2. The page's own examples are the ones the data holds, and one click opens one without leaving the first screen.
    await ask(`${at}: the page offers every example as a link, and a click opens it with its result on screen`, async () => {
      await arrive(page, "/");
      const offered = await page.evaluate<string[]>("[...document.querySelectorAll('#examples a[data-example]')].map((a) => a.getAttribute('href'))");
      const problems = found.filter((example) => !offered.includes(example.href as string)).map((example) => `the page does not offer: ${example.name}`);
      const pick = found.find((example) => example.kind === "decline") ?? found.at(-1);
      if (pick === undefined) return [...problems, "there is no example to click"];
      await page.evaluate(`document.querySelector('#examples a[data-example="${pick.kind}"]').click()`);
      await page.waitFor(`document.querySelector('#examples a[data-example="${pick.kind}"]')?.getAttribute('aria-current') === 'true' && document.querySelector('#outcome')`, "the clicked example to open");
      await sleep(600);
      return [...problems, ...(await page.evaluate<string[]>(FIRST_SCREEN))];
    });

    // 3. A step of the path opens what it removed, and only one is open at a time.
    await ask(`${at}: a step opens what it removed, one at a time`, async () => {
      const example = found.find((entry) => entry.kind === "thin") ?? found[0];
      if (example === undefined) return ["there is no example to open"];
      await arrive(page, example.href as string);
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

    // 4. The evidence for the served version, then the what-if panel driven with the keyboard alone.
    await partShot(page, view, "evaluation", "#evaluation", "#pass-marks");
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
    await partShot(page, view, "what-if", "#what-if");
    check(`${at}: the page script raised no error`, page.errors);
    await page.close();

    // 5. Motion: there is some by default, and none for a reader who asked for less.
    const animated = `["#outcome ol.results li", "#removals .node", "aside.worth .track .fill"].map((selector) => { const element = document.querySelector(selector); return element ? getComputedStyle(element).animationName : "missing: " + selector; })`;
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
console.log(`\n${checks - failures.length} of ${checks} checks passed${options.screenshots === undefined ? "" : `; screenshots written to ${options.screenshots}`}`);
if (failures.length > 0) process.exitCode = 1;
