# Interface

**Status:** planned, not built.

**Purpose.** A minimal console, served by the service, that shows what the system did for one game on one brand: the raw record, the enrichment tags and where each came from, what each filter removed, the scores, and the result or the reason for declining.

**Code.** Not decided yet.

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| UI-1 | Everything the console shows for a request comes from the service's response to that request. The console makes no model call | planned | - |
| UI-2 | A declined request shows the reason for the decline and no results | planned | - |
| UI-3 | On a clean clone, choosing a brand and a game reaches the trace without an error | planned | - |

How the console looks and feels is not an invariant and has no proof command. The owner judges it by looking.
