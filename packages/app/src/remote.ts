/**
 * Talking to a remote place, and remembering the ones you use.
 *
 * FTP needs a raw socket, which a browser is not allowed to open — no shim,
 * no proxy, no flag: the page cannot speak the protocol. So the transport is
 * an interface with two implementations: the desktop shell, which calls into
 * Rust, and a browser one that only explains why it cannot. The cloud dialog
 * is the same either way.
 *
 * A second kind of remote later — SFTP, a WebDAV PUT, a board's own HTTP
 * upload — is another `RemoteTransport`, not another dialog.
 */
import {
  type RemoteEntry, type RemoteListing, type RemoteProfile, newProfile, sortEntries,
} from "@killerdraw/core";

/** What the server said when we knocked. */
export interface RemoteProbe {
  /** the board's greeting — the point is seeing you reached the right board */
  welcome: string;
  path: string;
  secure: boolean;
  /** the server advertises AUTH TLS, so an unencrypted connection is a choice */
  offersTls: boolean;
}

export interface UploadResult {
  /** bytes written, or undefined when nothing was sent because the name was taken */
  bytes?: number;
  existed: boolean;
}

export interface RemoteTransport {
  /** false in a browser; `why` says so in a sentence */
  readonly available: boolean;
  readonly why?: string;
  probe(profile: RemoteProfile, password: string): Promise<RemoteProbe>;
  list(profile: RemoteProfile, password: string, path: string): Promise<RemoteListing>;
  upload(profile: RemoteProfile, password: string, path: string, name: string, bytes: Uint8Array, overwrite: boolean): Promise<UploadResult>;
}

/** The fields the transport needs; the name and any remembered password stay here. */
const wire = (p: RemoteProfile): Record<string, unknown> =>
  ({ host: p.host.trim(), port: p.port, user: p.user.trim(), secure: p.secure, passive: p.passive });

const NO_SOCKETS = "A browser cannot open an FTP connection — the protocol needs a raw socket, which no page is allowed. Uploading to a board works in the jockoshop desktop app.";

const unavailable: RemoteTransport = {
  available: false,
  why: NO_SOCKETS,
  async probe() { throw new Error(NO_SOCKETS); },
  async list() { throw new Error(NO_SOCKETS); },
  async upload() { throw new Error(NO_SOCKETS); },
};

async function tauriTransport(): Promise<RemoteTransport> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    available: true,
    probe: (profile, password) => invoke<RemoteProbe>("remote_probe", { profile: wire(profile), password }),
    async list(profile, password, path) {
      const listing = await invoke<RemoteListing>("remote_list", { profile: wire(profile), password, path });
      return { ...listing, entries: sortEntries(listing.entries) };
    },
    async upload(profile, password, path, name, bytes, overwrite) {
      const out = await invoke<{ bytes?: number | null; existed: boolean }>("remote_upload",
        { profile: wire(profile), password, path, name, data: Array.from(bytes), overwrite });
      // `bytes` absent means nothing was sent; a null from the other side would
      // pass an `=== undefined` check and read as a successful upload of nothing
      return { existed: out.existed, ...(out.bytes == null ? {} : { bytes: out.bytes }) };
    },
  };
}

export async function remoteTransport(): Promise<RemoteTransport> {
  return "__TAURI_INTERNALS__" in window ? tauriTransport() : unavailable;
}

// --- saved connections

const KEY = "jockoshop.remotes";

interface Saved {
  profiles: RemoteProfile[];
  /** id of the one the dialog opens on */
  last?: string;
}

/**
 * The saved connections.
 *
 * A password is only in here when the user ticked the box, and then it is in
 * the clear — localStorage has no lock on it. That is said plainly in the
 * dialog rather than implied, because the honest fix is the OS keychain and
 * this is not it.
 */
export function loadRemotes(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
      .filter((p): p is RemoteProfile => !!p && typeof p.id === "string" && typeof p.host === "string")
      .map((p) => ({ ...newProfile(), ...p }));
    return { profiles, last: raw.last };
  } catch { return { profiles: [] } }
}

export function saveRemotes(s: Saved): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/** Store `p`, replacing the one with its id, and mark it as the one last used. */
export function rememberProfile(p: RemoteProfile, keepPassword: boolean): void {
  const { profiles } = loadRemotes();
  const stored: RemoteProfile = keepPassword ? p : { ...p, password: undefined };
  const at = profiles.findIndex((q) => q.id === p.id);
  if (at < 0) profiles.push(stored); else profiles[at] = stored;
  saveRemotes({ profiles, last: p.id });
}

export function forgetProfile(id: string): void {
  const { profiles, last } = loadRemotes();
  saveRemotes({ profiles: profiles.filter((p) => p.id !== id), last: last === id ? undefined : last });
}

/** A listing entry that can be opened. Links are shown but not followed: FTP will not say where they go. */
export const isNavigable = (e: RemoteEntry): boolean => e.type === "dir";
