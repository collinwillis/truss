/**
 * Platform, browser, and environment detection utilities.
 */

/**
 * Check if running in browser.
 */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.document !== "undefined";
}

/**
 * Check if running in Node.js.
 */
export function isNode(): boolean {
  return (
    typeof process !== "undefined" && process.versions != null && process.versions.node != null
  );
}

/**
 * Check if running in Tauri.
 *
 * Tauri v2 injects `window.isTauri` and `__TAURI_INTERNALS__` into every
 * webview unconditionally; `__TAURI__` exists only under v1 or when
 * `withGlobalTauri` is enabled, so probing it alone reports false inside a
 * real v2 window. All three are checked so the answer survives either
 * configuration.
 */
export function isTauri(): boolean {
  return (
    isBrowser() && ("isTauri" in window || "__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/**
 * Check if running in development mode.
 */
export function isDevelopment(): boolean {
  if (isBrowser()) {
    return (
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname.includes("local")
    );
  }
  if (isNode()) {
    return process.env.NODE_ENV === "development";
  }
  return false;
}

/**
 * Check if running in production mode.
 */
export function isProduction(): boolean {
  if (isBrowser()) {
    return !isDevelopment();
  }
  if (isNode()) {
    return process.env.NODE_ENV === "production";
  }
  return false;
}

/**
 * Detect operating system.
 */
export function getOS(): "windows" | "macos" | "linux" | "ios" | "android" | "unknown" {
  if (!isBrowser()) return "unknown";

  const userAgent = window.navigator.userAgent.toLowerCase();

  if (userAgent.includes("win")) return "windows";
  if (userAgent.includes("mac")) return "macos";
  if (userAgent.includes("iphone") || userAgent.includes("ipad")) return "ios";
  if (userAgent.includes("android")) return "android";
  if (userAgent.includes("linux")) return "linux";

  return "unknown";
}

/**
 * Check if running on mobile device.
 */
export function isMobile(): boolean {
  if (!isBrowser()) return false;
  const os = getOS();
  return os === "ios" || os === "android";
}

/**
 * Check if running on desktop.
 */
export function isDesktop(): boolean {
  return !isMobile();
}

/**
 * Get browser name.
 */
export function getBrowser(): "chrome" | "firefox" | "safari" | "edge" | "opera" | "unknown" {
  if (!isBrowser()) return "unknown";

  const userAgent = window.navigator.userAgent.toLowerCase();

  if (userAgent.includes("edg")) return "edge";
  if (userAgent.includes("opr") || userAgent.includes("opera")) return "opera";
  if (userAgent.includes("chrome")) return "chrome";
  if (userAgent.includes("safari")) return "safari";
  if (userAgent.includes("firefox")) return "firefox";

  return "unknown";
}
