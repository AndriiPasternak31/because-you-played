# Interface

**Status:** built, in the near-black and green look the owner chose for #4. How it looks is not signed off: that is the owner's, and #4 stays open until he has looked.

**Purpose.** A console, served by the service at `/`, that shows what the system did for one game on one brand, and the evidence for which version of the index is served. A reader who has never seen the project should be able to follow it without help.

| View | What it shows |
|---|---|
| Steps at a glance | Five dots under the game's title: record, labels, removed, scored, outcome, each with one fact from the response. A step that did not run is empty, a decline is amber |
| Trace | The same five steps down a rail: the raw record, what each step added with the quote behind every label and the model's quotes marked where they sit in the record, each filter with a bar of what it left and the games it removed, the scores as bars against the floor, the result or the decline |
| Side by side | The same request against all four versions: a matrix of which games each would return and at what rank, then the labels each holds with their quotes |
| Verdict | The version that ships, the gate's reason and the state of the owner's check |
| Race | The four versions: pairwise accuracy as a bar with the committed pass mark as a tick, cost as a bar against the dearest version, wrongly shown, model calls, pass or fail |
| Where it helps | The same accuracy split by the condition of the record, a row per condition and a column per version |
| Labels | Precision, recovery and the other enrichment measures with their meaning beside them, the games where a tag contradicts the description, the disagreements and the reviewer |
| Failures | Three to five real failures the evaluation found, and, apart from them, the mess planted on purpose |
| What-if | An icon beside the verdict opens the pass marks as sliders, each with the committed mark as a fixed tick. Pass and fail update as a slider moves |

- **A game whose tag contradicts its description** shows the contradicted tag, what the table did (nothing), and whether the model's reading stands, in the trace and in every column of the side-by-side.
- **The version picker** defaults to the served version. Any other is marked "inspection" at the top of its trace: it is the same core over another version of the index, and never what a player is served.
- **The what-if panel changes no file.** A move sends one `GET /api/what-if` with the marks in the URL; the service applies the real gate to the measured numbers and writes nothing. The panel says that the release gate reads only `eval/thresholds.json`.
- **A request can be linked:** `/?game=<id>&brand=<brand>&version=<version>` opens its trace. A link to a game the index does not hold shows the service's `unknown_game` decline.
- **While the owner's check is outstanding** the evaluation panel says how many of the reviewer's answers are held back and why, and shows none of them: it renders the report, and the report holds none.
- **Nothing on the page is fixed in the code.** Every game, count, score, bar and tick is drawn from a response, so a rebuilt index or a re-run evaluation changes the page and no file of the console.

## Five requests to look at first

Start it with `npm run serve` and open these at `http://127.0.0.1:8787`.

| What it shows | Link | Picture |
|---|---|---|
| A thin record gains labels, each with the words it was read from | `/?game=okk-62483&brand=tavrenmoor` | [desktop](../screenshots/desktop-1-thin-record-gains-labels.png), [phone](../screenshots/phone-1-thin-record-gains-labels.png) |
| The versions recommend different games | `/?game=qfi-87623&brand=tavrenmoor`, then "Side by side" | [desktop](../screenshots/desktop-2-versions-differ.png), [phone](../screenshots/phone-2-versions-differ.png) |
| A filter removes a plausible result: the best result on one brand is not live on the other | `/?game=okk-50023&brand=copperjay`, then `/?game=okk-50023&brand=tavrenmoor` and open the first filter's list | [desktop before](../screenshots/desktop-3a-best-result-on-copperjay.png), [after](../screenshots/desktop-3b-removed-before-scoring-on-tavrenmoor.png); [phone before](../screenshots/phone-3a-best-result-on-copperjay.png), [after](../screenshots/phone-3b-removed-before-scoring-on-tavrenmoor.png) |
| A decline instead of a guess | `/?game=qfi-40239&brand=tavrenmoor` | [desktop](../screenshots/desktop-4-decline-instead-of-a-guess.png), [phone](../screenshots/phone-4-decline-instead-of-a-guess.png) |
| A delivered tag contradicts the description: the table stays silent and the model reads the text | `/?game=okk-17457&brand=tavrenmoor` | [desktop](../screenshots/desktop-5-tag-contradicts-description.png), [phone](../screenshots/phone-5-tag-contradicts-description.png) |

