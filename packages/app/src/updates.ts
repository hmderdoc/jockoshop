/**
 * Updates (desktop only). The shell's updater plugin reads latest.json from the
 * update-feed branch, which the release workflow writes, and checks the
 * download against the public key in tauri.conf.json before installing it.
 *
 * Nothing is installed over unsaved work: on Windows the installer closes the
 * app, and everywhere the restart would close every window. Install waits until
 * every window is saved, and the restart checks again.
 */
import type { Editor } from "./editor.js";
import { modal } from "./dialogs.js";
import { h } from "./ui.js";

/** Look for a newer version. `quiet`: say nothing unless there is one (the check at launch). */
export async function checkForUpdate(ed: Editor, quiet: boolean): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  let update: Awaited<ReturnType<typeof check>>;
  try { update = await check(); }
  catch (err) {
    console.error("update check:", err);
    if (!quiet) ed.setStatus(`Could not check for updates: ${(err as Error).message ?? err}`);
    return;
  }
  if (!update) { if (!quiet) ed.setStatus("jockoshop is up to date."); return; }
  const found = update;

  const { invoke } = await import("@tauri-apps/api/core");
  const note = h("p.hint", {}, "");
  const later = h("button", { title: "Ask again next time jockoshop starts", onclick: () => backdrop.remove() }, "Later");
  const install: HTMLButtonElement = h("button.primary", {
    title: "Download it, check its signature, install it and restart",
    onclick: async () => {
      if (await invoke<number>("unsaved_windows")) {
        note.textContent = "Save the documents with unsaved changes first (or close them) — installing restarts jockoshop and closes every window.";
        return;
      }
      install.disabled = later.disabled = true;
      let total = 0, got = 0;
      try {
        await found.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength ?? 0;
          else if (e.event === "Progress") {
            got += e.data.chunkLength;
            note.textContent = total ? `Downloading… ${Math.round(got / total * 100)}%` : `Downloading… ${(got / 1e6).toFixed(1)} MB`;
          } else note.textContent = "Installing…";
        });
      } catch (err) {
        note.textContent = `The update failed: ${(err as Error).message ?? err}`;
        install.disabled = later.disabled = false;
        return;
      }
      // restarts and does not return, unless a window was edited meanwhile
      if (!(await invoke<boolean>("restart_if_saved"))) {
        note.textContent = `Installed. Version ${found.version} starts the next time you open jockoshop.`;
        later.disabled = false;
        later.textContent = "Close";
      }
    },
  }, "Install and restart");
  const backdrop = modal(`jockoshop ${found.version} is available`, [
    h("p", {}, `You have ${found.currentVersion}.`),
    ...(found.body?.trim() ? [h("p.hint", { style: "white-space:pre-wrap;max-height:200px;overflow:auto" }, found.body.trim())] : []),
    note,
  ], [later, install], 460);
}
