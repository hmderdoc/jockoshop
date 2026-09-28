/**
 * Send the piece to a board.
 *
 * One dialog, three things in it: which connection, where on it, and what to
 * send. The listing is there so you can see the directory you are aiming at and
 * whether the name is taken — not to be a file manager. Synchronet's own FTP
 * server marks DELE, RNFR and RNTO unimplemented and offers no MKD, so there
 * would be nothing to delete or rename with anyway.
 *
 * What gets sent is built by the same code Export As… saves with, so a file
 * uploaded here is byte-for-byte the file you would have saved and uploaded by
 * hand.
 *
 * The inputs are built once and only their values are written back. Rebuilding
 * them on every change replaces whatever is focused, which loses keystrokes —
 * the same trap the canvas height field fell into.
 */
import {
  type RemoteEntry, type RemoteListing, type RemoteProfile,
  absolute, childPath, fileSize, findEntry, newProfile, parentPath, pathTrail, profileProblem, profileSummary, safeRemoteName,
} from "@killerdraw/core";
import { type ExportChoices, type ExportFormat, defaultChoices, modal } from "./dialogs.js";
import type { Editor } from "./editor.js";
import { type RemoteTransport, forgetProfile, loadRemotes, rememberProfile } from "./remote.js";
import { field, h } from "./ui.js";

