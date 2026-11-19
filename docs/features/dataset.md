# Dataset

**Status:** planned, not built.

**Purpose.** A fictional catalogue of slot games that looks like it came from a real source system: thin, inconsistent and partly wrong, with a hidden record of what each game really is so that later stages can be scored against it. A model writes the descriptive text; seeded code decides everything else.

**Code.** Expected in `src/dataset/`, with its output in `data/`.

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| DS-1 | Re-running the seeded degradation over the committed model responses reproduces the catalogue byte for byte | planned | - |
| DS-2 | The model writes descriptive text only. Facts of record and availability rows are written by seeded code | planned | - |
| DS-3 | The catalogue contains every kind of mess it is meant to, and the count for each kind is printed | planned | - |
| DS-4 | Model output that is refused, cut short or malformed is rejected with its reason and counted. It is never repaired | planned | - |
