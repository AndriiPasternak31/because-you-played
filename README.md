# because-you-played

A "related games" recommender for a fictional catalogue of slot games, built as a take-home engineering assessment. An offline pipeline enriches and indexes the catalogue, an evaluation decides which version of the index may be served, and a service answers for one game on one brand with no model call.

## Run it

Node 24. No API key, no build step, no network.

```sh
npm install
npm run typecheck
npm test
npm run eval      # scores the committed outputs and writes the verdict the service reads
npm run serve     # http://127.0.0.1:8787, with the console at /
```

```sh
curl 'http://127.0.0.1:8787/api/recommendations?game=okk-50023&brand=tavrenmoor&trace=1'
```

## What to read

| For | Read |
|---|---|
| How the parts fit, and where each product rule is enforced | [`docs/architecture.md`](docs/architecture.md) |
| The evaluation as the owner designed it, before any result | [`eval/refs/evaluation-plan.md`](eval/refs/evaluation-plan.md), [`eval/thresholds.json`](eval/thresholds.json) |
| The result, the service and every invariant with its proof | [`docs/features/service.md`](docs/features/service.md) |
| The catalogue and its planted mess | [`data/README.md`](data/README.md) |
| The rules the agents that built this worked under | [`AGENTS.md`](AGENTS.md) |

## A limit to know before reading any number

The answer key, the catalogue text, the enrichment and the reviewer that decides disputed cases all come from one vendor's models. Related models can share blind spots, so agreement between them is weaker evidence than it looks. The evaluation plan says so, and the only outside check is six questions the owner answers himself. The catalogue is also easier than real supplier data: these numbers show direction and the absence of glaring failure, not production accuracy.
