/**
 * The joint's two pieces of UI: the connect dialog, and the floating panel with
 * the users list and the chat (Moebius keeps its own in a small window over the
 * canvas, so this one floats too, and remembers where it was put).
 */
import type { JointStatus } from "@killerdraw/core";
import { modal } from "./dialogs.js";
import type { Editor } from "./editor.js";
import { JOINT_STATUS_NAMES, type JointClient, cursorColor, normalizeJointUrl } from "./joint.js";
import { field, h } from "./ui.js";

const PREFS_KEY = "jockoshop.joint";

interface Prefs {
  url: string;
  nick: string;
  group: string;
  /** servers typed before, most recent first */
  servers: string[];
  pos: { x: number; y: number } | null;
}

const DEFAULTS: Prefs = { url: "", nick: "", group: "", servers: [], pos: null };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return { ...DEFAULTS, ...raw, servers: Array.isArray(raw.servers) ? raw.servers.slice(0, 8) : [] };
  } catch { return { ...DEFAULTS } }
}

function savePrefs(patch: Partial<Prefs>): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* private mode */ }
}

/** Connect to a joint. `onJoined` is called once the server has answered. */
export function jointDialog(client: JointClient, onJoined: () => void): void {
  const prefs = loadPrefs();
  const url = h("input", { type: "text", value: prefs.url, placeholder: "server:8000/piece.ans", style: "width:100%", spellcheck: false });
  const nick = h("input", { type: "text", value: prefs.nick, maxLength: 32, style: "width:160px" });
  const group = h("input", { type: "text", value: prefs.group, maxLength: 32, style: "width:160px" });
  const pass = h("input", { type: "password", value: "", style: "width:160px" });
  const status = h("p.hint");
  const saved = h("div.row.wrap");
  const renderSaved = (): void => {
    const list = loadPrefs().servers;
    saved.replaceChildren(...(list.length
      ? [h("span.muted", {}, "saved:"), ...list.map((s) => h("button", { title: s, onclick: () => { url.value = s; url.focus(); } }, s.replace(/^wss?:\/\//, "")))]
      : []));
  };
  renderSaved();

  const buttons: HTMLButtonElement[] = [];
  const go = async (mode: "open" | "push"): Promise<void> => {
    const target = normalizeJointUrl(url.value);
    if (!target) { status.textContent = "Type a server, e.g. ansi.example.org:8000/piece.ans"; return; }
    if (!nick.value.trim()) { status.textContent = "Pick a nick — the others see it in the chat and on your cursor."; return; }
    buttons.forEach((b) => { b.disabled = true; });
    status.textContent = `connecting to ${target}…`;
    try {
      await client.connect({ url: target, nick: nick.value, group: group.value, pass: pass.value, mode });
      savePrefs({ url: target, nick: nick.value.trim(), group: group.value.trim(), servers: [target, ...loadPrefs().servers.filter((s) => s !== target)].slice(0, 8) });
      backdrop.remove();
      onJoined();
    } catch (err) {
      status.textContent = (err as Error).message;
      buttons.forEach((b) => { b.disabled = false; });
      renderSaved();
    }
  };
  const button = (label: string, title: string, mode: "open" | "push", primary = false): HTMLButtonElement => {
    const b = h(primary ? "button.primary" : "button", { title, onclick: () => void go(mode) }, label);
    buttons.push(b);
    return b;
  };
  const cancel = h("button", { onclick: () => backdrop.remove() }, "Cancel");
  const backdrop = modal("Join a joint", [
    h("p.hint", {}, "A Moebius collaboration server: one flat 16-colour canvas, edited a cell at a time by everyone in it. Other people's cells arrive in a layer of their own, “joint: others”, pinned on top."),
    field("server", url),
    saved,
    h("div.row", {}, field("nick", nick), field("group", group), field("password", pass)),
    h("p.hint", {}, "Open joint replaces what you have open with the joint's canvas. Push sends this document over the joint's — everything in the room is overwritten, for everyone."),
    status,
  ], [
    cancel,
    button("Push my document", "Overwrite the joint's canvas with this document — everyone in the room loses what is there", "push"),
    button("Open joint", "Open the joint's canvas as a new document", "open", true),
  ], 460);
  url.focus();
}

export interface JointPanel {
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
  toggle(): void;
  readonly visible: boolean;
}

/** The floating window: who is in the joint, what they say, and the way out. */
export function jointPanel(ed: Editor, client: JointClient): JointPanel {
  const users = h("div.joint-users");
  const log = h("div.joint-log");
  const say = h("input", { type: "text", placeholder: "say something…", spellcheck: false });
  const path = h("span.muted.grow");
  const head = h("div.joint-head", {}, h("strong", {}, "joint"), path,
    h("button", { title: "Leave the joint. The document stays as it is.", onclick: () => client.disconnect() }, "leave"),
    h("button", { title: "Hide this panel (the “joint” button in the top bar brings it back)", onclick: () => hide() }, "×"));
  const root = h("div.joint-panel", { hidden: true }, head, users, log,
    h("div.joint-say", {}, say, h("button", { onclick: () => send() }, "send")));

  const send = (): void => {
    client.chat(say.value);
    say.value = "";
  };
  say.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); }
    else if (e.key === "Escape") say.blur();
    e.stopPropagation();   // the canvas shortcuts must not fire while typing here
  });

  const dot = (status: JointStatus): HTMLElement =>
    h("span.joint-dot", { class: `s${status}`, title: JOINT_STATUS_NAMES[status] });

  const renderUsers = (): void => {
    const others = client.users;
    path.textContent = client.connected ? `${client.path} · ${others.length + 1}` : client.connecting ? "connecting…" : "not connected";
    users.replaceChildren(
      h("div.joint-user", {}, dot(client.myStatus), h("span.chip", { style: "background:transparent" }), h("span.grow", {}, `${client.nick} (you)`), h("span.muted", {}, client.group)),
      ...others.map((u) => h("div.joint-user", {}, dot(u.status),
        h("span.chip", { style: `background:${cursorColor(u.id)}`, title: "their cursor's colour on the canvas" }),
        h("span.grow", {}, u.nick ?? `user ${u.id}`), h("span.muted", {}, u.group ?? ""))),
    );
  };
  const renderLog = (): void => {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.replaceChildren(...client.lines.map((l) => l.kind === "note"
      ? h("div.joint-line.note", {}, l.text)
      : h("div.joint-line", {}, h("b", { style: l.id === client.id ? "" : `color:${cursorColor(l.id ?? 0)}` }, `${l.nick ?? "?"}: `), l.text)));
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  let shown = false;
  const show = (): void => { shown = true; root.hidden = false; renderUsers(); renderLog(); log.scrollTop = log.scrollHeight; };
  const hide = (): void => { shown = false; root.hidden = true; };

  // shown on joining (from wherever: the dialog, the menu, a test), hidden again when the joint ends —
  // but only on the change itself, so a panel the user closed stays closed while cells fly about
  let was = false;
  client.onChange((what) => {
    if (what === "users" || what === "state") renderUsers();
    if (what === "chat") renderLog();
    if (client.connected !== was) { was = client.connected; if (was) show(); else hide(); }
    ed.emit("ui");   // the topbar button and the status bar follow the connection
  });

  // dragged by its title bar; where it was put is remembered
  const pos = loadPrefs().pos;
  if (pos) { root.style.left = `${pos.x}px`; root.style.top = `${pos.y}px`; root.style.right = "auto"; root.style.bottom = "auto"; }
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    const box = root.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    head.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent): void => {
      const x = Math.max(0, Math.min(window.innerWidth - box.width, m.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - box.height, m.clientY - dy));
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    };
    const up = (): void => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      savePrefs({ pos: { x: parseInt(root.style.left, 10) || 0, y: parseInt(root.style.top, 10) || 0 } });
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });

  document.body.append(root);
  return { root, show, hide, toggle: () => (shown ? hide() : show()), get visible() { return shown } };
}
