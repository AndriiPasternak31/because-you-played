# UI and UX guidelines

What the console is for, the order it puts things in, how it behaves, and the tokens and components it is built from. The aim is that an agent can change the console from this file alone.

**Status.** This file describes the console as it is built. #3 made it work; #4 first restyled it and then, at the owner's request, rebuilt its layout. The look is the one the owner chose: near-black with green. Whether it is signed off has one home, the **Status** line of [`docs/features/interface.md`](features/interface.md), which also holds the behaviour that can be proved (UI-1 to UI-12). Nothing checks these guidelines by machine, except where a section names the check that does.

## What the console is for

It is the inspection view of a related-games recommender, not the screen a player would see. A visitor has about two minutes and has never seen the project. In that time the page has to answer four questions, each at a glance, with the evidence one click away and never in the way.

## The order of the page

**The result or the decline comes first, and the evidence comes beneath it.** This is a rule, and it replaces an earlier one. The page used to follow the trace from raw record to outcome and "impose no order of its own", which put the recommendations at the very bottom of an engineer's log. The page now imposes this order:

| | The question | What answers it, without opening anything |
|---|---|---|
| 0 | What is this page? | One line under the title: a recommender, opened up, and not the screen a player would see |
| 1 | What does it recommend? | A sentence that states the outcome, then the games, each with what it has in common with the game played. A decline is said in the same place, with its reason in a sentence |
| | Was the model worth it? In short | Beside the result: the measured quality and cost of every version, then what the other versions return for the same request |
| 2 | What did the model add? | What the supplier's structured fields held, what the index holds now, one phrase the model read, and the supplier's text with every quoted phrase marked |
| 3 | Why these and not others? | The steps from the catalogue to the result as three different things: which games may be shown at all, which are similar enough, and how many are shown |
| 4 | Was the model worth it? The evidence | The gate's verdict, each pass mark as passed or failed, the what-if sliders, and what the numbers do not show |

**The first screen is behaviour, not look, and it is checked.** At 1280 by 900 and at 390 by 844, on the landing page and on every example the page offers, the line saying what the page is, the sentence stating the outcome, and the first result or the decline are on screen with no scrolling. `node tools/console-check.ts` fails when that stops being true, and writes the uncropped first screen of each. The page never scrolls itself: a link that points at evidence opens it or names it, and leaves the reader at the top.

**Nothing true is deleted; it is put in order.** The raw record, the step-by-step enrichment with model and prompt names, every score, the per-version comparison, the timings and the evaluation's tables stay on the page, each folded under its own control. A control's name says what it opens. There is no single "show details".

## Principles

