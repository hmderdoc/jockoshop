// Test rig around the REAL Moebius collaboration server (the copy in ./app — see NOTICE.md).
// Starts a joint in-process so tests can talk the genuine protocol over a real WebSocket.
//
//   import { startJointServer } from "./scripts/joint-server/rig.mjs";
//   const joint = await startJointServer({ file: "/tmp/piece.ans" });
//   // joint.url -> "ws://127.0.0.1:53124/piece.ans"
//   await joint.stop();           // saves the .ans (as the real server does) and frees the port
//
// One process, one port: app/server.js keeps a single module-level http server and a `joints`
// map keyed by path, so several joints can share the one port but there is only ever one port
// per process. Asking for a second, different port throws instead of silently ignoring it.
//
// ALWAYS call stop(). Each Joint starts Moebius's HourlySaver, a plain setInterval, and that
// keeps Node alive for an hour if the joint is never closed (upstream is a long-lived daemon, so
// it never needed an unref). stop() ends it.
import { createRequire } from "node:module";
import { once } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// node_modules here is gitignored, so say so plainly rather than throwing MODULE_NOT_FOUND.
function load(id) {
  try {
    return require(id);
  } catch (err) {
    if (err?.code === "MODULE_NOT_FOUND") {
      throw new Error(`joint rig: dependencies are missing. Run:\n  (cd ${here} && npm install)\n\n${err.message}`);
    }
    throw err;
  }
}

/** Moebius's own document library, as the server uses it. Loads fine under plain Node. */
export const libtextmode = load("./app/libtextmode/libtextmode");
/** The copied server module. Its http server and joints map are process-wide singletons. */
export const joint = load("./app/server");

/** paths ("/name") this process has running */
const live = new Set();
let boundPort = 0;

/** Create `file` as an empty .ans if it is not there. The server throws if read_file fails. */
export function ensureFile(file, { columns = 80, rows = 25, ...rest } = {}) {
  const abs = resolve(file);
  if (existsSync(abs)) return abs;
  mkdirSync(dirname(abs), { recursive: true });
  libtextmode.write_file(libtextmode.new_document({ columns, rows, ...rest }), abs);
  return abs;
}

async function listen(port, host) {
  if (joint.server.listening) {
    if (port !== 0 && port !== boundPort) {
      throw new Error(`joint rig: this process is already listening on ${boundPort}; one port per process (asked for ${port})`);
    }
    return boundPort;
  }
  joint.server.listen(port, host);
  await once(joint.server, "listening");
  boundPort = joint.server.address().port;
  return boundPort;
}

async function closeHttp() {
  if (!joint.server.listening) return;
  const closed = once(joint.server, "close");
  // Sockets that were upgraded to WebSockets can outlive server.close(); the server-side
  // ws.close() is a handshake, so give the peers a moment and then cut what is left.
  const cut = setTimeout(() => joint.server.closeAllConnections?.(), 250);
  joint.close(); // ends every joint (each saves its file) and closes the http server
  try {
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
  } finally {
    clearTimeout(cut);
  }
  boundPort = 0;
}

/**
 * Start a joint on the copied Moebius server.
 *
 * @param {object}  opts
 * @param {string}  opts.file      .ans/.bin/.xb to load; created empty (80x25 by default) if absent
 * @param {number} [opts.port=0]   0 picks a free port
 * @param {string} [opts.path]     joint path; defaults to the file's basename, always lower-cased
 * @param {string} [opts.pass=""]  "" accepts any password
 * @param {boolean}[opts.quiet=true] false lets the server log joins/chat/resizes to stdout
 * @param {number} [opts.columns=80] size for a file that has to be created
 * @param {number} [opts.rows=25]
 * @param {string} [opts.host="127.0.0.1"] interface to bind; "0.0.0.0" to let other machines join
 * @returns {Promise<{url: string, port: number, path: string, file: string, stop: () => Promise<void>}>}
 */
export async function startJointServer({ file, port = 0, path, pass = "", quiet = true, columns = 80, rows = 25, host = "127.0.0.1" } = {}) {
  if (!file) throw new Error("joint rig: `file` is required");
  const abs = ensureFile(file, { columns, rows });
  const wanted = `/${(path ?? parsePath(abs).base).toLowerCase()}`;
  if (joint.has_joint(wanted)) throw new Error(`joint rig: ${wanted} is already running in this process`);

  const boundTo = await listen(port, host);
  let jointPath;
  try {
    jointPath = await joint.start_joint({ path, file: abs, pass, quiet, server_port: boundTo });
  } catch (err) {
    if (live.size === 0) await closeHttp();
    throw err;
  }
  live.add(jointPath);

  let stopped = false;
  return {
    url: `ws://127.0.0.1:${boundTo}${jointPath}`,
    port: boundTo,
    path: jointPath,
    file: abs,
    async stop() {
      if (stopped) return;
      stopped = true;
      live.delete(jointPath);
      if (live.size === 0) {
        await closeHttp(); // joint.close() saves every joint's file on the way out
      } else {
        joint.end_joint(jointPath); // Joint.close() -> save()
      }
    },
  };
}
