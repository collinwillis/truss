import * as React from "react";

import { Input } from "@truss/ui/components/input";
import { cn } from "@truss/ui/lib/utils";

/** Props for {@link NumberInput}. */
export interface NumberInputProps {
  /** Raw text value — kept as a string so partial input ("1.", "") survives. */
  value: string;
  /** Receives the value with every non-numeric character already stripped. */
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
}

/**
 * Text input restricted to decimal characters. WHY text-not-number:
 * native number inputs add browser spinners on desktop, mishandle leading
 * dots, and reject the user's locale-specific decimal separator. A plain
 * text input with `inputMode="decimal"` gets the numeric keyboard on
 * touch and behaves predictably everywhere else.
 */
export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput({ value, onChange, placeholder, className, autoComplete }, ref) {
    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        pattern="[0-9.]*"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={cn("h-9 text-sm font-mono tabular-nums", className)}
      />
    );
  }
);