Also in [`docs/screenshots/`](../screenshots/): the top of one request (`0-one-request`), the verdict, race and split by condition (`6-race-and-where-it-helps`), and the what-if panel with one mark moved (`7-what-if-a-mark-moved`), each at desktop and phone width. The pictures are written by `node tools/console-check.ts --screenshots docs/screenshots` and show the index and evaluation committed at the time; after a rebuild, run it again.

These five games are named in `tools/console-check.ts` and nowhere in the console. If a rebuild leaves one of them no longer showing its moment, that check fails and says which.

## Code

No build step and no framework.

| Path | What it holds |
|---|---|
| `src/console/view.js` | Every view, as a plain function from the service's responses to HTML text. It touches no DOM, so the tests run it as it is |
| `src/console/view.d.ts` | Its types, for the tests |
| `src/console/app.js` | The glue: reads the controls, calls `GET /api/…`, puts a view's HTML on the page |
| `src/console/index.html`, `console.css` | The page, and the tokens, type, components and motion of [`ui-guidelines.md`](../ui-guidelines.md) |
| `src/console/console.test.ts` | The tests. Each name starts with the invariant it proves |
| `tools/console-check.ts` | The page in a real browser: the checks the tests cannot reach, and the screenshots. Needs a local Chrome and no package |
| `docs/screenshots/` | The pictures it wrote |

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| UI-1 | Everything the console shows for a request comes from the service's response to that request. The console asks only this service's own routes and makes no model call | `npm test -- "UI-1:"` | `7e0eb4a` |
| UI-2 | A declined request shows the reason for the decline and no results, and does not look like a failure. A link that names an unknown game reaches that decline | `npm test -- "UI-2:"` | `7e0eb4a` |
| UI-3 | The page is served, and for every brand and game in its pickers the trace renders without an error, in every version | `npm test -- "UI-3:"` | `7e0eb4a` |
| UI-4 | The what-if panel states that the gate reads only the committed file, shows each committed mark, flips pass and fail as a mark moves, and changes no file | `npm test -- "UI-4:"` | `7e0eb4a` |
| UI-5 | Text from the catalogue and from a model reaches the page as text, never as markup | `npm test -- "UI-5:"` | `7e0eb4a` |
| UI-6 | For a game whose tag contradicts its description, the page shows the conflict and how each version handled it | `npm test -- "UI-6:"` | `7e0eb4a` |
| UI-7 | A quote the model copied is marked where it sits in the record's own text, a quote that cannot be placed is said and not dropped, and a bar is as long as the number the response carries | `npm test -- "UI-7:"` | `7e0eb4a` |

What each proof does:

- **UI-1** gives the views a `get` that records every URL, and changes a score, a candidate's score and the floor in a response to see the changed numbers on the page.
- **UI-2** renders every declined request on every brand, and an unknown game, and looks for the reason code, the word "declined", no result and no red label.
- **UI-3** renders 1,200 traces and 300 comparisons through the service's own router.
- **UI-5** renders a response in which every string is a script tag, and every record whose delivered description carries markup.
- **UI-7** renders every game with the model's labels, strips the marks from the text shown and compares it with the cleaned record, then plants a quote that is nowhere in the record and changes a score and the floor.

**What these proofs do not reach, and what does.** They run the views, not a browser: `app.js`, the 60 lines that wire controls to views, is outside `npm test`. `node tools/console-check.ts` drives the page in headless Chrome at 1280 and at 390 pixels wide, and fails when:

- one of the five requests above no longer shows its moment;
- anything is wider than the window, other than a table scrolling in its own box;
- a control reached with Tab shows no focus ring;
- the what-if panel cannot be opened and moved with the keyboard alone, does not say what the gate reads, loses focus when redrawn, or a file under `eval/` or `data/` has changed after the move;
- the page script raises an error;
- anything still animates under `prefers-reduced-motion`.

It is run by hand, because a machine without a browser cannot run it, and its result for a change is in that change's pull request. It was broken on purpose three ways (the focus rule removed, the reduced-motion rule removed, a tag made wider than a phone) and failed each time.

How the console looks and feels is not an invariant and has no proof command. The owner judges it by looking.
