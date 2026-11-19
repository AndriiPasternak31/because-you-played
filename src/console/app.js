// The glue between the page and the views: it reads the controls, calls the service's own
// GET routes, and puts the HTML a view returns into the page. All rendering is in view.js.
import { compareView, findExamples, gameOptions, renderBadInput, renderEmpty, renderEvaluation, renderExamples, renderFailed, renderLoading, traceView, versionName, whatIfView } from "/console/view.js";

class BadInput extends Error {}

/** The only way this page reaches data: a GET to this service. */
async function get(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.json();
  if (response.status === 400) throw new BadInput(body.message);
  if (!response.ok) throw new Error(`${response.status}: ${body.message ?? "the service did not answer"}`);
  return body;
}

const $ = (id) => document.getElementById(id);
const option = (value, text) => Object.assign(document.createElement("option"), { value, textContent: text });

let catalogue = null;
let evaluation = null;
let examples = [];
// A game a link asked for. If the index does not hold it, it still gets an option, so the service's decline is shown.
let askedGame = null;
// What a link or an example asks the page to point at: a part to bring into view, and a game to point out on the path.
let pointer = { show: null, focus: null };

function fillGames() {
  const chosen = $("game").value;
  $("game").replaceChildren(...gameOptions(catalogue, $("brand").value, askedGame).map((entry) => option(entry.value, entry.text)));
  if (chosen) $("game").value = chosen;
}

async function show(target, work) {
  target.innerHTML = renderLoading();
  try {
    target.innerHTML = await work();
  } catch (error) {
    target.innerHTML = error instanceof BadInput ? renderBadInput(error.message) : renderFailed(error.message);
  }
}

/** The request as an example's link would write it, so that the open example can be marked. */
function asExampleLink() {
  const query = new URLSearchParams({ game: $("game").value, brand: $("brand").value });
  if (pointer.show) query.set("show", pointer.show);
  if (pointer.focus) query.set("focus", pointer.focus);
  return `?${query}`;
}

function showExamples() {
  if (examples.length === 0) return;
  $("examples").innerHTML = renderExamples(examples, asExampleLink());
  // Where the examples run sideways in a strip, the open one is brought into it. The page itself does not move.
  const strip = $("examples").querySelector("ol");
  const current = strip.querySelector('[aria-current="true"]')?.parentElement;
  if (current) strip.scrollLeft = current.offsetLeft - strip.offsetLeft;
}

/** The example the open request is, if it is one: its line is shown above the result. */
function openExample() {
  const link = `/${asExampleLink()}`;
  return examples.find((example) => example.found && example.href === link);
}

async function showRequest() {
  const example = openExample();
  const request = {
    game: $("game").value,
    brand: $("brand").value,
    version: $("version").value,
    served: catalogue.served.version,
    versions: catalogue.versions,
    evaluation: evaluation ?? undefined,
    focus: pointer.focus ?? undefined,
    look: example ? { note: example.note, target: example.target } : undefined,
  };
  const query = new URLSearchParams({ game: request.game, brand: request.brand, version: request.version });
  if (pointer.show) query.set("show", pointer.show);
  if (pointer.focus) query.set("focus", pointer.focus);
  history.replaceState(null, "", `?${query}`);
  showExamples();
  // The page does not scroll: the result is the first thing on it. A link that points at the versions opens that part.
  if (pointer.show === "versions") $("versions").open = true;
  show($("compare"), () => compareView(get, request));
  await show($("trace"), () => traceView(get, request));
}

/** Opens a request chosen by its link: the pickers follow, then the page shows it. */
function open(link, point) {
  const asked = new URLSearchParams(link);
  if (asked.has("brand")) $("brand").value = asked.get("brand");
  askedGame = asked.get("game");
  fillGames();
  if (asked.has("game")) $("game").value = asked.get("game");
  $("version").value = asked.get("version") ?? catalogue.served.version;
  pointer = point ? { show: asked.get("show"), focus: asked.get("focus") } : { show: null, focus: null };
  return showRequest();
}

