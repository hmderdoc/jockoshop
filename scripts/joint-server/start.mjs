#!/usr/bin/env node
// Run a real Moebius collaboration server (the vendored copy in ./app) so you can join it from
// killerdraw AND from an installed Moebius.app at the same time.
//
//   node scripts/joint-server/start.mjs --file piece.ans --port 8000 --path name --pass x
//
//   --file <path>    the .ans/.bin/.xb to serve; created empty if it is not there (default ./joint.ans)
//   --port <n>       default 8000 (Moebius.app assumes 8000 when you leave the port off)
//   --path <name>    joint name; default is the file's basename, always lower-cased
//   --pass <text>    default "" = no password
//   --columns <n>    size used only when the file has to be created (default 80)
//   --rows <n>       (default 25)
//   --host <addr>    default 0.0.0.0, as upstream: other machines on the LAN can join
//   --quiet          do not log joins / chat / resizes
//
// Ctrl-C saves the file and exits, exactly as the upstream server.js does.
import { networkInterfaces } from "node:os";
import { startJointServer } from "./rig.mjs";

const argv = process.argv.slice(2);
const opts = { file: "./joint.ans", port: 8000, path: undefined, pass: "", quiet: false, columns: 80, rows: 25, host: "0.0.0.0" };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--quiet") { opts.quiet = true; continue; }
  if (arg === "--help" || arg === "-h") {
    console.log("usage: node scripts/joint-server/start.mjs [--file piece.ans] [--port 8000] [--path name] [--pass x] [--columns 80] [--rows 25] [--host 0.0.0.0] [--quiet]");
    process.exit(0);
  }
  const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
  if (!m || !(m[1] in opts)) { console.error(`unknown argument: ${arg}`); process.exit(2); }
  const value = m[2] !== undefined ? m[2] : argv[++i];
  if (value === undefined) { console.error(`${arg} needs a value`); process.exit(2); }
  opts[m[1]] = ["port", "columns", "rows"].includes(m[1]) ? Number(value) : value;
}

const joint = await startJointServer(opts);
const name = joint.path.slice(1);
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
console.log(`serving ${joint.file}`);
console.log(`  websocket   ${joint.url}`);
console.log(`  Moebius.app File > Connect to Server…   localhost:${joint.port}/${name}`);
for (const ip of lan) console.log(`              from another machine:        ${ip}:${joint.port}/${name}`);
if (opts.pass) console.log(`  password    ${opts.pass}`);
console.log("Ctrl-C to stop (the file is saved on the way out)");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await joint.stop();
  console.log(`\nsaved ${joint.file}`);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
