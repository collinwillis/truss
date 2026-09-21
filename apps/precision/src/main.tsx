import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@truss/auth/react";
import { tauriAuthClient } from "./lib/auth-client";
import App from "./App";
import "./styles.css";

import { platform } from "@tauri-apps/plugin-os";
import { isTauri } from "@truss/lib/platform";

/**
 * Expose the host OS to CSS before the first render.
 *
 * WHY: `platform()` reads a value the os plugin's init script wrote before the
 * document was parsed — no IPC, no await — so the attribute exists before any
 * component paints and the app never flashes at another platform's size. The
 * stylesheet keys `@custom-variant windows` and the Windows token block on it.
 * On macOS the value is "macos", which no rule in the repo matches, so the
 * Apple HIG scale is untouched by construction rather than by care.
 *
 * This is the shape VS Code (a platform class on <html>) and Yaak (this exact
 * attribute) use. Guarded so the bundle stays loadable in a plain browser,
 * where the plugin global does not exist and platform() would throw.
 */
if (isTauri()) {
  document.documentElement.dataset.platform = platform();
}

/**
 * Disable Backspace-as-back-navigation in the Tauri webview.
 *
 * WHY: WebKit webviews treat Backspace as "navigate back." This fires even
 * inside type="number" inputs (empty value, full selection). A desktop app
 * should never navigate on Backspace, so we block it globally and let the
 * input's built-in editing behavior handle the keystroke via the DOM.
 */
window.addEventListener("popstate", () => {
  window.history.pushState(null, "", window.location.href);
});
window.history.pushState(null, "", window.location.href);

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string, {
  expectAuth: true,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConvexBetterAuthProvider client={convex} authClient={tauriAuthClient}>
      <App />
    </ConvexBetterAuthProvider>
  </React.StrictMode>
);