1. **Result first.** See [The order of the page](#the-order-of-the-page).
2. **Show the system's own data.** Every value comes from this service's responses (UI-1). The console computes no score, no label and no verdict. What it adds is reading and drawing: a bar as long as a number, a count of a list, a quote marked where it sits, the labels two records both hold, the overlap of two lists, and a search of the responses for a game that shows something.
3. **Claim only what was measured.** If a view would have to imply something the evaluation did not measure in order to look convincing, the claim is left out. In particular:
   - What a result has in common with the game played is worded as what they share, never as the cause of its score. The ranking is a similarity between two texts and cannot be traced to single labels, and the page says so (UI-9).
   - A different list from another version is not called a better one. "Better" rests only on the evaluation's measured numbers, shown beside it (UI-10).
   - The similarity floor is described as what it is, a point in the spread of scores. It is not offered as evidence that a player would find a result relevant (UI-11).
   - The evaluation's limits are on the page: a fictional catalogue, an answer key and a model from one vendor, direction rather than production accuracy.
   - Where the evaluation lists a failure for the game on screen, the page says it with the result.
4. **Evidence sits in the text itself.** A label carries a number, and the same number sits on the words it was read from. A field with no labels says "abstained" or "conflicting" in words.
5. **A picture before a paragraph.** Where a row of steps or a bar says it faster, it replaces the sentence. A bar always has its exact number beside it.
6. **Numbers are exact.** Scores are shown as returned, with the floor beside them. Counts appear beside any rate.
7. **A decline is an outcome, not an error.** It shows its reason and no results (UI-2). It is amber, never red.
8. **Colour carries meaning and never carries it alone.** A coloured label always has words.
9. **No AI-written text is shown as if it were shown to players** (#4).
10. **Calm.** Ruled blocks and flat panels. Motion only where it helps the eye follow an order or a size, once, and none for a reader who asked for less.

## Colour tokens

Colours are CSS custom properties on the root element, in `src/console/console.css`. Components use the tokens and never a literal colour.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#090c0a` | Page background |
| `--panel` | `#0f1411` | A panel: a result, a card, a step, a drawer's heading, a callout |
| `--panel-2` | `#141b17` | A fill inside a panel: an open step, the open example, the what-if summary, a plain tag |
| `--line` | `#1b2620` | Rules between sections and rows, and the empty part of a bar |
| `--line-strong` | `#2b3b33` | The top rule of a card, the border of an example, a drawer or a neutral label |
| `--edge` | `#5f7468` | The border of a control: a picker, a button, a step of the path |
| `--text` | `#e4ede7` | Text, and a tick on a bar or a slider |
| `--muted` | `#8fa197` | Secondary text, table headings, small labels |
| `--green` | `#35d07f` | Kept: a result, a score at or above the floor, a pass, what is served, what is shown |
| `--mint` | `#a8f0c6` | Links, the focus ring, the game played in a heading, a number that joins a label to its words |
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
| Page title | Display | 27 to 38px with the width | The one `h1` |
| Question heading | Display | 20 to 26px with the width | Each `h2`. The game played is in `--mint` |
| Card heading | Body | 15px, weight 600 | An `h3` inside a card, a stage or the aside |
| Body | Body | 16px, line height 1.55 | Everything else |
| Lede | Body | 15.7px, `--muted`, 68 characters wide at most | The sentence under a heading. The sentence that states the outcome is one |
| Small | Body | 13.6px, `--muted` | Notes, captions, counts beside a rate |
| Kicker | Mono | 11.5px, upper case, letter spacing 0.1em | The numbered line above a heading, table headings |
| Status label | Mono | 10.9px, upper case, in a pill | A state: result, declined, served, thin, pass, fail, removed |
| Tag | Mono | 12.5px, lower case, in a 3px box | A theme or a mechanic, or a tag as the supplier sent it |
| Machine text | Mono | 13px | Ids, quoted evidence, reason codes |
| Figure | Display | 21px, tabular | The count on a step of the path, the rank of a result |
| Figures | any | `font-variant-numeric: tabular-nums` | Every score, count and timing |

Sizes are set in `rem`, so the reader's own text size applies.

## Layout

- One column, 1120px at most, centred, with a gutter of 16px.
- Blocks are separated by a 1px `--line` rule with 32px above and below, one block per question.
- From 900px up, the first block is two columns: the result, and a 380px aside for the model's value. Below that the aside follows the result.
- From 760px up, the three cards of "what the model added" sit side by side, and a stage of the path is a row of steps with the open step's list beneath the row. Below that everything stacks, and a step's list opens under the step.
- At phone width the pickers take two rows, the examples run sideways in a strip of their own in which only the open one shows its line, and the serving line is dropped. A wide table scrolls inside its own container and the page never scrolls sideways.
- Panels are flat fills with no shadow. Radii are small, 2 to 6px, and labels are pills. Spacing is small and even: mostly 4, 8, 12, 16, 24 and 32px.

## Components

| Component | What it is | Notes |
|---|---|---|
| Header | A kicker saying this is the inspection view and not the screen a player would see, the title, one sentence, and the serving line | The serving line is from the catalogue route |
| Request picker | A labelled native `select` for the game, the brand and the version | The page follows a choice at once, and says so beside the first label. The version defaults to the served one; any other is marked "inspection" on its result |
| Examples | A list of links, one per thing worth seeing, each with one line on what it shows in the game it found | Found by asking the service, never named in the code. An example the data does not hold is shown dashed, with the words that none was found. The open one is outlined in green |
| Outcome sentence | "Given *game* on *brand*, the service returns *n* related games that are live there, best match first", with a green "result" label | For a decline: an amber callout, "the service recommends nothing, and says why", the reason as a sentence, that a player would see nothing, and the reason code |
| Result | A numbered row: rank, title, provider and id, what it has in common with the game played as tags, and its score | A blue tag was added by the model for the game played, a plain one came from the supplier's tags. With nothing in common the row says so |
| Model's value, in short | An aside with a blue top rule, level with the heading: a small table of measured quality and cost with a bar under each number, the served version and any failed pass mark labelled, then one line per other version saying how many of these games it returns and whether it was built with the model | States what the measured number does and does not show, and that a different list is not a better list |
| Known failure | An amber callout under the result, in the evaluation's own words | Shown for any game the evaluation lists a real failure for |
| This example | A neutral label and the example's line under the result, with a link to the part that shows it | The page does not scroll there |
| Three cards | The supplier's structured fields; what the version holds; one phrase the model read | A supplier tag is plain, struck through when it is not about the game, dashed when the table does not know it, amber when the description contradicts it |
| Text with marks | The cleaned title and description with each quoted phrase underlined in blue and followed by the number of its label | A label whose words cannot be found says so in amber, never silently |
| Stage | A numbered heading, a row of steps, and one honest sentence | The three stages are eligibility, the floor and the limit, in the order the trace gives them |
| Step | A button with the border of a control: how many games are left, what a game must be to pass, how many were removed, and a thin bar of what is left | Opens the list of what it removed with the trace's reason for each. One step is open at a time. A game a link points at is marked in its list |
| Drawer | A `details` with a circled plus and a summary that names what is inside | Closed on arrival. Holds the raw record, the step-by-step enrichment, every score, the per-version comparison, the timings, and the evaluation's tables |
| Verdict | A panel with the served version in display type, one sentence of measured facts, the gate's own words, and the state of the owner's check | |
| Pass marks | A table, a row per mark and a column per version: pass, fail or does not apply, with what was measured | |
| What-if | An amber-ruled panel opened by a button with a gear: the statement that the gate reads only the committed file, what would ship with the marks now set, then one row per pass mark with a native range input | The committed mark is a fixed `--text` tick on each slider. A moved mark turns its thumb amber and carries a "moved" label |
| Status label | Upper-case words in a pill | The words are the meaning. One fact per label |

## Motion

Motion is there to help the eye follow an order or a size, and it runs once when a view appears.

| What moves | How | Why |
|---|---|---|
| Results | Each row rises 6px, 0.06s apart | They are read in rank order |
| Steps of the path | Each step rises 6px, 0.09s apart, from the catalogue to what is shown | The path is read in that order |
| Bars | A fill grows from zero in 0.8s | The eye lands on the length |
| The gear | Turns a quarter when hovered or open | It is a control |
| The serving dot | A slow change of opacity | The only motion that repeats |

With `prefers-reduced-motion: reduce` every animation and transition is off and the page is complete without them. Nothing in the what-if panel animates, so a slider can be moved without the page moving.

## States

| State | When | What the reader sees |
|---|---|---|
| Landing | No request in the link | The first example, opened, so the first screen shows a recommendation |
| Loading | A request is in flight | The word "Loading" where the answer will appear. No spinner |
| Result | The service returned results | The outcome sentence and the results, then the three blocks of evidence |
| Declined | The service declined | The decline in the place of the results, with its reason in a sentence. The evidence the trace has, and a sentence where a part did not run |
| Empty | No example could be found and nothing is chosen | One sentence asking for a choice |
| Bad input | The service rejected the request | An amber "bad request" label and what was wrong, in a sentence |
| Not serving | The evaluation's verdict names no version | A red "not serving" label in the verdict, if the page loads at all: the service does not start without a passing verdict (SV-5) |
| Failed | The request did not complete | A red "failed" label, what happened, and that nothing is shown because nothing was received |

An error is never shown as an empty result, and an empty result is never shown as an error.

## Accessibility basics

- **Structure.** One `h1`, a heading per question, a real `table` for tabular data, native `select`, `button`, `input type="range"` and `details`. `lang` is set on the root element.
- **Labels.** Every control has a visible `label`. A step is a button whose `aria-expanded` says whether its list is open.
- **Focus.** A 2px `--mint` outline with a 2px offset on anything focusable, never removed. Everything works from the keyboard, in reading order, including the score list's scroll box.
- **Contrast.** Only the pairings measured above.
- **Meaning.** Colour is never the only signal: a label has words, the floor is a labelled row as well as a tick, a moved mark says "moved".
- **Announcements.** The regions where the request, the examples, the comparison and the evaluation appear are `aria-live="polite"`.
- **Motion.** See [Motion](#motion).

## What only the owner judges

The look and feel of the console is judged by the owner, who looks at it ([What is the owner's](../AGENTS.md#what-is-the-owners), [`REVIEW.md`](../REVIEW.md)). #4 is done only when the owner has signed off.

What a reader sees first, on one screen and without help, is not look. It is behaviour, and an agent checks it ([The order of the page](#the-order-of-the-page)). An agent shows what can be shown by running something, and reports the rest as not verified:

- the first screen of the landing page and of every example, at both fixed sizes, as uncropped screenshots in [`docs/screenshots/`](screenshots/) and as a check that fails when the result leaves the first screen;
- every colour in the stylesheet is a token from this file;
- the contrast table above is computed from those tokens.

An agent does not write that the console looks good, clear or finished.
