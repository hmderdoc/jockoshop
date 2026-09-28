/**
 * Somewhere to send a finished piece — a BBS, usually your own.
 *
 * This file is the part that has no network in it: what a connection is made
 * of, how remote paths are spelled, and which names a server will accept. The
 * transport lives in the app (packages/app/src/remote.ts) because only the
 * desktop shell can open a socket; a browser is not allowed to speak FTP at
 * all, so there is nothing to share between them but this.
 *
 * `kind` is the one field that matters for later: SFTP or a WebDAV PUT would be
 * another kind beside "ftp", with the same profile list and the same dialog.
 */

/** How a connection is reached. Only "ftp" exists so far; it covers FTPS too, via `secure`. */
export type RemoteKind = "ftp";

export interface RemoteProfile {
  /** stable id, so renaming a connection does not lose it */
  id: string;
  /** what the user calls it — "my board" */
  name: string;
  kind: RemoteKind;
  host: string;
  port: number;
  user: string;
  /** the directory uploads land in */
  dir: string;
  /** explicit TLS: AUTH TLS before logging in, so the password is not sent in the clear */
  secure: boolean;
  /** passive mode — what works from behind a NAT, and what every BBS expects */
  passive: boolean;
  /** kept only when the user asks for it; see rememberPassword in the app */
  password?: string;
}

export const FTP_PORT = 21;
/** Anonymous FTP's conventional login, and what a read-only board usually wants. */
export const ANONYMOUS = "anonymous";

/** Counts up so two profiles made in the same millisecond cannot collide. */
let made = 0;

export function newProfile(name = "my BBS"): RemoteProfile {
  const id = `r${Date.now().toString(36)}${(made++).toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
  return { id, name, kind: "ftp", host: "", port: FTP_PORT, user: "", dir: "/", secure: false, passive: true };
}

/** What a server tells us is in a directory. */
export interface RemoteEntry {
  name: string;
  /** a directory can be entered; "link" is shown but not followed, since FTP will not say where it goes */
  type: "file" | "dir" | "link";
  /** bytes, when the listing gave a size */
  size?: number;
  /** modification time in ms, when the listing gave one */
  modified?: number;
}

/** A directory as the server sees it: where we ended up, and what is there. */
export interface RemoteListing {
  /** the server's own idea of the path, from PWD — not necessarily what we asked for */
  path: string;
  entries: RemoteEntry[];
  /** set when the server would not describe the entries, only name them (NLST) */
  namesOnly?: boolean;
}

/** Why a profile cannot be used yet, or null when it can. */
export function profileProblem(p: RemoteProfile): string | null {
  if (!p.host.trim()) return "Type the server's address.";
  if (!/^[\w.\-]+$/.test(p.host.trim())) return `“${p.host.trim()}” is not a host name or an address.`;
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return "The port is a number from 1 to 65535.";
  if (!p.user.trim()) return `Type a user name — “${ANONYMOUS}” if the board takes anonymous logins.`;
  return null;
}

/** "bbs.example.org/art" — a profile in one line, for a list or a status message. */
export function profileSummary(p: RemoteProfile): string {
  const host = p.port === FTP_PORT ? p.host : `${p.host}:${p.port}`;
  return `${p.secure ? "ftps" : "ftp"}://${p.user ? `${p.user}@` : ""}${host}${absolute(p.dir)}`;
}

/** A path the server will understand: leading slash, no trailing one, "/" for the root. */
export function absolute(path: string): string {
  const parts = normalizeParts(path);
  return parts.length ? `/${parts.join("/")}` : "/";
}

/**
 * The parts of a path, with "." dropped and ".." applied, so a typed path with
 * a stray "../" in it still names one place. Names are not otherwise touched:
 * an FTP server may well have a file with a backslash or a space in it.
 */
function normalizeParts(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** Walk into `name` from `dir`. */
export function childPath(dir: string, name: string): string {
  return absolute(`${dir}/${name}`);
}

/** The directory above, or the same path when already at the root. */
export function parentPath(dir: string): string {
  const parts = normalizeParts(dir);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

/** Each directory on the way to `dir`, root first, for a clickable trail. */
export function pathTrail(dir: string): { name: string; path: string }[] {
  const parts = normalizeParts(dir);
  return [{ name: "/", path: "/" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

/**
 * A file name a server will keep as typed.
 *
 * Boards are old software on old file systems: a name with a slash in it names
 * a different directory, one with a control character or a quote in it confuses
 * the protocol itself, and a leading dash reads as a flag to some `ls`. So
 * those go, spaces become underscores, and the rest is left alone — an artist's
 * file names are their own business.
 */
export function safeRemoteName(name: string, fallback = "art"): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "").replace(/\s+/g, "_").replace(/^-+/, "").trim();
  return cleaned || fallback;
}

/** Is a name already taken in this listing? Case-insensitive: DOS and Windows boards do not care either. */
export function findEntry(listing: RemoteListing, name: string): RemoteEntry | undefined {
  const want = name.toLowerCase();
  return listing.entries.find((e) => e.name.toLowerCase() === want);
}

/** "4.2 KB", "812 bytes" — a size for a listing. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Directories first, then files, each by name — how every file list is read. */
export function sortEntries(entries: readonly RemoteEntry[]): RemoteEntry[] {
  const rank = (e: RemoteEntry): number => (e.type === "dir" ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
