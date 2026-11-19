# UI and UX guidelines

What the console is for, how it should behave, and the tokens and components to build it from. The aim is that an agent can build the console from this file alone.

**Status.** This file is a proposal, written before there was a console. Whether a console exists has one home, the **Status** line of [`docs/features/interface.md`](features/interface.md), which also holds the behaviour that can be proved (UI-1 to UI-3). #3 asks for a console that works and #4 for one that is readable. Nothing checks these guidelines by machine, and the mapping of colours to meanings below stays a proposal until the owner has looked at a console built from it.

## What the console is for

It makes one request readable from end to end. A person picks a brand and a game and sees the raw record, what enrichment added and the text it quoted, what each filter removed, the scores against the similarity floor, and the result or the reason for declining.

The reader is someone who has never seen the project. The console is an inspection page for that reader. It is not the page a player would see. Clarity is the goal. Presentation beyond clarity is not what the work is judged on (#4).

## Principles

1. **One request, one page.** It reads top to bottom: what went in, what was removed, what was scored, what came out. Nothing the reader needs is behind a tab. Where order matters, the console follows the trace and does not impose an order of its own.
2. **Show the system's own data.** Every value comes from the service's response to this request (UI-1). The console computes no score and writes no explanation of its own.
3. **Evidence sits beside the claim.** A tag appears with the text it quoted and the field the text came from. A field with no tags says "abstained" or "conflicting" in words.
4. **Numbers are exact.** Scores are shown as returned, with the floor beside them. Counts appear beside any rate.
5. **A decline is an outcome, not an error.** It shows its reason and no results (UI-2), and it does not look like a failure.
6. **Colour carries meaning and never carries it alone.** A coloured label always has words.
7. **No AI-written text is shown as if it were shown to players** (#4).
8. **Plain.** Ruled sections, no cards, no shadows, no motion.

## Colour tokens

Colours are CSS custom properties on the root element. Components use the tokens and never a literal colour.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--paper` | `#f5f1e8` | `#131e28` | Page background |
| `--wash` | `#ebe6dc` | `#1b2935` | Quiet fill: raw record, code, neutral label |
| `--ink` | `#172f45` | `#ebe6da` | Text, and the fill of the main button |
| `--muted` | `#5d6870` | `#9aa7b1` | Secondary text, table headings, control borders |
| `--line` | `#cfcbbf` | `#34444f` | Rules between sections and rows |
| `--plum` | `#79566e` | `#cfa6c2` | Accent: section labels, focus ring, what enrichment added |
| `--green` | `#386653` | `#84c3a2` | Kept: a result, a score at or above the floor |
| `--ochre` | `#885d1a` | `#dcb062` | Caution: abstained, conflicting, declined |
| `--red` | `#9b4f48` | `#e39a92` | Failure: an error, the service not serving |
| `--slate` | `#4a6a85` | `#8fb4d2` | Neutral fact: a source field, a version |
| `--plum-wash` | `#e9dfe6` | `#33283a` | Fill behind plum text |
| `--green-wash` | `#e1ebe3` | `#1d3229` | Fill behind green text |
| `--ochre-wash` | `#f1e6cf` | `#3a301c` | Fill behind ochre text |
| `--red-wash` | `#f1dfdc` | `#3b2523` | Fill behind red text |
| `--slate-wash` | `#dde6ee` | `#1f303d` | Fill behind slate text |

Anything that is not one of these meanings is ink or muted.

**Themes.** Dark follows the system setting. A `data-theme` attribute on the root element overrides it, so a toggle can be added later without changing a component.

```css
:root { /* light values */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark values */ color-scheme: dark; }
}
:root[data-theme="dark"] { /* dark values */ color-scheme: dark; }
```

**Measured contrast.** WCAG 2 contrast ratios, computed from the values above. Small text needs 4.5.

| Text on background | Light | Dark |
|---|---|---|
| `--ink` on `--paper` | 12.18 | 13.56 |
| `--ink` on `--wash` | 11.04 | 11.92 |
| `--muted` on `--paper` | 5.06 | 6.86 |
| `--muted` on `--wash` | 4.59 | 6.03 |
| `--plum` on `--paper` | 5.53 | 7.95 |
| `--plum` on `--plum-wash` | 4.80 | 6.57 |
| `--green` on `--green-wash` | 5.38 | 6.69 |
| `--ochre` on `--ochre-wash` | 4.68 | 6.44 |
| `--red` on `--red-wash` | 4.53 | 6.31 |
| `--slate` on `--slate-wash` | 4.50 | 6.22 |
| `--line` on `--paper` | 1.44 | 1.68 |

`--line` is far below 3, so it is only for rules that separate things. The border of a control uses `--muted`. Put coloured text only on paper or on its own wash: the other pairings are not measured here.

## Type

No web fonts. Three stacks:

- **Display:** `Georgia, "Times New Roman", serif`
- **Body:** `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
- **Mono:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

| Role | Stack | Size and style | Used for |
|---|---|---|---|
| Page title | Display | 38px, line height 1.1, regular weight | The one `h1`. 30px at phone width |
| Section heading | Display | 24px, line height 1.2, regular weight | Each section |
| Sub-heading | Display | 17px, line height 1.3, regular weight | A group inside a section |
| Body | Body | 15px, line height 1.55 | Everything else |
| Lede | Body | 16.5px, `--muted` | One sentence under a heading saying what happened there |
| Small | Body | 13px, `--muted` | Notes, footer, provenance |
| Label | Body | 11px, weight 700, upper case, letter spacing 1.5px | Section labels in `--plum`, table headings in `--muted`, status labels |
| Machine text | Mono | 12.5px | Ids, the raw record, quoted evidence, reason codes |
| Figures | Body | `font-variant-numeric: tabular-nums` | Every score, count and timing |

Serif headings stay at regular weight. Sizes are given in pixels at the browser's default text size. Set them in `rem` so the reader's own text size applies.

## Layout

- One column, 1000px at most, centred, with a gutter of at least 16px.
- Each section is closed by a 1px `--line` rule, with 28px of space above and below. A 2px `--plum` rule on top marks a group that needs emphasis.
- Spacing comes in steps of 4px: 4, 8, 12, 16, 28.
- Fills have a radius of 3 to 4px. Nothing has a shadow.
- At phone width everything stacks. A wide table scrolls inside its own container and the page never scrolls sideways.

## Components

| Component | What it is | Notes |
|---|---|---|
| Request picker | A labelled native `select` for the brand, one for the game, and one button | The button is `--ink` with `--paper` text. Choosing is the only input the console has |
| Section | Label, heading, one-sentence lede, then the content | The five sections are: raw record, enrichment, removals, scores, outcome |
| Raw record | The record as the source delivered it, in mono on `--wash` | Verbatim. A field that is absent, null or empty is shown as such and not left blank |
| Tag with evidence | The tag as a plum label, the quoted text in mono, and the source field as a slate label | The quote may be highlighted inside the raw record or listed beside it. A field with no tags shows an ochre "abstained" or "conflicting" label |
| Removals table | One row per filter in the trace: its name, how many games it removed, and the games on request | Rows are in the order the trace gives. Use `details` for the list of games. A filter that removed nothing still has a row with 0. The family cap is a row like any other, wherever the service applies it |
| Score list | A table of candidates in rank order: rank, game, score | The floor is a labelled rule drawn between the rows above it and the rows below it. Rows below it are `--muted` |
| Outcome | The results as a short list with a green "result" label, or the decline | A decline shows an ochre "declined" label, the reason code in mono, one plain sentence, and the statement that a player would see nothing |
| Status label | Upper-case label text in a colour on that colour's wash | The words are the meaning. One fact per label |
| Provenance line | Small text at the foot: index version and hash, offerings version, time per stage | Only what the response carries |

If the service's response offers the raw-text and the enriched-text ranking side by side, show both score lists under one heading with the same floor treatment. Whether it does is for #3 to decide.

## States

Every state occupies the place where the trace appears, so the page does not jump.

| State | When | What the reader sees |
|---|---|---|
| Empty | Nothing chosen yet | The picker and one sentence saying what the page will show. No sample trace |
| Loading | A request is in flight | The word "Loading" where the trace will appear. No spinner |
| Result | The service returned results | All five sections |
| Declined | The service declined | The sections the trace has data for, then the decline. No results list, and no red |
| Bad input | The service rejected the request | What was wrong with the request, in a sentence, beside the picker |
| Not serving | The service has no index it may serve | A red "not serving" label and the reason the service gave, if the page loads at all in that case (#3 decides). This is not a decline and must not look like one |
| Failed | The request did not complete | A red "failed" label, what happened, and that nothing is shown because nothing was received. Never an empty trace |

An error is never shown as an empty result, and an empty result is never shown as an error.

## Accessibility basics

- **Structure.** One `h1`, headings in order, a real `table` for tabular data, native `select`, `button` and `details`. Set `lang` on the root element.
- **Labels.** Every control has a visible `label`.
- **Focus.** A 2px `--plum` outline with a 2px offset on anything focusable, never removed. Everything works from the keyboard, in reading order.
- **Contrast.** Use only the pairings measured above.
- **Meaning.** Colour is never the only signal: labels have words, and the floor is a labelled line.
- **Announcements.** The region where the trace appears is `aria-live="polite"`, so a result, a decline and an error are announced.
- **Motion.** There is none to reduce. If any is added, honour `prefers-reduced-motion`.

## What only the owner judges

The look and feel of the console is judged by the owner, who looks at it ([What is the owner's](../AGENTS.md#what-is-the-owners), [`REVIEW.md`](../REVIEW.md)). #4 is done only when the owner has signed off.

An agent shows what can be shown by running something, and reports the rest as not verified:

- the three paths click through: a result, a family-cap removal and a decline (#3);
- the page works at phone width and in both themes (#4), shown as screenshots or commands on the commit;
- every colour in the built page is a token from this file.

An agent does not write that the console looks good, clear or finished.

One value here is not from the look the owner chose. Light `--ochre` was `#9a6a1e`, which measures 3.81 on `--ochre-wash` and 4.18 on `--paper`. It is darkened to `#885d1a` so that small caution text reaches 4.5. Keeping or reverting that is the owner's call.
