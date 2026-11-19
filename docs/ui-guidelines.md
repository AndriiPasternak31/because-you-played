# UI and UX guidelines

What the page is for, how it is arranged, how it behaves, and the tokens and components it is built from. The aim is that an agent can change the page from this file alone.

**Status.** This file describes the page as it is built. Its layout is the owner's: one page, four sections switched from a panel across the top, the question on the left and its answer centre and right. The look is the one he chose: near-black with green. Whether it is signed off has one home, the **Status** line of [`docs/features/interface.md`](features/interface.md), which also holds the behaviour that can be proved (UI-1 to UI-18). Nothing checks these guidelines by machine, except where a section names the check that does.

## What the page is for

It is the inspection view of a related-games recommender, not the screen a player would see, and it says so in its first line. A visitor has about two minutes and has never seen the project. The page answers four questions, one at a time.

## How the page is arranged

**One section is open at a time.** A panel across the top holds the line saying what the page is, the game and brand pickers, a menu of examples, and four links that switch between the sections. Under it, the open section puts its question on the left, in plain words, with a line on why it matters, and its answer for the chosen game and brand centre and right.

| | Section | The question, on the left | The answer, centre and right |
|---|---|---|---|
| 1 | What is shown | What would a player who played this game be shown next? | A sentence stating the outcome, then the games, each with the labels it has in common with the game played. A decline takes the same place, with its reason in a sentence |
| 2 | What the model added | What did the language model add to this game's record? | One or two sentences read from the record's own data; then the supplier's structured fields, the labels the version holds, and one phrase the model read |
| 3 | What was removed | Which games were left out, and why? | A sentence counting what each of three things took out; then the steps, each a button that opens what it removed |
| 4 | Was it worth it | Was the language model worth its cost? | A sentence saying which version is served and what was measured for it; then the four versions' measured quality and estimated cost, and what the other versions return for this request |

**Much less on screen.** Everything else that is true stays on the page and out of sight until asked for, each piece under a control that names it: the other three sections, the exact scores and identifiers, the supplier's text with every quote marked, the steps one by one, the raw record, the timings, every pass mark, the evaluation's tables, the failures, and the comparison of versions. There is no single "show details". Identifiers and long decimals appear only inside those controls; a picker names a game by its title.

**What a reader sees without scrolling is behaviour, not look, and it is checked.** At 1280 by 640 and at 390 by 664, for every game on every brand in the served version and for each of the four sections, the line saying what the page is, the four section links, the section's question and the sentence that answers it are wholly on screen, and so is the first game of a result. `node tools/console-check.ts` fails when that stops being true (UI-13). Outside those sizes it is not proved: a shorter window can push the answer down.

**The address says what is open.** `section=` names the open section, beside the game, the brand and the version, so a link opens the same view.

## Principles

