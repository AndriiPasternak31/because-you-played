/**
 * The page: one top panel, four sections, one on screen at a time.
 *
 * This file is the part that keeps state and touches the browser. It reads the address, asks the
 * service through `get`, and hands the answers to the sections (view.ts) and the evidence (evidence.ts),
 * which are plain functions. A late answer is never drawn for another request: what is on screen is
 * always the answer to the request the panel shows, or the word "Loading".
 */
import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle } from "@ui-sdk/react/drawer";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { Select, SelectContent, SelectEmpty, SelectInput, SelectItem, SelectLabel, SelectList, SelectTrigger } from "@ui-sdk/react/select";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { MetalFx } from "metal-fx";
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Version } from "../pipeline/versions.ts";
import { Evidence, WhatIfView } from "./evidence.ts";
import {
  BadRequestError,
  TABS,
  addressOf,
  findExamples,
  gameOptions,
  latestOnly,
  loadRequest,
  readAddress,
  sameRequest,
  url,
  versionName,
  type Address,
  type Catalogue,
  type Evaluation,
  type Example,
  type Get,
  type Loaded,
  type Request,
  type TabId,
  type WhatIf,
} from "./read.ts";
import { Actions, AddressProblems, BadInput, EVIDENCE, Empty, Failed, Loading, SECTIONS, type EvidenceId, type PageActions } from "./view.ts";

