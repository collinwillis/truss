import * as React from "react";

import { cn } from "@truss/ui/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // ONE focus grammar for the whole kit, in the tokens' own dialect:
        // --ring is mac-blue with its softness BAKED IN (25%), used at full
        // strength — layering /50 on it double-diluted the halo into mush.
        // Solid accent border + snug 2px glow = the native macOS field.
        //
        // appearance-none is LOAD-BEARING on WKWebView (Tauri): with native
        // appearance, macOS draws the system focus halo as part of the
        // control itself and outline-none CANNOT suppress it — that halo is
        // exactly the smear this class list exists to prevent.
        "file:text-foreground placeholder:text-muted-foreground dark:bg-input/30 border-input h-6 w-full min-w-0 rounded-lg border bg-transparent px-2 py-1 text-body shadow-xs transition-[color,box-shadow] appearance-none outline-none file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-callout file:font-medium focus-visible:border-primary focus-visible:ring-ring focus-visible:ring-2 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Input };