1. **One question at a time.** See [How the page is arranged](#how-the-page-is-arranged).
2. **Show the system's own data.** Every value comes from this service's responses (UI-1). The page computes no score, no label and no verdict. What it adds is reading and drawing: a bar as long as a number, a count of a list, a quote marked where it sits, the labels two records both hold, the overlap of two lists, and a search of the responses for a game that shows something.
3. **Claim only what is true of what is on screen.** If a view would have to imply something the service does not guarantee, or the evaluation did not measure, the claim is left out. In particular:
   - The sentence over the results says what the service guarantees: each game is live on the brand and cleared the similarity floor. It does not call them related (UI-14).
   - A sentence about a record is read from that record's own data, never assumed from the version being shown (UI-15).
   - A failure the evaluation found is said only where it was found: in that version, and on that brand when it is about a request (UI-16).
   - What a result has in common with the game played is worded as what they share, never as the cause of its score (UI-9).
   - A different list from another version is not called a better one. "Better" rests only on the evaluation's measured numbers (UI-10).
   - The similarity floor is described as what it is, a point in the spread of scores, not as evidence that a player would find a result relevant (UI-11).
   - The evaluation's limits are on the page: a fictional catalogue, an answer key that is the generator's own plan, text written by the model that does the enrichment, a reviewer that is a model. Costs are estimates and read as such.
   - The page shows the answer to the latest request and never a late answer to an earlier one (UI-17). An address is taken as written, and what is wrong with it is said in the service's words (UI-18).
4. **Evidence sits in the text itself.** A label carries a number, and the same number sits on the words it was read from. A field with no labels says "abstained" or "conflicting" in words.
5. **A picture before a paragraph.** Where a row of steps or a bar says it faster, it replaces the sentence. A bar always has its exact number beside it.
6. **Numbers are exact where they are shown.** A score is shown as returned, inside the control that holds it, with the floor beside it. Counts appear beside any rate.
7. **A decline is an outcome, not an error.** It shows its reason and no results (UI-2). It is amber, never red.
8. **Colour carries meaning and never carries it alone.** A coloured label always has words.
9. **No AI-written text is shown as if it were shown to players** (#4).
10. **Calm.** Flat panels and one rule under the top panel. Motion only where it helps the eye follow a change or a size, once, and none for a reader who asked for less.
11. **"The page".** In anything a reader sees, the page calls itself the page.

## Colour tokens

Colours are CSS custom properties on the root element, in `src/console/console.css`. Components use the tokens and never a literal colour.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#090c0a` | Page background |
| `--panel` | `#0f1411` | A panel: a result, a card, a step, a drawer's heading, a callout, the open section's link |
| `--panel-2` | `#141b17` | A fill inside a panel: an open step, the examples menu, the what-if summary, a plain tag |
| `--line` | `#1b2620` | Rules between sections and rows, and the empty part of a bar |
| `--line-strong` | `#2b3b33` | The rule under the top panel, the top rule of a card, the border of a drawer or a neutral label |
| `--edge` | `#5f7468` | The border of a control: a picker, a button, the examples menu, a step of the path |
| `--text` | `#e4ede7` | Text, and a tick on a bar or a slider |
| `--muted` | `#8fa197` | Secondary text, table headings, small labels |
| `--green` | `#35d07f` | Kept: a result, a score at or above the floor, a pass, what is served, what is shown. Also the section that is open |
| `--mint` | `#a8f0c6` | Links, the focus ring, a number that joins a label to its words |
| `--amber` | `#e8b44a` | Caution: thin, abstained, conflicting, declined, removed, a failure the evaluation found, a moved pass mark, exploration only |
| `--red` | `#f0806f` | Failure: a failed pass mark, an error, the service not serving |
| `--blue` | `#7fb6e8` | The model: a label it asserted, the words it quoted, what it cost |
| `--green-deep` `#123524`, `--amber-deep` `#3a2c0f`, `--red-deep` `#3d1a15`, `--blue-deep` `#14283a` | | The fill behind a label of that colour |

Anything that is not one of these meanings is text or muted. A label from the synonym table is plain, so that blue means the model and nothing else.

**One look.** There is no light theme. #4 asked for light and dark; the owner then chose a single near-black look, and the page declares `color-scheme: dark` whatever the system setting. Because every component reads the tokens, a second theme would be a second set of values on the root and no change to a component.

**Measured contrast.** WCAG 2 contrast ratios, computed from the values above. Small text needs 4.5 and the edge of a control 3.

| Text on background | Ratio |
|---|---|
| `--text` on `--bg` / `--panel` / `--panel-2` | 16.44 / 15.57 / 14.65 |
| `--muted` on `--bg` / `--panel` / `--panel-2` | 7.22 / 6.83 / 6.43 |
| `--green` on `--bg` / `--panel` / `--green-deep` | 9.81 / 9.29 / 6.72 |
| `--mint` on `--bg` / `--panel` / `--green-deep` | 14.92 / 14.13 / 10.22 |
| `--amber` on `--bg` / `--panel` / `--amber-deep` | 10.35 / 9.80 / 7.15 |
| `--red` on `--bg` / `--panel` / `--red-deep` | 7.51 / 7.11 / 5.91 |
| `--blue` on `--bg` / `--panel` / `--blue-deep` | 9.13 / 8.65 / 7.00 |
| `--text` on `--blue-deep` | 12.60 |
| `--text` / `--muted` on `--amber-deep` | 11.35 / 4.99 |
| `--mint` / `--green` / `--amber` / `--blue` on `--panel-2` | 13.30 / 8.74 / 9.22 / 8.14 |
| `--edge` on `--bg` / `--panel` | 3.92 / 3.71 |
| `--line-strong` on `--bg` | 1.66 |
| `--line` on `--bg` | 1.26 |

`--line` and `--line-strong` are far below 3, so they only separate things and never carry a meaning alone. Put coloured text only on the backgrounds measured here.

Amber and red are close for some readers, and so are green and amber. That is why a status is always a word: "declined", "fail", "pass".

## Type

No web fonts: the page loads nothing a fresh clone does not hold. Three stacks:

- **Display:** `"Avenir Next", "Segoe UI", system-ui, sans-serif`, weight 700
- **Body:** `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`
- **Mono:** `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`

| Role | Stack | Size and style | Used for |
|---|---|---|---|
| Page title | Display | 21.6px, 18.4px on a phone | The one `h1`, in the top panel |
| Question | Display | 20.8 to 28px with the width | The `h2` of a section |
| Answer | Body | 16.8px, `--text` | The sentence that answers the question |
| Card heading | Body | 15px, weight 600 | An `h3` inside a card, a stage or the table of versions |
| Body | Body | 16px, line height 1.55 | Everything else |
| Small | Body | 13.6px, `--muted` | Why the question matters, notes, captions, counts beside a rate |
| Kicker | Mono | 11.5px, upper case, letter spacing 0.1em | What the page is, the number of a section, table headings |
| Status label | Mono | 10.9px, upper case, in a pill | A state: result, declined, served, thin, pass, fail, removed |
| Tag | Mono | 12.5px, lower case, in a 3px box | A theme or a mechanic, or a tag as the supplier sent it |
| Machine text | Mono | 13px | Ids, quoted evidence, reason codes, inside the controls that hold them |
| Figure | Display | 21px, tabular | The count on a step of the path, the rank of a result |
| Figures | any | `font-variant-numeric: tabular-nums` | Every score, count and timing |

Sizes are set in `rem`, so the reader's own text size applies. A long word breaks rather than widen the page.

## Layout

- One column, 1180px at most, centred, with a gutter of 16px.
- The top panel is one row from 900px up: the title and the line saying what the page is, then the pickers and the examples menu; the four section links run under it in a row. A picker is as wide as its longest choice, so nothing in the panel is cut off.
- From 900px up a section is two columns, the question in about a third and the answer in the rest. Below that the question sits above its answer.
- From 760px up the three cards of the second section sit side by side, and a stage of the path is a row of steps with the open step's list beneath the row. Below that everything stacks.
- At phone width the pickers take two rows with their labels kept for a screen reader only, the section links make a two-by-two grid, and the number of the section and the example's line are dropped from the question, which the links and the menu already carry.
- A wide table scrolls inside its own container and the page never scrolls sideways, down to 320px with every control open.
- Panels are flat fills with no shadow. Radii are small, 2 to 6px, and labels are pills. Spacing is small and even: mostly 4, 8, 12, 16, 24 and 40px.

## Components

| Component | What it is | Notes |
|---|---|---|
| Top panel | The title, a kicker saying this is the inspection view of a recommender and not the screen a player would see, the pickers, the examples menu, and the section links | Not sticky: switching a section returns the page to its top |
| Pickers | A native `select` for the game and one for the brand. A third, for the version of the index, is at the foot of the page | The page follows a choice at once and keeps the open section. A game is named by its title; two games that share a title are told apart by supplier. A game, brand or version an address names and the catalogue does not hold keeps an option, so the request goes out as written and the service says what is wrong |
| Examples menu | A `details` that opens a short list over the page: one link per thing worth seeing, each with one line on what it shows | Found by asking the service, never named in the code. Choosing one closes the menu and opens the section that shows it. An example the data does not hold says that none was found. Escape closes the menu |
| Section links | Four links, numbered, in the order of the sections | Each carries the request and its section, so it opens the same view in a new tab. The open one has a green rule under it and `aria-current` |
| Section | The question as an `h2`, a line on why it matters, and the example's line when one is open; beside it the answer | The sections that are not open are `hidden`, so they are out of the tab order and of a screen reader's reading until opened |
| Answer | One or two sentences in body text at full strength, first in the right column | For a decline: an amber callout, "the service recommends nothing, and says why", the reason as a sentence, that a player would see nothing, and the reason code |
| Result | A numbered row: rank, title, supplier, and what it has in common with the game played as tags | A blue tag was added by the model for the game played, a plain one came from the supplier's tags. With nothing in common the row says so. Scores and identifiers are in the control under the list |
| Known failure | An amber callout under the result, in the evaluation's own words | Only in the version, on the brand and with the result the evaluation found it for |
| Three cards | The supplier's structured fields; what the version holds; one phrase the model read | A supplier tag is plain, struck through when it is not about the game, dashed when the table does not know it, amber when the description contradicts it |
| Text with marks | In a drawer: the cleaned title and description with each quoted phrase underlined in blue and followed by the number of its label | A label whose words cannot be found says so in amber, never silently |
| Stage | A numbered heading, a row of steps, and one honest sentence | The three stages are eligibility, the floor and the limit, in the order the trace gives them |
| Step | A button with the border of a control: how many games are left, what a game must be to pass, how many were removed, and a thin bar of what is left | Opens the list of what it removed with the trace's reason for each. One step is open at a time. A game a link points at is marked in its list |
| The four versions | A small table with a blue top rule: pairwise accuracy and estimated cost to build, a bar under each number, the served version and any failed pass mark labelled; then one line per other version saying how many of this request's games it returns | States what the measured number does and does not show, and that a different list is not a better list |
| Drawer | A `details` with a circled plus and a summary that names what is inside | Closed on arrival |
| What-if | An amber-ruled panel opened by a button with a gear, in the fourth section: the statement that the gate reads only the committed file, what would ship with the marks now set, then one row per pass mark with a native range input | The committed mark is a fixed `--text` tick on each slider. A moved mark turns its thumb amber and carries a "moved" label |
| Status label | Upper-case words in a pill | The words are the meaning. One fact per label |

## Motion

Motion helps the eye follow a change or a size, and it runs once.

| What moves | How | Why |
|---|---|---|
| A section that is opened | The question slides in from the left and the answer from the right, 14px, in about 0.3s | The reader sees that the page changed, and where the two halves are |
| The rule under the open section's link | Grows across in 0.25s | It marks where the reader is |
| Results | Each row rises 6px, 0.06s apart | They are read in rank order |
| Steps of the path | Each step rises 6px, 0.09s apart | The path is read in that order |
| Bars | A fill grows from zero in 0.8s | The eye lands on the length |
| The examples menu | Rises 6px as it opens | It opens over the page |
| The gear | Turns a quarter when hovered or open | It is a control |

With `prefers-reduced-motion: reduce` every animation and transition is off and the page is complete without them. A section is in place and readable from the first frame: the transition never hides it from the keyboard or from assistive technology. Nothing in the what-if panel animates, so a slider can be moved without the page moving.

## States

| State | When | What the reader sees |
|---|---|---|
| Landing | No request in the address | The first example, at the first section, so the first screen shows a recommendation |
| Loading | A request is in flight | The word "Loading" where the answer will appear. No spinner |
| Result | The service returned results | The first section's sentence and the results |
| Declined | The service declined | The decline in the place of the results, with its reason in a sentence. The other sections say what the trace has, and a sentence where a part did not run |
| Empty | No example could be found and nothing is chosen | One sentence asking for a choice |
| Bad input | The service rejected the request, for instance a brand it does not know | An amber "bad request" label and the service's own words for what was wrong |
| Not serving | The evaluation's verdict names no version | A red "not serving" label in the fourth section, if the page loads at all: the service does not start without a passing verdict (SV-5) |
| Failed | The request did not complete | A red "failed" label, what happened, and that nothing is shown because nothing was received |

An error is never shown as an empty result, and an empty result is never shown as an error.

## Accessibility basics

- **Structure.** One `h1`, an `h2` for the question of each section, a real `table` for tabular data, native `select`, `button`, `input type="range"` and `details`. `lang` is set on the root element.
- **Sections.** The section links are links in a labelled `nav`; the open one carries `aria-current`. A section that is not open is `hidden`. Switching keeps focus on the link that was used.
- **Labels.** Every control has a `label`. A step is a button whose `aria-expanded` says whether its list is open.
- **Focus.** A 2px `--mint` outline with a 2px offset on anything focusable, never removed. Everything works from the keyboard, in reading order.
- **Contrast.** Only the pairings measured above.
- **Meaning.** Colour is never the only signal: a label has words, the floor is a labelled row as well as a tick, a moved mark says "moved".
- **Announcements.** The region where a request's sections appear is `aria-live="polite"`.
- **Motion.** See [Motion](#motion).

## What only the owner judges

The look and feel of the page is judged by the owner, who opens it and looks ([What is the owner's](../AGENTS.md#what-is-the-owners), [`REVIEW.md`](../REVIEW.md)). #4 is done only when the owner has signed off.

What a reader sees on one screen, first and without help, is not look. It is behaviour, and an agent checks it in a browser at a fixed window size ([How the page is arranged](#how-the-page-is-arranged)). An agent shows what can be shown by running something, and reports the rest as not verified:

- every colour in the stylesheet is a token from this file;
- the contrast table above is computed from those tokens.

An agent does not write that the page looks good, clear or finished.
