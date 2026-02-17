import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { tauriAuthClient } from "./lib/auth-client";
import App from "./App";
import "./styles.css";

/**
 * Disable Backspace-as-back-navigation in the Tauri webview.
 *
 * WHY: WebKit webviews treat Backspace as "navigate back." This fires even
 * inside type="number" inputs (empty value, full selection). A desktop app
 * should never navigate on Backspace, so we block it globally and let the
 * input's built-in editing behavior handle the keystroke via the DOM.
 */
window.addEventListener("popstate", () => {
  // If the webview tries to navigate back, push the current URL back
  window.history.pushState(null, "", window.location.href);
});
// Seed the history so popstate has something to catch
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
