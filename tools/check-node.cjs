/**
 * Stops, with the reason, when this is not a Node.js version the project runs on.
 *
 *   node tools/check-node.cjs      silence and exit 0 on a version that will do; the reason and exit 1 on any other
 *
 * The code is TypeScript that Node.js runs as it is, with no build step. A version that cannot do that
 * fails with `Unknown file extension ".ts"`, which names neither the cause nor the cure. So every npm
 * script runs this first (`start` in its own line, the others through their `pre...` lines in
 * package.json). `npm install` and the container build run it too, but not first: npm runs
 * `preinstall` after it has put the packages in node_modules, and then stops with the reason.
 *
 * The version needed is read from `engines` in package.json and is written nowhere else.
 * This file has to load on the versions it turns away, so it uses no syntax newer than ES5.
 */
"use strict";

var path = require("path");

/** The lowest major version that will do, from `engines.node`, which has to read ">=N". */
function neededMajor() {
  var file = path.join(__dirname, "..", "package.json");
  var engines = require(file).engines;
  var range = engines ? engines.node : undefined;
  var match = /^>=(\d+)$/.exec(String(range));
  if (!match) throw new Error(file + ' has to name the Node.js version needed as "engines": { "node": ">=N" }, and it says ' + JSON.stringify(range));
  return Number(match[1]);
}

/** What is wrong with running on `found`, a version such as "20.20.2", when `needed` is the lowest major that will do. Null when nothing is. */
function problem(found, needed, executable) {
  var major = Number(String(found).split(".")[0]);
  if (major >= needed) return null;
  return [
    "This needs Node.js " + needed + " or newer, and this is Node.js " + found + " (" + executable + ").",
    "The code is TypeScript that Node.js runs as it is, with no build step. Versions before " + needed + " cannot do that, or were never tried.",
    "",
    "  Get Node.js " + needed + ":       nvm install " + needed + "   or   https://nodejs.org/en/download",
    "  Or run without it:    docker compose up --build   (needs Docker with its Compose plugin)",
  ].join("\n");
}

module.exports = { neededMajor: neededMajor, problem: problem };

if (require.main === module) {
  var reason = problem(process.versions.node, neededMajor(), process.execPath);
  if (reason !== null) {
    console.error(reason);
    process.exit(1);
  }
}