/** "12 Jan 14:03" — enough to tell one upload from another. */
function when(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getDate()} ${d.toLocaleString(undefined, { month: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function cloudDialog(ed: Editor, transport: RemoteTransport, formats: ExportFormat[], baseName: () => string): void {
  const stored = loadRemotes();
  let profile: RemoteProfile = stored.profiles.find((p) => p.id === stored.last) ?? stored.profiles[0] ?? newProfile();
  let keepPassword = !!profile.password;
  /** null until a directory has actually been listed — an upload needs one we have seen */
  let listing: RemoteListing | null = null;
  let dir = absolute(profile.dir);
  let busy = false;
  let format = formats[0];
  /** the name the server would not overwrite, so the next click means "yes, replace" */
  let pendingReplace: string | null = null;
  const choices: ExportChoices = defaultChoices(ed);

  const close = (): void => backdrop.remove();

  // --- the controls, made once

  const name = h("input", { type: "text", placeholder: "my board", spellcheck: false, style: "width:100%" });
  const host = h("input", { type: "text", placeholder: "bbs.example.org", spellcheck: false, style: "width:100%" });
  const port = h("input", { type: "number", min: 1, max: 65535, style: "width:76px" });
  const user = h("input", { type: "text", placeholder: "anonymous", spellcheck: false, style: "width:100%" });
  const pass = h("input", { type: "password", style: "width:100%" });
  const dirBox = h("input.remote-dir", { type: "text", placeholder: "/art", spellcheck: false, style: "width:100%" });
  const fileBox = h("input.remote-name", { type: "text", spellcheck: false, style: "width:100%", title: "The name it lands under. Left as suggested, it follows the document and the format." });
  const status = h("p.hint.remote-status");
  const trail = h("div.row.wrap.trail");
  const box = h("div.remote-list");
  const plainWarning = h("p.hint.warn", { hidden: true }, "The password is stored in the clear on this computer — anything that can read the app's storage can read it.");

  const check = (label: string, title: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const input = h("input", { type: "checkbox", onchange: () => { set(input.checked); sync(); } });
    boxes.push(() => { input.checked = get(); input.disabled = busy; });
    return h("label.check", { title }, input, label);
  };
  const boxes: (() => void)[] = [];

  const secure = check("encrypt (FTPS)", "AUTH TLS before logging in, so the password does not cross the internet in the clear. Synchronet offers this; some boards have it switched off.",
    () => profile.secure, (v) => { profile = { ...profile, secure: v }; });
  const passive = check("passive", "The client opens the data connection. What works from behind a router, and what every board expects.",
    () => profile.passive, (v) => { profile = { ...profile, passive: v }; });
  const remember = check("remember the password", "Kept in this browser's local storage, in the clear. Leave it off to type it each time.",
    () => keepPassword, (v) => { keepPassword = v; });

  const formatPick = h("select", {
    title: "The file this sends — the same bytes Export As… would save",
    onchange: () => {
      format = formats.find((f) => f.ext === formatPick.value) ?? formats[0];
      pendingReplace = null;
      // the suggested name carries the extension, so it follows the format
      if (!fileBox.value || fileBox.value === suggestedFor(lastFormat)) fileBox.value = suggestedFor(format);
      lastFormat = format;
      sync();
    },
  }, ...formats.map((f) => h("option", { value: f.ext }, `${f.ext} — ${f.label}`)));
  let lastFormat = format;

  const formatNote = h("p.hint");
  const unavailable = h("p.hint.warn", { hidden: transport.available }, transport.why ?? "");

  const connections = h("select", { title: "Saved connections", onchange: () => switchTo(connections.value) });
  const forgetBtn = h("button", { onclick: () => { forgetProfile(profile.id); say(`Forgot “${profile.name}”.`); renderConnections(); sync(); } }, "Forget");
  const newBtn = h("button", {
    title: "Start another connection", onclick: () => {
      profile = newProfile(`board ${loadRemotes().profiles.length + 1}`);
      keepPassword = false; listing = null; dir = "/"; pendingReplace = null;
      writeFields();
      say("A new connection — fill in the address and log in.");
      renderConnections(); sync();
    },
  }, "New");
  const listBtn = h("button", { onclick: () => go(absolute(dirBox.value)) }, "List");
  const testBtn = h("button", { title: "Log in and report what the board says, without sending anything", onclick: test }, "Test");
  const sendBtn = h("button.primary", { onclick: () => send(pendingReplace === uploadName()) }, "Upload");

  // --- state in and out of the controls

  const suggestedFor = (f: ExportFormat): string => safeRemoteName(`${baseName()}${f.ext}`);
  const uploadName = (): string => safeRemoteName(fileBox.value || suggestedFor(format));

  /** Read the typed fields back into the profile. */
  const collect = (): void => {
    profile = {
      ...profile, name: name.value.trim(), host: host.value.trim(), user: user.value.trim(),
      port: Number(port.value) || 0, dir: absolute(dirBox.value),
    };
  };

  /** Write the profile into the fields — only when it was swapped wholesale. */
  const writeFields = (): void => {
    name.value = profile.name;
    host.value = profile.host;
    port.value = String(profile.port);
    user.value = profile.user;
    pass.value = profile.password ?? "";
    dirBox.value = absolute(profile.dir);
    fileBox.value = suggestedFor(format);
  };

  const say = (text: string, bad = false): void => {
    status.textContent = text;
    status.classList.toggle("warn", bad);
  };

  const switchTo = (id: string): void => {
    const found = loadRemotes().profiles.find((p) => p.id === id);
    if (!found) return;
    profile = found;
    keepPassword = !!found.password;
    dir = absolute(found.dir);
    listing = null;
    pendingReplace = null;
    writeFields();
    say(`${profileSummary(found)} — press List to see it.`);
    sync();
  };

  const renderConnections = (): void => {
    const list = loadRemotes().profiles;
    connections.replaceChildren(
      ...(list.some((p) => p.id === profile.id) ? [] : [h("option", { value: profile.id }, profile.name || "not saved yet")]),
      ...list.map((p) => h("option", { value: p.id }, p.name || p.host || "unnamed")));
    connections.value = profile.id;
    forgetBtn.disabled = !list.some((p) => p.id === profile.id);
    forgetBtn.title = forgetBtn.disabled ? "This connection is not saved yet" : `Forget “${profile.name}”`;
  };

  /** Everything that follows from the current state; safe to call at any time. */
  const sync = (): void => {
    collect();
    const problem = profileProblem(profile);
    const canTalk = transport.available && !problem && !busy;
    for (const f of boxes) f();
    for (const el of [name, host, port, user, pass, dirBox, fileBox, formatPick]) el.disabled = busy;
    listBtn.disabled = !canTalk;
    listBtn.title = canTalk ? `List ${absolute(dirBox.value)}` : problem ?? "";
    testBtn.disabled = !canTalk;
    plainWarning.hidden = !keepPassword;
    formatNote.textContent = format.note;
    fileBox.placeholder = suggestedFor(format);

    const taken = !!listing && !!findEntry(listing, uploadName());
    const replacing = taken || pendingReplace === uploadName();
    sendBtn.disabled = !transport.available || busy || !!problem || !listing;
    sendBtn.textContent = replacing ? "Replace" : "Upload";
    sendBtn.title = !transport.available ? (transport.why ?? "")
      : problem ? problem
      : !listing ? "Press List first, so the upload goes to a directory we have seen"
      : replacing ? `Overwrite ${uploadName()} in ${dir}` : `Send ${uploadName()} to ${dir}`;

    renderTrail();
    renderListing();
  };

  const renderTrail = (): void => {
    if (!listing) { trail.replaceChildren(); return; }
    trail.replaceChildren(h("span.muted", {}, "in"),
      ...pathTrail(dir).map((step) => h("button", {
        title: `Open ${step.path}`, disabled: busy || step.path === dir, onclick: () => go(step.path),
      }, step.name)));
  };

  const entryRow = (e: RemoteEntry, isTarget: boolean): HTMLElement => {
    const parts = [
      h("span.rn", {}, e.type === "dir" ? `${e.name}/` : e.name),
      h("span.muted", {}, e.size === undefined ? (e.type === "link" ? "link" : "") : fileSize(e.size)),
      h("span.muted", {}, when(e.modified)),
      isTarget && h("span.warn", {}, "← this upload replaces it"),
    ].filter((n): n is HTMLElement => !!n);
    // only a directory can be opened; FTP will not say where a link points
    return e.type === "dir"
      ? h("button.remote-row", { title: `Open ${childPath(dir, e.name)}`, disabled: busy, onclick: () => go(childPath(dir, e.name)) }, ...parts)
      : h("div.remote-row.plain", { title: e.name }, ...parts);
  };

  const renderListing = (): void => {
    if (!listing) {
      box.replaceChildren(h("p.hint", {}, transport.available
        ? "Press List to see what is in the directory above."
        : "A listing needs a connection, which this build cannot open."));
      return;
    }
    const target = uploadName().toLowerCase();
    const rows: HTMLElement[] = [];
    if (dir !== "/") {
      rows.push(h("button.remote-row.up", { title: `Up to ${parentPath(dir)}`, disabled: busy, onclick: () => go(parentPath(dir)) },
        h("span.rn", {}, "../"), h("span.muted", {}, "up")));
    }
    for (const e of listing.entries) rows.push(entryRow(e, e.name.toLowerCase() === target));
    if (!listing.entries.length) rows.push(h("p.hint", {}, "Nothing in here."));
    box.replaceChildren(...rows);
  };

  // --- the three things it does

  /** Run remote work with the dialog locked, so two clicks cannot race. */
  const work = (what: string, job: () => Promise<string>): void => {
    if (busy) return;
    collect();
    busy = true;
    say(what);
    sync();
    void (async () => {
      try { say(await job()); }
      catch (err) { say((err as Error).message, true); }
      finally { busy = false; sync(); }
    })();
  };

  const go = (to: string): void => work(`Opening ${to}…`, async () => {
    const got = await transport.list(profile, pass.value, to);
    listing = got;
    dir = got.path;
    dirBox.value = got.path;
    const n = got.entries.length;
    return `${got.path} — ${n === 0 ? "empty" : `${n} ${n === 1 ? "entry" : "entries"}`}${got.namesOnly ? " (the server gave only names, no sizes)" : ""}`;
  });

  function test(): void {
    work("Connecting…", async () => {
      const probe = await transport.probe(profile, pass.value);
      const greeting = probe.welcome.split("\n").map((l) => l.trim()).find(Boolean);
      const nudge = probe.offersTls && !profile.secure
        ? " This board offers encryption — tick “encrypt (FTPS)” so the password does not cross in the clear."
        : "";
      return `Logged in as ${profile.user}${probe.secure ? ", encrypted" : ""}, in ${probe.path}.${greeting ? ` Board says: “${greeting}”` : ""}${nudge}`;
    });
  }

  const send = (overwrite: boolean): void => work(`Sending ${uploadName()}…`, async () => {
    const target = uploadName();
    const bytes = format.build(choices);
    const result = await transport.upload(profile, pass.value, dir, target, bytes, overwrite);
    if (result.bytes === undefined) {
      pendingReplace = target;
      return `“${target}” is already in ${dir}. Press Replace to overwrite it.`;
    }
    pendingReplace = null;
    rememberProfile({ ...profile, dir, password: keepPassword ? pass.value : undefined }, keepPassword);
    renderConnections();
    // list again so the file is visibly there, and a second upload knows the name is taken
    try { listing = await transport.list(profile, pass.value, dir); } catch { /* the upload is what mattered */ }
    return `Sent ${target} — ${fileSize(result.bytes)} to ${dir}${result.existed ? ", replacing what was there" : ""}.`;
  });

  // --- put it together

  writeFields();
  renderConnections();
  formatPick.value = format.ext;
  say(transport.available
    ? profile.host ? `${profileSummary(profile)} — press List to see it.` : "Fill in the board's address and log in."
    : "");
  const commit = { onchange: () => sync(), oninput: () => sync() };
  for (const el of [name, host, port, user, dirBox, fileBox]) {
    el.addEventListener("input", commit.oninput);
    el.addEventListener("change", commit.onchange);
  }
  sync();

  const backdrop = modal("Upload to a board", [
    unavailable,
    h("div.row", {}, h("span.muted", {}, "connection"), connections, newBtn, forgetBtn),
    h("div.row", {}, field("name", name), field("server", host), field("port", port)),
    h("div.row", {}, field("user", user), field("password", pass)),
    h("div.row.wrap", {}, secure, passive, remember),
    plainWarning,
    h("div.row", {}, field("directory", dirBox), listBtn, testBtn),
    trail,
    box,
    h("div.row", {}, field("send as", formatPick), field("file name", fileBox)),
    formatNote,
    status,
  ], [h("button", { onclick: close }, "Close"), sendBtn], 660);
}
