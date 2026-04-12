import * as React from "react";

import { cn } from "@truss/ui/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground dark:bg-input/30 border-input h-6 w-full min-w-0 rounded-lg border bg-transparent px-2 py-1 text-body shadow-xs file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-callout file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Input };
