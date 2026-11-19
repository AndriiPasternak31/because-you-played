/**
 * The thin HTTP wrapper around the recommender core.
 *
 * `route` is a plain function from a method and a URL to a response, so everything but the
 * socket can be tested without one. Every route is a GET that reads what was loaded at the
 * start. Nothing here writes a file, and nothing here can reach a model: the service holds no key.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { MARKS, decide, parseThresholds, type Measured, type Thresholds } from "../../eval/gate.ts";
import { VERSIONS, type Version } from "../pipeline/versions.ts";
import { liveCounts } from "./offerings.ts";
import { BadRequest, DEFAULT_LIMIT, FLOOR_RULE, MAX_LIMIT, recommend } from "./recommend.ts";
import type { Service } from "./state.ts";

export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

const json = (status: number, value: unknown): Reply => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) });
const badRequest = (message: string): Reply => json(400, { error: "bad_request", message });

const CONSOLE_DIR = join(import.meta.dirname, "..", "console");
// The page's script and stylesheet are built files, committed under dist/ (tools/build-console.ts). Nothing is built when a request arrives.
const CONSOLE_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/console/console.css": { file: "dist/console.css", contentType: "text/css; charset=utf-8" },
  "/console/app.js": { file: "dist/app.js", contentType: "text/javascript; charset=utf-8" },
};

/** Reads the query into a map, refusing a parameter the route does not know and one given twice. */
function query(url: URL, allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name)) throw new BadRequest(`unknown parameter "${name}". This route takes: ${allowed.join(", ")}`);
    if (values.has(name)) throw new BadRequest(`parameter "${name}" was given more than once`);
    values.set(name, value);
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new BadRequest(`parameter "${name}" is required`);
  return value;
}

function limitOf(values: Map<string, string>): number {
  const text = values.get("limit");
  if (text === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(text)) throw new BadRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}, got "${text}"`);
  return Number(text);
}

function flag(values: Map<string, string>, name: string): boolean {
  const text = values.get(name);
  if (text === undefined || text === "0") return false;
  if (text === "1") return true;
  throw new BadRequest(`${name} must be 0 or 1, got "${text}"`);
}

function catalogue(service: Service): unknown {
  return {
    served: { version: service.served.version, index_hash: service.served.indexHash, floor: service.served.floor, floor_rule: `${FLOOR_RULE.id}: ${FLOOR_RULE.rule}` },
    versions: VERSIONS,
    brands: liveCounts(service.offerings),
    offerings_for_unknown_games: service.offeringsForUnknownGames,
    games: service.index.records.map((record) => ({
      game_id: record.game_id,
      title: record.canonical.title,
      provider: record.canonical.provider,
      evidence: record.evidence,
      thin: record.thin,
      conflict: record.conflict !== null,
      family_id: record.canonical.family_id,
      status: Object.fromEntries(service.offerings.brands.map((brand) => [brand, service.offerings.statusByBrand.get(brand)?.get(record.game_id) ?? "not_offered"])),
    })),
  };
}

const WHAT_IF_NOTE =
  "What-if only. These marks were passed in the request and are written nowhere. The release gate reads only the committed file eval/thresholds.json, through the verdict the evaluation wrote.";

/** Applies the real gate to the measured numbers with other pass marks. Reads the report; writes nothing. */
function whatIf(service: Service, values: Map<string, string>): unknown {
  const committed = parseThresholds(service.thresholds, "eval/thresholds.json");
  const marks: Thresholds = { ...committed, enrichment: { ...committed.enrichment }, matching: { ...committed.matching }, ship_rule: { ...committed.ship_rule } };
  const number = (name: string): number | undefined => {
    const text = values.get(name);
    if (text === undefined) return undefined;
    const value = Number(text);
    if (text.trim().length === 0 || !Number.isFinite(value) || value < 0) throw new BadRequest(`${name} must be a number of at least 0, got "${text}"`);
    return value;
  };
  for (const mark of MARKS) {
    const value = number(mark.key);
    if (value === undefined) continue;
    if (mark.group === "enrichment") marks.enrichment[mark.key] = value;
    else marks.matching[mark.key] = value;
  }
  const margin = number("margin");
  if (margin !== undefined) marks.ship_rule.margin = margin;
  const measured = (service.report as { measured: Record<Version, Measured> }).measured;
  return { what_if: true, note: WHAT_IF_NOTE, marks, committed, decision: decide(measured, marks) };
}

export function route(service: Service, method: string, rawUrl: string): Reply {
  if (method !== "GET") return json(405, { error: "method_not_allowed", message: "This service only answers GET. No request changes anything." });
  let url: URL;
  try {
    url = new URL(rawUrl, "http://service.invalid");
  } catch {
    return badRequest("the request URL could not be read");
  }
  try {
    switch (url.pathname) {
      case "/api/recommendations": {
        const values = query(url, ["game", "brand", "limit", "trace"]);
        return json(200, recommend(service.served, { gameId: required(values, "game"), brand: required(values, "brand"), limit: limitOf(values), trace: flag(values, "trace") }));
      }
      case "/api/inspect": {
        // For the console's comparison: the same core over another version of the index. Never the answer a player gets.
        const values = query(url, ["game", "brand", "limit", "version"]);
        const version = required(values, "version");
        if (!(VERSIONS as readonly string[]).includes(version)) throw new BadRequest(`unknown version "${version}". Versions: ${VERSIONS.join(", ")}`);
        const response = recommend(service.byVersion[version as Version], { gameId: required(values, "game"), brand: required(values, "brand"), limit: limitOf(values), trace: true });
        return json(200, { ...response, inspection: { served_version: service.served.version, is_served_version: version === service.served.version } });
      }
      case "/api/catalogue":
        query(url, []);
        return json(200, catalogue(service));
      case "/api/evaluation":
        query(url, []);
        return json(200, { verdict: service.verdict, thresholds: service.thresholds, thresholds_file: "eval/thresholds.json", marks: MARKS, report: service.report });
      case "/api/what-if":
        return json(200, whatIf(service, query(url, [...MARKS.map((mark) => mark.key), "margin"])));
      default: {
        const asset = CONSOLE_FILES[url.pathname];
        if (asset === undefined) return json(404, { error: "not_found", message: `no route ${url.pathname}` });
        return { status: 200, contentType: asset.contentType, body: readFileSync(join(CONSOLE_DIR, asset.file), "utf8") };
      }
    }
  } catch (error) {
    if (error instanceof BadRequest) return badRequest(error.message);
    throw error;
  }
}

export function createService(service: Service): Server {
  return createServer((request, response) => {
    let reply: Reply;
    try {
      reply = route(service, request.method ?? "GET", request.url ?? "/");
    } catch (error) {
      // Not a decline and not bad input: the service itself failed. Say so, and say why on the server's own log.
      console.error(`request ${request.method} ${request.url} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      reply = json(500, { error: "internal_error", message: "The service failed to answer this request. Nothing was returned." });
    }
    const headers: Record<string, string> = { "content-type": reply.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (reply.status === 405) headers["allow"] = "GET";
    response.writeHead(reply.status, headers);
    // A HEAD reply has no body by the protocol; it is a 405 like any other method that is not GET.
    response.end(request.method === "HEAD" ? undefined : reply.body);
  });
}
