/**
 * File access, in the two places the app runs. In a browser a "save" is a
 * download and "open" is a file picker; in the desktop shell (Tauri) files have
 * paths, so save writes in place and the OS can hand us files to open.
 */
import { download, pickFile } from "./ui.js";

export interface Picked {
  name: string;
  bytes: Uint8Array;
  /** full path, when the platform has one */
  path?: string;
}

export interface FileIO {
  readonly desktop: boolean;
  open(accept: string[]): Promise<Picked | null>;
  /** save to a known path; returns false when there is none */
  save(path: string | undefined, bytes: Uint8Array): Promise<boolean>;
  /** pick a destination; returns its path (undefined in a browser, where the file is downloaded) or null if cancelled */
  saveAs(suggested: string, bytes: Uint8Array, kind: { name: string; extensions: string[] }): Promise<string | null | undefined>;
  readPath(path: string): Promise<Picked>;
  /** files the OS asks the app to open (double-click, drag onto the window, command line); `at` = where they were dropped, in client pixels */
  onOpenRequest(fn: (files: Picked[], at?: { x: number; y: number }) => void): void;
  /** the OS wants the window closed while there are unsaved changes; `fn` decides */
  onCloseRequest(fn: () => Promise<boolean>): void;
  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
}

let browserDirty = false;

const browserIO: FileIO = {
  desktop: false,
  async open(accept) {
    const file = await pickFile(accept.map((e) => `.${e}`).join(","));
    return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  },
  async save() { return false; },
  async saveAs(suggested, bytes) { download(suggested, bytes); return undefined; },
  async readPath() { throw new Error("no file system in a browser"); },
  onOpenRequest(fn) {
    // dropping a file on the page opens it
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) fn(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), { x: e.clientX, y: e.clientY });
    });
  },
  onCloseRequest() {
    // a browser only lets us ask its own generic question
    window.addEventListener("beforeunload", (e) => { if (browserDirty) e.preventDefault(); });
  },
  setDirty(dirty) { browserDirty = dirty; },
  setTitle(title) { document.title = title; },
};

async function tauriIO(): Promise<FileIO> {
  const [{ invoke }, { listen }, { open, save }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/core"), import("@tauri-apps/api/event"), import("@tauri-apps/plugin-dialog"), import("@tauri-apps/api/window"),
  ]);
  const baseName = (p: string): string => p.replace(/^.*[\\/]/, "");
  const readPath = async (path: string): Promise<Picked> => ({ name: baseName(path), path, bytes: new Uint8Array(await invoke<number[]>("read_file", { path })) });
  const io: FileIO = {
    desktop: true,
    async open(accept) {
      const path = await open({ multiple: false, filters: [{ name: "jockoshop / ANSI art", extensions: accept }] });
      return typeof path === "string" ? readPath(path) : null;
    },
    async save(path, bytes) {
      if (!path) return false;
      await invoke("write_file", { path, data: Array.from(bytes) });
      return true;
    },
    async saveAs(suggested, bytes, kind) {
      const path = await save({ defaultPath: suggested, filters: [{ name: kind.name, extensions: kind.extensions }] });
      if (!path) return null;
      await invoke("write_file", { path, data: Array.from(bytes) });
      return path;
    },
    readPath,
    onOpenRequest(fn) {
      const drain = async (): Promise<void> => {
        const paths = await invoke<string[]>("take_pending_files");
        const files: Picked[] = [];
        for (const p of paths) {
          try { files.push(await readPath(p)); } catch (err) { console.error(err); }
        }
        if (files.length) fn(files);
      };
      void listen("open-files", drain);
      void getCurrentWindow().onDragDropEvent(async (e) => {
        if (e.payload.type !== "drop" || !e.payload.paths.length) return;
        // the position is in physical pixels of the window; the webview fills it
        const at = { x: e.payload.position.x / window.devicePixelRatio, y: e.payload.position.y / window.devicePixelRatio };
        fn(await Promise.all(e.payload.paths.map(readPath)), at);
      });
      void drain();   // anything that arrived before we were listening
    },
    onCloseRequest(fn) {
      void listen("close-requested", async () => { if (await fn()) await getCurrentWindow().destroy(); });
    },
    setDirty(dirty) { void invoke("set_dirty", { dirty }); },
    setTitle(title) { void getCurrentWindow().setTitle(title); },
  };
  return io;
}

export async function fileIO(): Promise<FileIO> {
  return "__TAURI_INTERNALS__" in window ? tauriIO() : browserIO;
}
