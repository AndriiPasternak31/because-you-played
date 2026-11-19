/**
 * Starts the service and the console.
 *
 *   node src/service/serve.ts                 http://127.0.0.1:8787
 *   node src/service/serve.ts --port 9000
 *
 * It needs no key and makes no network call. It exits with a reason, and serves nothing, when the
 * index is invalid or there is no passing evaluation verdict for exactly this index.
 * The path options point at other copies of the inputs, which is how the tests start it on a bad one.
 */
import { parseArgs } from "node:util";
import { createService } from "./http.ts";
import { DEFAULT_PATHS, NotServing, loadService } from "./state.ts";

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "127.0.0.1" },
      index: { type: "string", default: DEFAULT_PATHS.indexDir },
      catalogue: { type: "string", default: DEFAULT_PATHS.cataloguePath },
      offerings: { type: "string", default: DEFAULT_PATHS.offeringsPath },
      verdict: { type: "string", default: DEFAULT_PATHS.verdictPath },
      thresholds: { type: "string", default: DEFAULT_PATHS.thresholdsPath },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number, got "${values.port}"`);
  const service = loadService({
    indexDir: values.index,
    cataloguePath: values.catalogue,
    offeringsPath: values.offerings,
    verdictPath: values.verdict,
    thresholdsPath: values.thresholds,
  });
  const server = createService(service);
  server.listen(port, values.host, () => {
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.port : port;
    console.log(`Serving ${service.served.version} of index ${service.served.indexHash.slice(0, 12)} on http://${values.host}:${bound}`);
    console.log(`  ${service.index.records.length} games, brands ${service.offerings.brands.join(", ")}, similarity floor ${service.served.floor}`);
    if (service.offeringsForUnknownGames > 0) console.log(`  ${service.offeringsForUnknownGames} offering(s) name a game the index does not hold; they are never recommended`);
    console.log("  No key is read and no model is called.");
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof NotServing ? error.message : `the service could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
