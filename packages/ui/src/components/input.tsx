import * as React from "react";

import { cn } from "@truss/ui/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Focus grammar matches Textarea/Checkbox/Switch exactly — one ring
        // for the whole kit. Without outline-none WebKit stacks its native
        // outline on top of any ring, which renders as a smeared halo.
        "file:text-foreground placeholder:text-muted-foreground dark:bg-input/30 border-input h-6 w-full min-w-0 rounded-lg border bg-transparent px-2 py-1 text-body shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-callout file:font-medium focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Input };
