// The glue between the page and the views: it reads the controls, calls the service's own
// GET routes, and puts the HTML a view returns into the page. All rendering is in view.js.
import {
  addressRequest,
  brandOptions,
  compareView,
  findExamples,
  gameOptions,
  renderBadInput,
  renderEmpty,
  renderEvaluation,
  renderExamples,
  renderFailed,
  renderLoading,
  renderTabs,
  traceView,
  turns,
  versionOptions,
  whatIfView,
} from "/console/view.js";

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
const fill = (select, options, chosen) => {
  select.replaceChildren(...options.map((entry) => option(entry.value, entry.text)));
  if (chosen !== null && chosen !== undefined) select.value = chosen;
};

let catalogue = null;
let evaluation = null;
let examples = [];
// What an address named. A game, brand or version the catalogue does not hold keeps an option, so the request goes out as written.
let named = { game: null, brand: null, version: null };
// Which section is open, a game to point out among the removed, and a part to open.
let pointer = { section: "shown", focus: null, open: null };
const begin = turns();

const fillGames = (chosen = $("game").value) => fill($("game"), gameOptions(catalogue, $("brand").value, named.game), chosen || null);

/** Puts the answer to the latest request for a place on the page. An answer that arrives after a newer request began is dropped. */
async function show(target, work) {
  const latest = begin(target);
  target.innerHTML = renderLoading();
  let html;
  try {
    html = await work();
  } catch (error) {
    html = error instanceof BadInput ? renderBadInput(error.message) : renderFailed(error.message);
  }
  if (latest()) target.innerHTML = html;
}

const request = () => ({ game: $("game").value, brand: $("brand").value, version: $("version").value });

/** The address says what is open, so that a link opens the same view. */
function writeAddress() {
  const query = new URLSearchParams({ ...request(), section: pointer.section });
  if (pointer.focus) query.set("focus", pointer.focus);
  if (pointer.open) query.set("open", pointer.open);
  history.replaceState(null, "", `?${query}`);
  // The section links follow the request. They are changed in place, so the one in use keeps its focus.
  const fresh = Object.assign(document.createElement("div"), { innerHTML: renderTabs(pointer.section, request()) });
  if ($("tabs").children.length === 0) $("tabs").replaceChildren(...fresh.children);
  else for (const [index, tab] of [...$("tabs").children].entries()) tab.setAttribute("href", fresh.children[index].getAttribute("href"));
}

function showExamples() {
  if (examples.length > 0) $("examples").innerHTML = renderExamples(examples, $("version").value === catalogue.served.version ? request() : undefined);
}

/** Opens one of the four sections. Nothing is fetched: the other sections are already on the page, hidden. */
function showSection(section, moved) {
  pointer.section = section;
  for (const pane of document.querySelectorAll("#trace [data-section]")) {
    pane.hidden = pane.dataset.section !== section;
    pane.classList.toggle("enter", moved && !pane.hidden);
  }
  $("evaluation").hidden = section !== "worth";
  $("evaluation").classList.toggle("enter", moved && section === "worth");
  for (const tab of document.querySelectorAll("#tabs a")) {
    if (tab.dataset.tab === section) tab.setAttribute("aria-current", "true");
    else tab.removeAttribute("aria-current");
  }
  if (moved) window.scrollTo(0, 0);
}

async function showRequest() {
  const asked = request();
  const example = asked.version === catalogue.served.version ? examples.find((entry) => entry.found && entry.game === asked.game && entry.brand === asked.brand) : undefined;
  writeAddress();
  showExamples();
  showSection(pointer.section, false);
  if (pointer.open === "versions") $("versions").open = true;
  const more = { served: catalogue.served.version, versions: catalogue.versions, evaluation: evaluation ?? undefined, focus: pointer.focus ?? undefined };
  show($("compare"), () => compareView(get, { ...asked, ...more }));
  await show($("trace"), () => traceView(get, { ...asked, ...more, look: example ? { note: example.note, section: example.section } : undefined, section: pointer.section }));
  // The reader may have switched section while the answer was on its way.
  showSection(pointer.section, false);
}

/** Opens what an address asks for: the pickers follow, then the page shows it. */
function open(search) {
  const asked = addressRequest(search, catalogue);
  named = { game: asked.game, brand: asked.brand, version: asked.version };
  fill($("brand"), brandOptions(catalogue, named.brand), asked.brand);
  fill($("version"), versionOptions(catalogue, named.version), asked.version);
  fillGames(asked.game);
  pointer = { section: asked.section, focus: asked.focus, open: asked.open };
  return showRequest();
}

async function showWhatIf(values) {
  const panel = $("what-if");
  const latest = begin(panel);
  const focused = document.activeElement?.id;
  let html;
  try {
    html = await whatIfView(get, evaluation, values);
  } catch (error) {
    html = renderFailed(error.message);
  }
  if (!latest()) return;
  panel.innerHTML = html;
  if (focused) $(focused)?.focus();
}

const sliderValues = () => Object.fromEntries([...document.querySelectorAll("#what-if input[type=range]")].map((input) => [input.name, input.value]));

async function start() {
  try {
    catalogue = await get("/api/catalogue");
  } catch (error) {
    $("trace").innerHTML = renderFailed(error.message);
    return;
  }
  fill($("brand"), brandOptions(catalogue, null), null);
  fill($("version"), versionOptions(catalogue, null), catalogue.served.version);
  fillGames();

  // The pickers: the page follows a choice at once. A choice made by hand keeps the open section and points at nothing else.
  const chosen = () => {
    pointer = { section: pointer.section, focus: null, open: null };
    showRequest();
  };
  $("brand").addEventListener("change", () => {
    fillGames();
    chosen();
  });
  $("game").addEventListener("change", chosen);
  $("version").addEventListener("change", chosen);
  $("picker").addEventListener("submit", (event) => event.preventDefault());
  // A tab is a link. On this page it switches the section without a reload; in a new tab it opens as any link does.
  $("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("a[data-tab]");
    if (!tab || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    showSection(tab.dataset.tab, true);
    writeAddress();
    tab.focus();
  });
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
  // An example is a link too. Choosing one closes the menu and opens the section that shows it.
  $("examples").addEventListener("click", (event) => {
    const link = event.target.closest("a[data-example]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    $("examples-menu").open = false;
    open(new URL(link.href).search);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("examples-menu").open) {
      $("examples-menu").open = false;
      $("examples-menu").querySelector("summary").focus();
    }
  });

  // The evaluation first: the fourth section's answer is drawn from it.
  await show($("evaluation-body"), async () => {
    evaluation = await get("/api/evaluation");
    return renderEvaluation(evaluation);
  });
  // The what-if panel: opened by its button, and re-read from the service on every move.
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

  // An address opens what it names. With no request in it, the page opens on the first example, at the section the address names.
  const asked = addressRequest(location.search, catalogue);
  const first = examples.find((example) => example.found);
  if (asked.game !== null) open(location.search);
  else if (first) open(`?${new URLSearchParams({ game: first.game, brand: first.brand, section: asked.section })}`);
  else {
    showExamples();
    $("trace").innerHTML = renderEmpty();
  }
}

start();