async function showWhatIf(values) {
  const panel = $("what-if");
  const focused = document.activeElement?.id;
  try {
    panel.innerHTML = await whatIfView(get, evaluation, values);
  } catch (error) {
    panel.innerHTML = renderFailed(error.message);
  }
  if (focused) $(focused)?.focus();
}

const sliderValues = () => Object.fromEntries([...document.querySelectorAll("#what-if input[type=range]")].map((input) => [input.name, input.value]));

async function start() {
  try {
    catalogue = await get("/api/catalogue");
  } catch (error) {
    $("serving").innerHTML = renderFailed(error.message);
    return;
  }
  $("serving").textContent = `Serving ${versionName(catalogue.served.version)} · index ${catalogue.served.index_hash.slice(0, 12)} · ${catalogue.games.length} games`;
  $("brand").replaceChildren(...catalogue.brands.map((entry) => option(entry.brand, `${entry.brand} · ${entry.live} live`)));
  $("version").replaceChildren(...catalogue.versions.map((version) => option(version, version === catalogue.served.version ? `${versionName(version)} (served)` : `${versionName(version)} (inspection only)`)));
  $("version").value = catalogue.served.version;

  // The pickers: the page follows a choice at once, and a choice made by hand points at nothing in particular.
  const chosen = () => {
    pointer = { show: null, focus: null };
    showRequest();
  };
  $("brand").addEventListener("change", () => {
    fillGames();
    chosen();
  });
  $("game").addEventListener("change", chosen);
  $("version").addEventListener("change", chosen);
  $("picker").addEventListener("submit", (event) => event.preventDefault());
  // A step of the path opens what it removed, one step at a time.
  $("trace").addEventListener("click", (event) => {
    const button = event.target.closest("button.step");
    if (!button) return;
    const opening = button.getAttribute("aria-expanded") !== "true";
    for (const other of document.querySelectorAll("#trace button.step")) {
      other.setAttribute("aria-expanded", "false");
      $(other.getAttribute("aria-controls")).hidden = true;
    }
    button.setAttribute("aria-expanded", String(opening));
    $(button.getAttribute("aria-controls")).hidden = !opening;
  });
  // An example is a link. On this page it opens without a reload; in a new tab it opens as any link does.
  $("examples").addEventListener("click", (event) => {
    const link = event.target.closest("a[data-example]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    open(new URL(link.href).search, true);
  });

  fillGames();
  // The evaluation first: the chart beside every result is drawn from it.
  await show($("evaluation-body"), async () => {
    evaluation = await get("/api/evaluation");
    return renderEvaluation(evaluation);
  });
  // The what-if panel: opened by the icon under the pass marks, and re-read from the service on every move.
  $("evaluation-body").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button?.id === "what-if-open") {
      const panel = $("what-if");
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) showWhatIf({});
    }
    if (button?.id === "what-if-reset") showWhatIf({});
  });
  $("evaluation-body").addEventListener("change", (event) => {
    if (event.target.matches("#what-if input[type=range]")) showWhatIf(sliderValues());
  });
  $("evaluation-body").addEventListener("input", (event) => {
    if (!event.target.matches("#what-if input[type=range]")) return;
    const output = document.querySelector(`#what-if output[for="${event.target.id}"]`);
    if (output) output.textContent = event.target.value;
  });

  // The examples next: each is found by asking the service, so they follow whatever catalogue is loaded.
  try {
    examples = await findExamples(get, catalogue, evaluation);
  } catch (error) {
    $("examples").innerHTML = renderFailed(error.message);
  }

  // A link opens its request. With none, the page opens on the first example, so the first screen shows a recommendation.
  const asked = new URLSearchParams(location.search);
  const first = examples.find((example) => example.found);
  if (asked.has("game") && asked.has("brand")) open(location.search, true);
  else if (first) open(first.href.slice(1), true);
  else {
    showExamples();
    $("trace").innerHTML = renderEmpty();
  }
}

start();
