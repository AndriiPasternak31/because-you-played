/**
 * Starts the service and the console.
 *
 *   node src/service/serve.ts                 http://127.0.0.1:8787
 *   node src/service/serve.ts --port 9000     or PORT=9000 in the environment; the option wins
 *
 * It needs no key and makes no network call. It exits with a reason, and serves nothing, when the
 * index is invalid, there is no passing evaluation verdict for exactly this index, or another program
 * holds the port on any address of this machine.
 * Once it listens it prints the address to open and one request that returns results.
 * The path options point at other copies of the inputs, which is how the tests start it on a bad one.
 */
import net from "node:net";
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

/**
 * The first address on which another program already holds the port, if there is one.
 *
 * Listening on the chosen address is not enough of a check. macOS lets this service take a port on
 * 127.0.0.1 while another program holds the same port on every interface, and `localhost` on that port
 * can then reach the other program. So the port has to be free on the chosen address, on both loopback
 * addresses and on both "every interface" addresses.
 */
async function heldOn(port: number, host: string): Promise<string | undefined> {
  for (const address of new Set([host, "127.0.0.1", "::1", "0.0.0.0", "::"])) {
    const code = await new Promise<string | undefined>((resolve) => {
      const probe = net.createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      probe.listen(port, address, () => probe.close(() => resolve(undefined)));
    });
    if (code === "EADDRINUSE") return address;
    // A machine without IPv6 has no such address to hold a port on. Anything else is a failure, not an answer.
    if (code !== undefined && code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw new Error(`port ${port} on ${address} could not be checked: ${code}`);
  }
  return undefined;
}

const taken = (port: number, address: string): string =>
  `not serving: port ${port} on ${address} is already in use by another program. Choose another with --port, for example: npm start -- --port ${port < 65535 ? port + 1 : port - 1}`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: process.env["PORT"] ?? "8787" },
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
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`the port, from --port or PORT, must be a number from 0 to 65535, got "${values.port}"`);
  const service = loadService({
    indexDir: values.index,
    cataloguePath: values.catalogue,
    offeringsPath: values.offerings,
    verdictPath: values.verdict,
    thresholdsPath: values.thresholds,
  });
  const example = requestWithResults(service);
  // Port 0 asks the system for any free port, so there is no port to check beforehand.
  const held = port === 0 ? undefined : await heldOn(port, values.host);
  if (held !== undefined) throw new NotServing(taken(port, held));
  const server = createService(service);
  // Without this a port taken in the moment since the check is an uncaught exception: a stack trace, with the cause somewhere inside it.
  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? taken(port, values.host) : `the service could not start: ${error.message}`);
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
  await main();
} catch (error) {
  console.error(error instanceof NotServing ? error.message : `the service could not start: ${error instanceof Error ? error.message : String(error)}`);
  // npm hands options to a script only after a bare "--"; without it they arrive mangled, or not at all.
  if (error instanceof Error && String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS")) console.error("Through npm, options go after a bare --, for example: npm start -- --port 9000");
  process.exitCode = 1;
}
