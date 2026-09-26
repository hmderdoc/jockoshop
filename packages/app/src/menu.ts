/** The native menu bar of the desktop shell. Everything here also has a button or a shortcut in the app. */
export interface MenuActions {
  newDocument(): void; open(): void; importLayer(): void; save(): void; saveAs(): void; joint(): void;
  exportAns(): void; exportPng(): void; exportWiggle(): void; export3d(): void; exportMore(): void;
  undo(): void; redo(): void;
  selectAll(): void; selectNone(): void; selectInverse(): void;
  copy(): void; cut(): void; paste(): void; deleteSel(): void;
  zoomIn(): void; zoomOut(): void; zoomFit(): void; canvasSize(): void; sauce(): void; mirror(): void;
  shortcuts(): void;
}

export async function buildMenu(a: MenuActions): Promise<void> {
  const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const item = (text: string, action: () => void, accelerator?: string) => MenuItem.new({ text, action, accelerator });
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  const app = await Submenu.new({ text: "jockoshop", items: [
    await PredefinedMenuItem.new({ item: { About: { name: "jockoshop" } } }), await sep(),
    await PredefinedMenuItem.new({ item: "Hide" }), await PredefinedMenuItem.new({ item: "HideOthers" }), await sep(),
    await PredefinedMenuItem.new({ item: "Quit" }),
  ] });
  const file = await Submenu.new({ text: "File", items: [
    await item("New", a.newDocument, "CmdOrCtrl+N"),
    await item("Open…", a.open, "CmdOrCtrl+O"),
    await item("Import as Layer…", a.importLayer, "CmdOrCtrl+Shift+O"), await sep(),
    await item("Save", a.save, "CmdOrCtrl+S"),
    await item("Save As…", a.saveAs, "CmdOrCtrl+Shift+S"), await sep(),
    await item("Joint…", a.joint, "CmdOrCtrl+J"), await sep(),
    await item("Export .ans…", a.exportAns),
    await item("Export .png…", a.exportPng),
    await item("Export 3D wiggle .png (animated)…", a.exportWiggle),
    await item("Export for 3dBBS…", a.export3d),
    await item("Export As…", a.exportMore, "CmdOrCtrl+Shift+E"), await sep(),
    await PredefinedMenuItem.new({ item: "CloseWindow" }),
  ] });
  const edit = await Submenu.new({ text: "Edit", items: [
    await item("Undo", a.undo, "CmdOrCtrl+Z"),
    await item("Redo", a.redo, "CmdOrCtrl+Shift+Z"), await sep(),
    await item("Cut", a.cut, "CmdOrCtrl+X"),
    await item("Copy", a.copy, "CmdOrCtrl+C"),
    await item("Paste as Layer", a.paste, "CmdOrCtrl+V"),
    await item("Delete Selection", a.deleteSel), await sep(),
    await item("Select All", a.selectAll, "CmdOrCtrl+A"),
    await item("Deselect", a.selectNone, "Escape"),
    await item("Invert Selection", a.selectInverse, "CmdOrCtrl+Shift+I"),
  ] });
  const view = await Submenu.new({ text: "View", items: [
    await item("Zoom In", a.zoomIn, "CmdOrCtrl+="),
    await item("Zoom Out", a.zoomOut, "CmdOrCtrl+-"),
    await item("Zoom to Fit", a.zoomFit, "CmdOrCtrl+0"), await sep(),
    await item("Canvas Size…", a.canvasSize, "CmdOrCtrl+Alt+C"),
    await item("SAUCE…", a.sauce, "CmdOrCtrl+I"),
    await item("Mirror Mode", a.mirror, "CmdOrCtrl+Alt+M"), await sep(),
    await item("Keyboard Shortcuts", a.shortcuts),
  ] });
  const menu = await Menu.new({ items: [app, file, edit, view] });
  await menu.setAsAppMenu();
}
