// The glue between the page and the views: it reads the controls, calls the service's own
// GET routes, and puts the HTML a view returns into the page. All rendering is in view.js.
import { compareView, gameOptions, renderBadInput, renderEmpty, renderEvaluation, renderFailed, renderLoading, traceView, versionName, whatIfView } from "/console/view.js";

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
// A game a link asked for. If the index does not hold it, it still gets an option, so the service's decline is shown.
let askedGame = null;

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

function showRequest() {
  const request = { game: $("game").value, brand: $("brand").value, version: $("version").value, served: catalogue.served.version };
  history.replaceState(null, "", `?${new URLSearchParams({ game: request.game, brand: request.brand, version: request.version })}`);
  show($("trace"), () => traceView(get, request));
  show($("compare"), () => compareView(get, { ...request, versions: catalogue.versions }));
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
  $("serving").textContent = `Serving ${versionName(catalogue.served.version)} of index ${catalogue.served.index_hash.slice(0, 12)}. Similarity floor ${catalogue.served.floor}. ${catalogue.games.length} games.`;
  $("brand").replaceChildren(...catalogue.brands.map((entry) => option(entry.brand, `${entry.brand} · ${entry.live} live`)));
  $("version").replaceChildren(...catalogue.versions.map((version) => option(version, version === catalogue.served.version ? `${versionName(version)} (served)` : `${versionName(version)} (inspection only)`)));
  $("version").value = catalogue.served.version;

  const asked = new URLSearchParams(location.search);
  if (asked.has("brand")) $("brand").value = asked.get("brand");
  askedGame = asked.get("game");
  fillGames();
  if (asked.has("game")) $("game").value = asked.get("game");
  if (asked.has("version")) $("version").value = asked.get("version");
  $("brand").addEventListener("change", fillGames);
  $("picker").addEventListener("submit", (event) => {
    event.preventDefault();
    showRequest();
  });
  if (asked.has("game") && asked.has("brand")) showRequest();
  else $("trace").innerHTML = renderEmpty();

  await show($("evaluation-body"), async () => {
    evaluation = await get("/api/evaluation");
    return renderEvaluation(evaluation);
  });
  // The what-if panel: opened by the icon beside the verdict, and re-read from the service on every move.
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
}

start();
