# Service and evaluation

**Status:** planned, not built.

**Purpose.** The service answers "related games" for one game on one brand from the index, removing everything the brand cannot offer before ranking, and declines when nothing good enough remains. The evaluation measures the committed AI outputs against references the owner made, and its verdict decides whether the service will serve an index at all.

**Code.** Not decided yet. The owner's references and thresholds will be in `eval/refs/` and `eval/thresholds.json`.

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| SV-1 | Availability is filtered before ranking: for every game on every brand, no result is a game that is not live on that brand | planned | - |
| SV-2 | Serving a request makes no model call | planned | - |
| SV-3 | At most one result comes from the anchor game's own family, and a duplicate of the anchor is never returned | planned | - |
| SV-4 | When nothing eligible is good enough, the response is a decline with a reason, not a weaker list | planned | - |
| SV-5 | The service refuses to serve an index that has no passing evaluation verdict bound to that index's hash | planned | - |
| EV-1 | The evaluation runs without an API key over committed outputs, gives the same result on a re-run, and exits non-zero when a gate fails or an input is missing | planned | - |
| EV-2 | Thresholds are read from the owner's file. None is defined in code | planned | - |