/** Whether a media query matches, kept up to date. False where there is no window. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = (): void => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

type Outcome = { request: Request } & ({ data: Loaded } | { bad: string } | { failed: string });

/** The what-if panel: the committed marks first, then the gate's answer to every move, asked of the service each time. */
function WhatIfPanel({ get, evaluation }: { get: Get; evaluation: Evaluation }): ReactNode {
  const [state, setState] = useState<{ whatIf: WhatIf } | { failed: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [round, setRound] = useState(0);
  const latest = useMemo(() => latestOnly(), []);
  useEffect(() => {
    latest(() => get(Object.keys(values).length === 0 ? "/api/what-if" : url("/api/what-if", values)) as Promise<WhatIf>).then(
      (answer) => answer && setState({ whatIf: answer.value }),
      (error: unknown) => setState({ failed: error instanceof Error ? error.message : String(error) }),
    );
  }, [get, latest, values]);
  if (state === null) return h(Loading);
  if ("failed" in state) return h(Failed, { message: state.failed });
  return h(WhatIfView, { evaluation, whatIf: state.whatIf, onMove: (key, value) => setValues((before) => ({ ...before, [key]: String(value) })), round, onReset: () => (setValues({}), setRound((before) => before + 1)) });
}

export function App({ get }: { get: Get }): ReactNode {
  const [base, setBase] = useState<{ catalogue: Catalogue; evaluation: Evaluation } | { failed: string } | null>(null);
  const [examples, setExamples] = useState<Example[] | { failed: string } | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [evidence, setEvidence] = useState<{ id: EvidenceId; open: boolean } | null>(null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const narrow = useMedia("(max-width: 759px)");
  const still = useMedia("(prefers-reduced-motion: reduce)");

  // Once: what the service holds, then the address, then the examples. With nothing in the address, the first example opens.
  useEffect(() => {
    let live = true;
    (async () => {
      const [catalogue, evaluation] = (await Promise.all([get("/api/catalogue"), get("/api/evaluation")])) as [Catalogue, Evaluation];
      if (!live) return;
      setBase({ catalogue, evaluation });
      const asked = readAddress(location.search, catalogue);
      if (!asked.empty) setAddress(asked);
      try {
        const found = await findExamples(get, catalogue, evaluation);
        if (!live) return;
        setExamples(found);
        const first = found.find((example) => example.found);
        if (asked.empty) setAddress(first?.game && first.brand ? { ...asked, game: first.game, brand: first.brand, version: first.version ?? asked.version, tab: "shown", focus: first.focus ?? null } : asked);
      } catch (error) {
        if (!live) return;
        setExamples({ failed: error instanceof Error ? error.message : String(error) });
        if (asked.empty) setAddress(asked);
      }
    })().catch((error: unknown) => live && setBase({ failed: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [get]);

  const catalogue = base !== null && "catalogue" in base ? base.catalogue : null;
  const evaluation = base !== null && "evaluation" in base ? base.evaluation : undefined;
  const request = useMemo<Request | null>(() => (address?.game && address.brand ? { game: address.game, brand: address.brand, version: address.version } : null), [address?.game, address?.brand, address?.version]);

  // One request at a time. An answer that arrives after the request has changed is dropped, not drawn.
  const latest = useMemo(() => latestOnly(), []);
  useEffect(() => {
    if (catalogue === null || request === null) return;
    latest(() =>
      loadRequest(get, request, catalogue).then(
        (data): Outcome => ({ request, data }),
        (error: unknown): Outcome => (error instanceof BadRequestError ? { request, bad: error.message } : { request, failed: error instanceof Error ? error.message : String(error) }),
      ),
    ).then((answer) => answer && setOutcome(answer.value));
  }, [get, latest, catalogue, request]);

  // The address follows the page, so any view can be linked.
  useEffect(() => {
    if (catalogue === null || address === null || address.game === null || address.brand === null) return;
    history.replaceState(null, "", addressOf({ game: address.game, brand: address.brand, version: address.version, tab: address.tab, focus: address.focus }, catalogue.served.version));
  }, [catalogue, address]);

  /** A choice made by hand: the pickers and the tabs change the request and keep everything else that still applies. */
  const go = useCallback((change: Partial<Address>) => setAddress((before) => (before === null ? before : { ...before, ...change, problems: [], empty: false })), []);
  const actions = useMemo<PageActions>(
    () => ({
      openEvidence: (id, from) => {
        opener.current = from;
        setEvidence({ id: id as EvidenceId, open: true });
      },
      showVersion: (version) => go({ version: version as Version, focus: null }),
    }),
    [go],
  );

  if (base !== null && "failed" in base) return h("main", { className: "page" }, h(Failed, { message: base.failed }));
  if (catalogue === null || address === null) return h("main", { className: "page", "aria-busy": "true" }, h("p", { className: "boot" }, "Because you played: the inspection view of a recommender. Loading what the service holds."));

  const served = catalogue.served.version;
  const current = request !== null && outcome !== null && sameRequest(outcome.request, request) ? outcome : null;
  const data = current !== null && "data" in current ? current.data : null;
  // The example that is open, if the request is one: it is marked where the examples are chosen.
  const example = Array.isArray(examples) ? (examples.find((entry) => entry.found && entry.game === address.game && entry.brand === address.brand && (entry.version ?? served) === address.version && (entry.focus ?? null) === address.focus) ?? null) : null;
  const ready = request === null || current !== null;

  const body = (tab: TabId): ReactNode => {
    if (request === null) return h(Empty);
    if (current === null) return h(Loading);
    if ("bad" in current) return h(BadInput, { message: current.bad });
    if ("failed" in current) return h(Failed, { message: current.failed });
    return h(SECTIONS[tab], { data: current.data, evaluation, focus: address.focus });
  };

  // The closed picker shows the game's title alone; its status on the brand and the state of its record are in the open list.
  const games = gameOptions(catalogue, address.brand, address.game);
  const brands = catalogue.brands.map((entry) => ({ value: entry.brand, label: entry.brand }));
  const versions = catalogue.versions.map((version) => ({ value: version as string, label: `${versionName(version)} · ${version === served ? "served" : "inspection"}` }));
  const picker = (id: string, name: string, items: { value: string; label: string; note?: string }[], value: string | null, choose: (value: string) => void, search?: string): ReactNode =>
    h(
      "div",
      { className: `field ${id}` },
      h(
        Select,
        { value, onValueChange: (next: unknown) => typeof next === "string" && choose(next) },
        h(SelectLabel, { className: "sr" }, name),
        h(SelectTrigger, { className: "select", id: `pick-${id}` }, h("span", { className: "select-key", "aria-hidden": "true" }, name), h("span", { className: "select-value" }, items.find((item) => item.value === value)?.label ?? `Choose a ${id}`)),
        h(
          SelectContent,
          { className: "menu" },
          search === undefined ? null : h(SelectInput, { className: "search", placeholder: search, "aria-label": search }),
          search === undefined ? null : h(SelectEmpty, { className: "small" }, "No game by that name."),
          // In the open list an item carries its note; the closed control shows the chosen item's name alone.
          h(SelectList, { className: "options" }, items.map((item) => h(SelectItem, { key: item.value, value: item.value, label: item.label, className: "option" }, h("span", null, item.label), item.note ? h("span", { className: "small" }, item.note) : null))),
        ),
      ),
    );

  const exampleList = Array.isArray(examples)
    ? h(
        "ol",
        { className: "examples" },
        examples.map((entry) => {
          const inner = h(Fragment, null, h("strong", null, entry.name), h("span", { className: "small" }, entry.note));
          if (!entry.found || entry.href === undefined || entry.game === undefined || entry.brand === undefined) return h("li", { className: "missing", key: entry.kind }, inner);
          const to: Partial<Address> = { game: entry.game, brand: entry.brand, version: entry.version ?? served, tab: entry.tab ?? "shown", focus: entry.focus ?? null };
          return h(
            "li",
            { key: entry.kind },
            h(
              "a",
              {
                href: entry.href,
                "data-example": entry.kind,
                "aria-current": entry === example ? "true" : undefined,
                // An example is a link. On this page it opens without a reload; in a new tab it opens as any link does.
                onClick: (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault: () => void }) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  go(to);
                  setExamplesOpen(false);
                },
              },
              inner,
            ),
          );
        }),
      )
    : examples === null
      ? h("p", { className: "small" }, "Looking for examples in the catalogue")
      : h(Failed, { message: examples.failed });

  return h(
    Actions.Provider,
    { value: actions },
    h(
      Tabs,
      { value: address.tab, onValueChange: (next: unknown) => typeof next === "string" && go({ tab: next as TabId }), className: "page" },
      // The top panel, one row: the title, the four questions, the game and the brand, and the examples.
      h(
        "header",
        { className: "top" },
        h("h1", null, "Because you played"),
        h(
          TabsList,
          { className: "tabs", "aria-label": "The four questions" },
          TABS.map((tab, index) => h(TabsTab, { key: tab.id, value: tab.id, className: "tab" }, h("span", { className: "tab-n num" }, index + 1), tab.name)),
          // The marker of the open section: a pill with a liquid-metal ring that glides from tab to tab. Without WebGL2 it is the plain pill.
          h(TabsIndicator, { className: "indicator" }, h(MetalFx, { variant: "button", preset: "silver", theme: "dark", paused: still, className: "indicator-metal", borderRadius: 999, children: h("span", { className: "indicator-pill" }) })),
        ),
        picker("game", "Game", games, address.game, (game) => go({ game, focus: null }), `Search ${catalogue.games.length} games`),
        picker("brand", "Brand", brands, address.brand, (brand) => go({ brand, focus: null })),
        h(
          Popover,
          { open: examplesOpen, onOpenChange: (open: boolean) => setExamplesOpen(open) },
          h(MetalFx, { variant: "button", preset: "silver", theme: "dark", paused: still, normalizeHostStyles: false, className: "examples-metal", children: h(PopoverTrigger, { className: "examples-button", id: "examples-open" }, "Examples") }),
          h(PopoverContent, { className: "popover", "aria-label": "Examples found in this catalogue" }, h(PopoverTitle, { className: "kicker" }, "Open an example found in this catalogue"), exampleList),
        ),
      ),
      h(
        "main",
        { className: "stack", "data-ready": ready ? "" : undefined, "data-examples": Array.isArray(examples) ? "found" : examples === null ? "looking" : "failed", "data-request": current === null ? undefined : `${current.request.game} ${current.request.brand} ${current.request.version}` },
        h(AddressProblems, { problems: address.problems }),
        TABS.map((tab) => h(TabsPanel, { key: tab.id, value: tab.id, className: "panel" }, body(tab.id))),
      ),
      h(
        "footer",
        { "data-what": "" },
        `The inspection view of a recommender, not the screen a player would see · serving ${versionName(served)} · ${catalogue.games.length} games · every value comes from this service's own responses; it holds no key and calls no model.`,
      ),
      h(
        Drawer,
        { open: evidence?.open === true, onOpenChange: (open: boolean) => setEvidence((before) => (before === null ? before : { ...before, open })), side: narrow ? "bottom" : "right" },
        h(DrawerBackdrop, { className: "backdrop" }),
        h(
          DrawerContent,
          { className: "sheet", finalFocus: () => opener.current },
          evidence === null
            ? null
            : h(
                Fragment,
                null,
                h("div", { className: "sheet-head" }, h(DrawerTitle, { className: "sheet-title" }, EVIDENCE[evidence.id]), h(DrawerClose, { className: "chip", id: "evidence-close" }, "Close")),
                h("div", { className: "sheet-body", "data-evidence-body": evidence.id }, h(Evidence, { id: evidence.id, data, evaluation, whatIf: evaluation ? h(WhatIfPanel, { get, evaluation }) : undefined, versionPicker: picker("version", "Show the page for", versions, address.version, (version) => go({ version: version as Version, focus: null })) })),
              ),
        ),
      ),
    ),
  );
}

