# Modern Desktop Application UI Best Practices (Tailwind + shadcn/ui + Tauri)

> Adapted from an original web/SaaS dashboard checklist and expanded with desktop‑app patterns
> benchmarked from VS Code, Slack, and Cal.com. Tailored for a Tauri app using Tailwind and
> shadcn/ui.

---

## I. Core Design Philosophy & Strategy (Desktop Context)

- [ ] **Users First**: Optimize for core workflows, speed, and reliability. Prioritize frequent
      tasks.
- [ ] **Simplicity with Power**: Reveal complexity progressively (advanced settings, panels,
      toolbars) without removing capability.
- [ ] **Predictable Consistency**: Prefer **product‑level consistency** across platforms
      (Windows/macOS/Linux) over strict OS‑native styling.
- [ ] **Immediate Feedback**: Clear affordances and instant visual/aural feedback for actions
      (press, hover, busy, success, error).
- [ ] **Keyboard First**: Global and contextual shortcuts, discoverability (command palette/help
      overlay), and full keyboard traversal.
- [ ] **Accessibility AA+**: High contrast, focus rings, semantics/roles/aria; respect OS text
      scaling and high‑DPI.
- [ ] **Performance**: Fast launch, low memory/CPU/GPU, judicious animations (150–300ms), avoid
      layout thrash.
- [ ] **Offline‑tolerant UX**: Status indicators, queued actions, clear retry/reconcile flows when
      connectivity returns.

---

## II. Application Shell & Window Management

- [ ] **Standard Shell Regions**
  - [ ] **Top App Bar** (≈48px): App title, view actions, global search/command palette.
  - [ ] **Primary Navigation (Left)**: Resizable rail/sidebar for top‑level areas.
  - [ ] **Body / Workspace**: Primary canvas; fluid, latency‑sensitive interactions.
  - [ ] **Optional Right Inspector**: Contextual details/properties.
  - [ ] **Status/Toasts**: Non‑blocking notifications; bottom area or toast stack.

- [ ] **Three‑Column Master–Detail–Inspector**
  - [ ] Left **Nav** (user‑resizable; cap at ≤50% viewport).
  - [ ] Middle **List/Master** (resource list, queues, results).
  - [ ] Right **Detail/Editor** (flex‑expanding primary workspace).
  - [ ] **Collapse order on shrink**: Nav ➜ Master ➜ preserve Detail.

- [ ] **Window Sizing & Constraints**
  - [ ] **Minimum support**: works at 800×600; practical min width ~600px.
  - [ ] **Default launch**: ~1200×700 to 1366×775.
  - [ ] **Max reading width**: constrain text bodies to 800–1200px for legibility.
  - [ ] **Fluid canvases**: editors, calendars, data grids stretch to fill width.
  - [ ] **Prevent truncation**: prefer reflow/show‑hide/scroll over clipped text.

- [ ] **Window Behaviors** (using **shadcn/ui Resizable**; no full docking)
  - [ ] **Pane resizing**: visible drag handles, keyboard resize, and double‑click to reset.
  - [ ] **Split groups**: vertical or horizontal `ResizablePanelGroup`, with optional nested groups
        for complex layouts.
  - [ ] **Persist & Reset**: remember layout per workspace/profile; provide a clear **Reset Layout**
        action.

**Implementation‑agnostic guidance for Resizable panes**

- [ ] Use `minSize`/`maxSize` to enforce priorities (e.g., nav ≤50% viewport) and prevent unusable
      panes.
- [ ] Prefer percentage‑based defaults so layouts adapt across window sizes.
- [ ] Ensure handles have clear focus styles and are keyboard operable.
- [ ] Persist panel sizes (e.g., per workspace) and restore on launch.
- [ ] On extreme shrink, collapse nav first, then master; keep detail visible to preserve task
      focus.

---

## III. Grid, Spacing & Density (12‑Column Inside, Fluid Outside)

- [ ] **12‑column internal grid** for structured areas (dashboards, settings, lists).
- [ ] **Typical rhythm**: columns ≈72px, gutters ≈24px; content never bleeds into gutters.
- [ ] **8px spacing scale** (4/8/12/16/24/32/48/64…). Align type line‑heights to the grid.
- [ ] **Large displays**: center and constrain reading areas; keep canvases fluid.

---

## IV. Responsive & Adaptive Strategies (Desktop Resizing)

- [ ] **Responsive first**: fluid units (%, rem, minmax, clamp), container queries where applicable.
- [ ] **Adaptive pivots** for major shifts only (e.g., collapse 3‑pane ➜ stacked).
- [ ] **Five resizing techniques**
  - [ ] **Reposition**: move controls to more suitable regions.
  - [ ] **Resize**: adjust margins/dimensions; expand canvases.
  - [ ] **Reflow**: change column counts; switch list ↔ grid.
  - [ ] **Show/Hide**: surface metadata as space allows; hide secondary UI when tight.
  - [ ] **Re‑architect**: swap split view for stacked at min sizes.
- [ ] **Always scrollable** fallback to access off‑screen content during rapid resizes.

---

## V. Typography, Readability & Accessibility

- [ ] **Body base**: 16px; captions ≥12px.
- [ ] **Line height**: body 1.4–1.5; headings ≈1.2.
- [ ] **Scale**: prefer subtle **Major Second (1.125)** for dense UIs.
- [ ] **Relative units**: `rem`/`em` for font and key dimensions; honor OS scaling.
- [ ] **High‑DPI**: crisp icons/SVGs; avoid blurry raster assets.

---

## VI. Navigation, Commands & Input

- [ ] **Command Palette** (⌘K/CTRL+K): global actions, search, and navigation.
- [ ] **Shortcut System**: consistent, discoverable (tooltip hints, shortcut cheatsheet,
      customizable bindings file).
