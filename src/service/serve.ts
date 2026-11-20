/**
 * Starts the service and the console.
 *
 *   node src/service/serve.ts                 http://127.0.0.1:8787
 *   node src/service/serve.ts --port 9000
 *
 * It needs no key and makes no network call. It exits with a reason, and serves nothing, when the
 * index is invalid, there is no passing evaluation verdict for exactly this index, or the port is taken.
 * Once it listens it prints the address to open and one request that returns results.
 * The path options point at other copies of the inputs, which is how the tests start it on a bad one.
 */
import { parseArgs } from "node:util";
import { createService } from "./http.ts";
import { recommend } from "./recommend.ts";
import { DEFAULT_PATHS, NotServing, loadService, type Service } from "./state.ts";

/** The first request that returns the most results from what was loaded. It is found by asking, so a rebuilt index cannot leave a dead example on the screen. */
function requestWithResults(service: Service): string | undefined {
  let best: { path: string; results: number } | undefined;
  for (const record of service.index.records) {
    for (const brand of service.offerings.brands) {
      const results = recommend(service.served, { gameId: record.game_id, brand }).results.length;
      if (results > (best?.results ?? 0)) best = { path: `/api/recommendations?game=${encodeURIComponent(record.game_id)}&brand=${encodeURIComponent(brand)}`, results };
    }
  }
  return best?.path;
}

/** The address a browser on this machine reaches the listener at: one bound to every interface is reached through the loopback address. */
function reachableAt(host: string, port: number): string {
  const name = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${name.includes(":") ? `[${name}]` : name}:${port}`;
}

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
  const example = requestWithResults(service);
  const server = createService(service);
  // Without this a taken port is an uncaught exception: a stack trace, with the cause somewhere inside it.
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `not serving: port ${port} on ${values.host} is already in use by another program. Choose another with --port, for example: npm start -- --port ${port < 65535 ? port + 1 : port - 1}`
        : `the service could not start: ${error.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, values.host, () => {
    const address = server.address();
    const bound = typeof address === "object" && address !== null ? address.port : port;
    const base = reachableAt(values.host, bound);
    console.log(`Serving ${service.served.version} of index ${service.served.indexHash.slice(0, 12)} on ${base}`);
    console.log(`  ${service.index.records.length} games, brands ${service.offerings.brands.join(", ")}, similarity floor ${service.served.floor}`);
    if (service.offeringsForUnknownGames > 0) console.log(`  ${service.offeringsForUnknownGames} offering(s) name a game the index does not hold; they are never recommended`);
    console.log("  No key is read and no model is called.");
    console.log("");
    console.log(`  Open   ${base}/`);
    console.log(example === undefined ? "  No game returns a result on any brand: every request is declined." : `  Try    curl '${base}${example}'`);
    console.log("  Stop   Ctrl+C");
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof NotServing ? error.message : `the service could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
