# UI and UX guidelines

What the console is for, how it behaves, and the tokens and components it is built from. The aim is that an agent can change the console from this file alone.

**Status.** This file describes the console as it is built (#3 made it work, #4 made it readable). The look is the one the owner chose for #4: near-black with green. Whether that look is signed off has one home, the **Status** line of [`docs/features/interface.md`](features/interface.md), which also holds the behaviour that can be proved (UI-1 to UI-7). Nothing checks these guidelines by machine.

## What the console is for

It makes one request readable from end to end. A person picks a brand and a game and sees the raw record, what enrichment added and the text it quoted, what each filter removed, the scores against the similarity floor, and the result or the reason for declining. Below the trace it shows why the served version is the one served.

The reader is someone who has never seen the project. The console is an inspection page for that reader. It is not the page a player would see. Clarity is the goal. Presentation beyond clarity is not what the work is judged on (#4).

## Principles

1. **One request, one page.** It reads top to bottom: what went in, what was removed, what was scored, what came out. Nothing the reader needs is behind a tab. Where order matters, the console follows the trace and does not impose an order of its own.
2. **Show the system's own data.** Every value comes from the service's response to this request (UI-1). The console computes no score and writes no explanation of its own. What it adds is drawing: a bar as long as a number in the response, a count of a list in the response, a quote marked where it sits in the record (UI-7).
3. **Evidence sits beside the claim.** A label appears with the text it quoted and the field the text came from. A field with no labels says "abstained" or "conflicting" in words.
4. **A picture before a paragraph.** Where a flow or a bar says it faster, it replaces the sentence. A bar always has its exact number beside it.
5. **Numbers are exact.** Scores are shown as returned, with the floor beside them. Counts appear beside any rate.
6. **A decline is an outcome, not an error.** It shows its reason and no results (UI-2). It is amber, never red.
7. **Colour carries meaning and never carries it alone.** A coloured label always has words.
8. **No AI-written text is shown as if it were shown to players** (#4).
9. **Calm.** Ruled sections and flat panels. Motion only where it helps the eye follow an order or a size, once, and none for a reader who asked for less.

## Colour tokens

Colours are CSS custom properties on the root element, in `src/console/console.css`. Components use the tokens and never a literal colour.

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#090c0a` | Page background |
| `--panel` | `#0f1411` | A panel: the raw record, an enrichment step, a result, a callout |
| `--panel-2` | `#141b17` | A fill inside a panel: quoted text in place, the what-if summary, a plain tag |
| `--line` | `#1b2620` | Rules between sections and rows, and the empty part of a bar |
| `--line-strong` | `#2b3b33` | The top rule of a panel, a step that did not run, the border of a neutral label |
| `--edge` | `#5f7468` | The border of a control |
| `--text` | `#e4ede7` | Text, and a tick on a bar or a slider |
| `--muted` | `#8fa197` | Secondary text, table headings, small labels |
| `--green` | `#35d07f` | Kept: a result, a score at or above the floor, a pass, what is served. Also the main button and a step that ran |
| `--mint` | `#a8f0c6` | Links, the focus ring, text on `--green-deep` |
| `--amber` | `#e8b44a` | Caution: thin, abstained, conflicting, declined, a moved pass mark, exploration only |
| `--red` | `#f0806f` | Failure: a failed pass mark, an error, the service not serving |
| `--blue` | `#7fb6e8` | The model: a label it asserted, the words it quoted, what it cost |
| `--green-deep` `#123524`, `--amber-deep` `#3a2c0f`, `--red-deep` `#3d1a15`, `--blue-deep` `#14283a` | | The fill behind a label of that colour |
| `--on-green` | `#04130b` | Text on the main button |

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
| `--on-green` on `--green` | 9.50 |
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
| Page title | Display | 35 to 56px with the width, line height 1.04 | The one `h1` |
| Section heading | Display | 22 to 29px with the width, line height 1.15 | Each `h2`, and the title of a trace |
| Step heading | Display | 20px | Each `h3`: a step of the trace, a part of the evaluation |
| Sub-heading | Body | 16px, weight 600 | Each `h4`: a step inside enrichment, a group in the evaluation |
| Body | Body | 16px, line height 1.55 | Everything else |
| Lede | Body | 16px, `--muted`, 68 characters wide at most | One or two sentences under a heading saying what is shown |
| Small | Body | 13.6px, `--muted` | Notes, captions, counts beside a rate |
| Kicker | Mono | 11.5px, upper case, letter spacing 0.1em | The line above a heading, table headings |
| Status label | Mono | 10.9px, upper case, in a pill | A state: live, thin, declined, pass, fail, served |
| Tag | Mono | 12.5px, lower case, in a 3px box | A theme or a mechanic |
| Machine text | Mono | 13px | Ids, quoted evidence, reason codes, the provenance line |
| Figure | Display | 24px, tabular | The headline number of a version in the race |
| Figures | any | `font-variant-numeric: tabular-nums` | Every score, count and timing |

Sizes are set in `rem`, so the reader's own text size applies.

## Layout

- One column, 1000px at most, centred, with a gutter of 16px.
- Sections are separated by a 1px `--line` rule with 40px above and below. A 2px rule on top of a panel says what kind it is: green for the trace and the verdict, blue for the model's step, amber for the what-if panel.
- Spacing is small and even: mostly 4, 8, 12, 16, 24 and 40px.
- Panels are flat fills with no shadow. Radii are small, 2 to 6px, and labels are pills. The only glow is on a lit dot of the steps at a glance.
- From 760px up, the five steps of a trace hang on a rail: a numbered node per step and a line between them. Below 760px the rail is dropped and each step carries its number above its heading.
- At phone width everything stacks. A wide table scrolls inside its own container and the page never scrolls sideways.

## Components

| Component | What it is | Notes |
|---|---|---|
| Request picker | A labelled native `select` for the brand, the game and the version, and one button | The button is `--green` with `--on-green` text. The version defaults to the served one; any other is marked "inspection" at the top of its trace |
| Steps at a glance | Five dots joined by a line, each with a name and one fact: record, labels, removed, scored, outcome | Each fact is a count or a state from the response, and links to its step. A step that did not run is an empty dot; a decline is an amber one. Before a request it shows the five names only |
| Step of the trace | A numbered node, a kicker, a heading, a lede, then the content | The five steps are: raw record, enrichment, removals, scores, outcome. A step that did not run keeps its place, with a grey node and one sentence |
| Raw record | The record as the source delivered it, as a list of field and value on a panel | Verbatim. A field that is absent, null or empty is shown as such and not left blank |
| Enrichment step | A panel per step: cleaning, synonym table, thin rule, model, and what the version holds | Each says in a label who did it: code, a lookup, a rule, or the model asked offline |
| Label with evidence | The tag, the quoted text in mono, and the field it came from | A model's tag is blue and a table's is plain. A field with no labels shows an amber "abstained" or "conflicting" |
| Words in place | The cleaned title or description with each quote the model copied underlined in blue | A quote that cannot be found in the text is counted in an amber label, never dropped |
| Conflict | An amber callout: what the tag asserts, a "≠", what the description states, then what the table and the model each did | Shown inside the synonym table's step |
| Removals | One row per filter in the order the trace gives: its name, how many it removed, how many are left, a bar of what is left, its rule, and the games in a `details` | The list is open when it holds five games or fewer. A filter that removed nothing still has a row |
| Score list | A table of candidates in rank order: rank, game, score, and the score as a bar from 0 to 1 | The floor is a tick on every bar and a labelled row between the scores above it and below it. Rows below it are `--muted`. The list scrolls inside its own box |
| Outcome | The results as numbered rows with a green "result" label, or the decline | A decline is an amber callout: a "declined" label, the reason code in mono, one plain sentence, and the statement that a player would see nothing |
| Rank matrix | One row per game any version would return, one column per version, the rank in the cell | A filled cell is a result; a dash is not one. The served column is labelled |
| Side by side | One table, a column per version: outcome, themes, mechanics, results | Each label keeps its quote. At phone width the table scrolls and the row names stay in place |
| Verdict | A panel with the version that ships in display type, the gate's reason, and the owner's check | A button with a gear beside it opens the what-if panel |
| Race | One row per version: pairwise accuracy as a number, its count and a bar from 0 to 100% with the committed pass mark as a tick; cost as a number and a blue bar against the dearest version; pass or fail | Below 760px each version is a block of its own |
| By condition, and measures | Tables with a column per version | A small bar under each rate. Each measure has its meaning beside its name |
| What-if | An amber-ruled panel: the statement that the gate reads only the committed file, what would ship with the marks now set, then one row per pass mark with a native range input | The committed mark is a fixed `--text` tick on each slider. A moved mark turns its thumb amber and carries a "moved" label |
| Status label | Upper-case words in a pill | The words are the meaning. One fact per label |
| Provenance line | Mono text at the foot of a trace: index hash, version, time per stage | Only what the response carries |

## Motion

Motion is there to help the eye follow an order or a size, and it runs once when a view appears.

| What moves | How | Why |
|---|---|---|
| Steps at a glance | The dots light and the lines grow from left to right, 0.14s apart | The request is read in that order |
| Bars | A fill grows from zero in 0.8s | The eye lands on the length |
| Results | Each row rises 6px, 0.06s apart | They are read in rank order |
| The gear | Turns a quarter when hovered or open | It is a control |
| The serving dot | A slow change of opacity | The only motion that repeats |

With `prefers-reduced-motion: reduce` every animation and transition is off and the page is complete without them. Nothing in the what-if panel animates, so a slider can be moved without the page moving.

## States

Every state occupies the place where the trace appears.

| State | When | What the reader sees |
|---|---|---|
| Empty | Nothing chosen yet | The picker, one sentence, and the five steps named with empty dots. No sample trace |
| Loading | A request is in flight | The word "Loading" where the trace will appear. No spinner |
| Result | The service returned results | All five steps |
| Declined | The service declined | The steps the trace has data for, the rest in grey, then the decline. No results list, and no red |
| Bad input | The service rejected the request | An amber "bad request" label and what was wrong, in a sentence |
| Not serving | The evaluation's verdict names no version | A red "not serving" label in the verdict, if the page loads at all: the service does not start without a passing verdict (SV-5) |
| Failed | The request did not complete | A red "failed" label, what happened, and that nothing is shown because nothing was received. Never an empty trace |

An error is never shown as an empty result, and an empty result is never shown as an error.

## Accessibility basics

- **Structure.** One `h1`, headings in order, a real `table` for tabular data, native `select`, `button`, `input type="range"` and `details`. `lang` is set on the root element. The race keeps its table roles when it becomes blocks at phone width.
- **Labels.** Every control has a visible `label`. A node's number is repeated for a screen reader as "Step 1:".
- **Focus.** A 2px `--mint` outline with a 2px offset on anything focusable, never removed. Everything works from the keyboard, in reading order, including the score list's scroll box.
- **Contrast.** Only the pairings measured above.
- **Meaning.** Colour is never the only signal: a label has words, the floor is a labelled row as well as a tick, a moved mark says "moved".
- **Announcements.** The regions where the trace, the comparison and the evaluation appear are `aria-live="polite"`.
- **Motion.** See [Motion](#motion).

## What only the owner judges

The look and feel of the console is judged by the owner, who looks at it ([What is the owner's](../AGENTS.md#what-is-the-owners), [`REVIEW.md`](../REVIEW.md)). #4 is done only when the owner has signed off.

An agent shows what can be shown by running something, and reports the rest as not verified:

- the walkthrough's requests click through at desktop and phone width with nothing overflowing the page, shown as screenshots in [`docs/screenshots/`](screenshots/) and as commands on the commit;
- every colour in the stylesheet is a token from this file;
- the contrast table above is computed from those tokens.

An agent does not write that the console looks good, clear or finished.
