/**
 * File access, in the three places the app runs. In a browser a "save" is a
 * download and "open" is a file picker; in the desktop shell (Tauri) files have
 * paths, so save writes in place and the OS can hand us files to open; a
 * Chromium browser sits in between — the File System Access API gives us file
 * handles, so save writes in place there too, and as an installed PWA the OS
 * hands us files through the launch queue.
 */
import { download, pickFile } from "./ui.js";

export interface Picked {
  name: string;
  bytes: Uint8Array;
  /** full path, when the platform has one (a `handle:` key with the File System Access API) */
  path?: string;
}

export interface FileIO {
  /** the Tauri shell: native menu, window close events */
  readonly desktop: boolean;
  /** save writes back to the opened file rather than downloading a copy */
  readonly inPlace: boolean;
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
  inPlace: false,
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

// --- File System Access API (Chromium): handles instead of paths.
// Not in lib.dom, since only Chromium has it.
interface FSFileHandle extends FileSystemFileHandle {
  queryPermission(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}
interface PickerType { description: string; accept: Record<string, string[]> }
interface FSWindow {
  showOpenFilePicker(o: { multiple?: boolean; types?: PickerType[] }): Promise<FSFileHandle[]>;
  showSaveFilePicker(o: { suggestedName?: string; types?: PickerType[] }): Promise<FSFileHandle>;
  launchQueue?: { setConsumer(fn: (params: { files: FileSystemHandle[] }) => void): void };
}
const fsWindow = (): FSWindow | null => "showSaveFilePicker" in window && "showOpenFilePicker" in window ? window as unknown as FSWindow : null;

/** Write a whole file through a handle; false when the user does not let us. */
async function writeHandle(handle: FSFileHandle, bytes: Uint8Array): Promise<boolean> {
  if (await handle.queryPermission({ mode: "readwrite" }) !== "granted" && await handle.requestPermission({ mode: "readwrite" }) !== "granted") return false;
  const w = await handle.createWritable();
  await w.write(bytes as BufferSource);
  await w.close();
  return true;
}

const pickerTypes = (name: string, extensions: string[]): PickerType[] => [{ description: name, accept: { "application/octet-stream": extensions.map((e) => `.${e}`) } }];

/** The picker throws AbortError when the user cancels; anything else is a real error. */
const cancelled = (err: unknown): boolean => err instanceof DOMException && err.name === "AbortError";

function fsAccessIO(fs: FSWindow): FileIO {
  // A handle has no path, so the document's "path" is a key into this map. The
  // key ends in the file name so callers that take the base name of a path
  // keep working. Handles live for the session only.
  const handles = new Map<string, FSFileHandle>();
  let next = 1;
  const remember = (handle: FSFileHandle): string => {
    const key = `handle:${next++}/${handle.name}`;
    handles.set(key, handle);
    return key;
  };
  const picked = async (handle: FSFileHandle): Promise<Picked> => {
    const file = await handle.getFile();
    return { name: handle.name, path: remember(handle), bytes: new Uint8Array(await file.arrayBuffer()) };
  };
  const isFile = (h: FileSystemHandle): h is FSFileHandle => h.kind === "file";
  return {
    desktop: false,
    inPlace: true,
    async open(accept) {
      try {
        const [handle] = await fs.showOpenFilePicker({ types: pickerTypes("jockoshop / ANSI art", accept) });
        return handle ? picked(handle) : null;
      } catch (err) { if (cancelled(err)) return null; throw err; }
    },
    async save(path, bytes) {
      const handle = path ? handles.get(path) : undefined;
      return handle ? writeHandle(handle, bytes) : false;
    },
    async saveAs(suggested, bytes, kind) {
      let handle: FSFileHandle;
      try { handle = await fs.showSaveFilePicker({ suggestedName: suggested, types: pickerTypes(kind.name, kind.extensions) }); }
      catch (err) { if (cancelled(err)) return null; throw err; }
      if (!(await writeHandle(handle, bytes))) return null;
      return remember(handle);
    },
    async readPath(path) {
      const handle = handles.get(path);
      if (!handle) throw new Error(`no open file for ${path}`);
      return picked(handle);
    },
    onOpenRequest(fn) {
      // dropping a file on the page opens it — through its handle where the browser gives us one, so a dropped project can be saved back
      window.addEventListener("dragover", (e) => e.preventDefault());
      window.addEventListener("drop", async (e) => {
        e.preventDefault();
        // both getters must run before the event ends; the items are gone after the first await
        const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === "file").map((item) => ({
          handle: "getAsFileSystemHandle" in item ? (item as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle() : null,
          file: item.getAsFile(),
        }));
        const files = await Promise.all(items.map(async ({ handle, file }): Promise<Picked | null> => {
          const h = await handle;
          if (h && isFile(h)) return picked(h);
          return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
        }));
        const got = files.filter((f): f is Picked => f !== null);
        if (got.length) fn(got, { x: e.clientX, y: e.clientY });
      });
      // an installed PWA: files the OS opens with us (file_handlers in the manifest)
      fs.launchQueue?.setConsumer((params) => {
        void (async () => {
          const files = await Promise.all(params.files.filter(isFile).map(picked));
          if (files.length) fn(files);
        })();
      });
    },
    onCloseRequest() {
      window.addEventListener("beforeunload", (e) => { if (browserDirty) e.preventDefault(); });
    },
    setDirty(dirty) { browserDirty = dirty; },
    setTitle(title) { document.title = title; },
  };
}

async function tauriIO(): Promise<FileIO> {
  const [{ invoke }, { listen }, { open, save }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/core"), import("@tauri-apps/api/event"), import("@tauri-apps/plugin-dialog"), import("@tauri-apps/api/window"),
  ]);
  const baseName = (p: string): string => p.replace(/^.*[\\/]/, "");
  const readPath = async (path: string): Promise<Picked> => ({ name: baseName(path), path, bytes: new Uint8Array(await invoke<number[]>("read_file", { path })) });
  const io: FileIO = {
    desktop: true,
    inPlace: true,
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
  if ("__TAURI_INTERNALS__" in window) return tauriIO();
  const fs = fsWindow();
  return fs ? fsAccessIO(fs) : browserIO;
}