- [ ] **Context Menus**: right‑click for advanced/rare actions; keep labels concise.
- [ ] **Search UX**: omnibox with filters; debounce; highlighted matches; keyboard results nav.
- [ ] **Selection Models**: multi‑select with Shift/Ctrl; clear bulk‑action toolbar.
- [ ] **Drag‑and‑Drop**: with ghost previews, permissible targets, and undo.

---

## VII. Feedback, Loading & State

- [ ] **Micro‑interactions**: subtle transitions; no blocking spinners when skeletons are possible.
- [ ] **Loading**: skeletons for views; inline spinners for localized ops.
- [ ] **Saving**: optimistic UI where safe; toasts with undo; conflict resolution flows.
- [ ] **Network state**: offline banners, queued actions, retry/backoff.
- [ ] **Errors**: plain‑language messages, remediation steps, copyable diagnostics.

---

## VIII. System Integration (Desktop‑Native Expectations)

- [ ] **Theme Sync**: follow system dark/light; offer in‑app override.
- [ ] **Window chrome**: custom title bar optional; preserve OS window behaviors (drag, resize,
      maximize, snap).
- [ ] **Notifications**: native OS notifications (throttle, group, respect DND).
- [ ] **File dialogs**: native pickers; recent locations; drag‑drop from Finder/Explorer.
- [ ] **Clipboard & Share**: support plain/rich text and files.
- [ ] **Spellcheck** where text input is primary; per‑field toggle.

---

## IX. Tailwind + shadcn/ui Implementation Notes (Tailwind v4)

> Tailwind v4 is **CSS‑first**. Prefer defining tokens with `@theme` in global CSS rather than
> relying on a large JS config. Keep the config minimal for build/tooling overrides only.

- [ ] **One import**: load Tailwind once in your global stylesheet (preflight + utilities).
- [ ] **Design tokens with `@theme`**: define colors, spacing, radii, shadows, Z‑index, typography,
      and density scale as semantic tokens (e.g., `--brand`, `--color-bg`, `--text-base`).
- [ ] **Dark mode & theming**: sync with the OS (prefers‑color‑scheme) but allow an in‑app override
      (root `.dark` class). Swap **semantic tokens** per theme rather than changing utility usage.
- [ ] **shadcn/ui components**: use accessible primitives (Dialog, Drawer, Popover, Tooltip, Tabs,
      Menubar, **Resizable**) and style via utilities + CSS variables. Respect `data-[state]` and
      `aria-*` attributes.
- [ ] **Resizable handle affordances**: ensure handles are visually discoverable, convey orientation
      (col/row resize cursors), and show strong `focus-visible` outlines for keyboard users.
- [ ] **Density modes**: support `[data-density="compact|comfortable"]` at the root to modulate
      paddings and line height across components.
- [ ] **Custom utilities**: when patterns repeat, create semantic utilities with Tailwind v4
      `@utility` rather than duplicating long utility strings.
- [ ] **Layout utilities**: prefer CSS Grid for panes; use `minmax()`/`clamp()` for resizable
      columns and type. Avoid fixed pixel widths where possible.
- [ ] **Motion**: prefer lightweight CSS transitions; if using animation libraries, respect **Reduce
      Motion** and keep durations within the ranges in Section XIII.

---

## X. Performance & Quality (Tauri)

- [ ] **Startup**: code‑split by route/area; lazy‑load heavy modules; defer non‑critical work.
- [ ] **Assets**: SVG for icons, webp/avif for media; cache control; preconnect to APIs.
- [ ] **Mini‑render**: avoid unnecessary re‑renders; memoize; virtualization for large lists.
- [ ] **IPC Boundaries**: debounce chatty calls across Rust ↔ Webview; batch where possible.
- [ ] **Diagnostics**: FPS meter for canvas views; flamegraphs; crash reporting with user consent.

---

## XI. Data Tables & Configuration Panels (Refined Modules)

### A) Data Tables

- [ ] **Scanability**: left‑align text, right‑align numerics; sticky header; zebra optional.
- [ ] **Controls**: sort indicators, column show/hide, filters above table, global search.
- [ ] **Large sets**: pagination or virtualization; frozen columns; CSV/Excel export.
- [ ] **Row actions**: inline edit, selection + bulk bar; keyboard shortcuts.

### B) Configuration Panels

- [ ] **Grouping**: sections/tabs; progressive disclosure (advanced accordions).
- [ ] **Inputs**: correct controls per data type; helper text; inline validation.
- [ ] **Defaults & Reset**: sensible defaults; per‑section "Reset to defaults".
- [ ] **Live Preview** where applicable; apply vs save clarity.

---

## XII. Documentation, Testing & Ops

- [ ] **Design System Docs**: tokens, components, patterns, do/don’t.
- [ ] **Accessibility QA**: keyboard audit, screen reader pass, contrast tests.
- [ ] **Shortcut Map**: in‑app panel and printable reference.
- [ ] **User Telemetry (opt‑in)**: anonymized flows to validate assumptions; privacy‑first.
- [ ] **Release Hygiene**: migration notes, feature flags, safe rollbacks.

---

## XIII. Quick Addenda (Practical Defaults)

- [ ] **Min window size**: 800×600; nav collapses first.
- [ ] **Default launch size**: ~1280×800.
- [ ] **Reading max‑width**: 960px as a sensible default.
- [ ] **Animation durations**: 150–200ms enter, 120–160ms exit; standard ease‑in‑out.
- [ ] **Hit targets**: ≥40×40px clickable areas; dense mode ≥32×32px.
- [ ] **Undo > Confirmations**: favor reversible actions with undo to reduce friction.
