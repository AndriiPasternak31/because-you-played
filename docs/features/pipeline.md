# Pipeline

**Status:** planned, not built.

**Purpose.** The offline steps that turn the raw catalogue into what the service reads: a model enriches thin records with themes and mechanics from a closed vocabulary, the records are embedded, and a versioned, hashed index is written. Every model call in the product happens here.

**Code.** Not decided yet.

## Invariants

| ID | Invariant | Proof command | Last proved |
|---|---|---|---|
| PL-1 | Enrichment can only write the derived descriptors. A write to a fact of record or to availability is rejected | planned | - |
| PL-2 | Every tag is a term of the closed vocabulary and carries an evidence span copied verbatim from the named source field. Anything else is stripped and counted | planned | - |
| PL-3 | A refusal, an incomplete answer, malformed output and an API error are each rejected and counted separately. None is silently repaired | planned | - |
| PL-4 | Index validation fails on a non-finite value, a wrong dimension, misaligned ids or a hash mismatch | planned | - |
