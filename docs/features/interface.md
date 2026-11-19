# Interface

**Status:** built, as a working console. How it looks is not signed off: that is the owner's, and #4.

**Purpose.** A console, served by the service at `/`, that shows what the system did for one game on one brand, and the evidence for which version of the index is served.

| View | What it shows |
|---|---|
| Trace | For one game and brand, top to bottom: the raw record, what each step added with the quote behind every label, what each filter removed, the scores against the floor, the result or the decline |
| Side by side | The same request against all four versions: the labels each holds and what each would recommend |
| Race | The four versions: pairwise accuracy, wrongly shown, model calls, cost, pass or fail |
| Where it helps | The same accuracy split by the condition of the record |
| Failures | Three to five real failures the evaluation found, and, apart from them, the mess planted on purpose |
| What-if | An icon beside the verdict opens the pass marks as sliders, each with the committed mark as a fixed tick. Pass and fail update as a slider moves |

- **A game whose tag contradicts its description** shows the contradicted tag, what the table did (nothing), and whether the model's reading stands, in the trace and in every column of the side-by-side.
- **The version picker** defaults to the served version. Any other is marked "inspection": it is the same core over another version of the index, and never what a player is served.
- **The what-if panel changes no file.** A move sends one `GET /api/what-if` with the marks in the URL; the service applies the real gate to the measured numbers and writes nothing. The panel says that the release gate reads only `eval/thresholds.json`.
- **A request can be linked:** `/?game=<id>&brand=<brand>&version=<version>` opens its trace.

## Code

No build step and no framework.

| Path | What it holds |
|---|---|
| `src/console/view.js` | Every view, as a plain function from the service's responses to HTML text. It touches no DOM, so the tests run it as it is |
| `src/console/view.d.ts` | Its types, for the tests |
| `src/console/app.js` | The glue: reads the controls, calls `GET /api/…`, puts a view's HTML on the page |
| `src/console/index.html`, `console.css` | The page, and the tokens and type of [`ui-guidelines.md`](../ui-guidelines.md) |
| `src/console/console.test.ts` | The tests. Each name starts with the invariant it proves |

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| UI-1 | Everything the console shows for a request comes from the service's response to that request. The console asks only this service's own routes and makes no model call | `npm test -- "UI-1:"` | `aee8e18` |
| UI-2 | A declined request shows the reason for the decline and no results, and does not look like a failure | `npm test -- "UI-2:"` | `aee8e18` |
| UI-3 | The page is served, and for every brand and game in its pickers the trace renders without an error, in every version | `npm test -- "UI-3:"` | `aee8e18` |
| UI-4 | The what-if panel states that the gate reads only the committed file, shows each committed mark, flips pass and fail as a mark moves, and changes no file | `npm test -- "UI-4:"` | `aee8e18` |
| UI-5 | Text from the catalogue and from a model reaches the page as text, never as markup | `npm test -- "UI-5:"` | `aee8e18` |
| UI-6 | For a game whose tag contradicts its description, the page shows the conflict and how each version handled it | `npm test -- "UI-6:"` | `aee8e18` |

What each proof does:

- **UI-1** gives the views a `get` that records every URL, and changes a score, a candidate's score and the floor in a response to see the changed numbers on the page.
- **UI-2** renders every declined request on every brand, and an unknown game, and looks for the reason code, the word "declined", no result and no red label.
- **UI-3** renders 1,200 traces and 300 comparisons through the service's own router.
- **UI-5** renders a response in which every string is a script tag, and every record whose delivered description carries markup.

**What these proofs do not reach.** They run the views, not a browser: `app.js`, the 60 lines that wire controls to views, has no test. It was driven once in headless Chrome for this change: the pickers, each decline, the version flip, a slider moved and reset with the two files hashed before and after, the page at 390 pixels wide and in the dark theme. That run is not a committed proof.

How the console looks and feels is not an invariant and has no proof command. The owner judges it by looking.
