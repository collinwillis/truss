/**
 * Put text on the clipboard, from a user gesture or from a native menu.
 *
 * `navigator.clipboard.writeText` requires transient user activation in
 * WebKit, and a Tauri menu action runs AFTER an IPC round-trip, by which
 * point the activation from the right-click is gone. ⌘C is a real keydown and
 * is fine; the menu items are not, so they need the older synchronous path as
 * a fallback rather than an error toast where a copy should have happened.
 */
export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to the gesture-free path.
  }
  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen rather than hidden: a display:none element cannot be selected.
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("copy command rejected");
  } finally {
    area.remove();
  }
}
