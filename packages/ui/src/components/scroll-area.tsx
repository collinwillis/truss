/**
 * ScrollArea Component
 *
 * Platform-agnostic custom scrollbar solution using Radix UI ScrollArea.
 *
 * Why use this instead of native scrollbars?
 * ---------------------------------------
 * Native webkit scrollbar CSS (::-webkit-scrollbar-*) does NOT work in Tauri's
 * WKWebView on macOS. This is a known limitation documented in:
 * - GitHub Issue #6067 (tauri-apps/tauri)
 * - Apache Cordova Bug CB-10123
 *
 * This component creates overlay scrollbars using JavaScript that work
 * consistently across ALL platforms:
 * - Chrome/Edge (Blink)
 * - Firefox (Gecko)
 * - Tauri WKWebView (macOS)
 * - Tauri WebView2 (Windows)
 * - Tauri WebKitGTK (Linux)
 *
 * Theme Integration
 * ----------------
 * The scrollbar automatically adapts to the active brand theme via CSS variables:
 * - --scroll-track: Background rail color
 * - --scroll-thumb: Default thumb color
 * - --scroll-thumb-hover: Hover state color (brand color)
 *
 * These variables are defined in:
 * - packages/ui/src/styles/theme.css (neutral base)
 * - packages/ui/src/styles/themes/precision.css (teal brand)
 * - packages/ui/src/styles/themes/momentum.css (purple brand)
 *
 * Design Specifications
 * --------------------
 * - Width: 10px (matches industry standard: VS Code, Slack, ClickUp)
 * - Thumb style: Rounded, with brand color on hover
 * - Track style: Subtle background, low contrast at rest
 * - Transitions: 150ms smooth color change on hover
 * - Reduced motion: Respects prefers-reduced-motion preference
 *
 * Usage
 * -----
 * Wrap any scrollable content with this component:
 *
 * ```tsx
 * <ScrollArea className="h-[500px]">
 *   <div>Long scrollable content...</div>
 * </ScrollArea>
 * ```
 *
 * For horizontal scrolling:
 * ```tsx
 * <ScrollArea className="w-full">
 *   <div className="flex gap-4">
 *     <div>Wide content...</div>
 *   </div>
 *   <ScrollBar orientation="horizontal" />
 * </ScrollArea>
 * ```
 *
 * @see https://www.radix-ui.com/primitives/docs/components/scroll-area
 */
"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@truss/ui/lib/utils";

/**
 * ScrollArea root component
 *
 * Creates a scrollable container with custom overlay scrollbars.
 * The container must have a fixed height or max-height to enable scrolling.
 */
function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

/**
 * ScrollBar component
 *
 * Custom scrollbar with brand theming support.
 * Uses CSS variables from the active theme (Precision teal or Momentum purple).
 * Supports both vertical and horizontal orientations.
 */
function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-[var(--scroll-thumb)] hover:bg-[var(--scroll-thumb-hover)] transition-colors duration-150 motion-reduce:transition-none"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
