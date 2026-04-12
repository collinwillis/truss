import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@truss/ui/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-callout font-medium transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 shrink-0 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-fill-quaternary hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-fill-quaternary hover:text-foreground dark:hover:bg-fill-quaternary",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-6 px-4 py-1 has-[>svg]:px-3" /* 24px — Global/Height Medium, 16px padding */,
        sm: "h-5 rounded-lg gap-1 px-2.5 text-subheadline has-[>svg]:px-2" /* 20px — Small */,
        lg: "h-7 rounded-lg px-4 has-[>svg]:px-3" /* 28px — Large */,
        icon: "size-6" /* 24px */,
        "icon-sm": "size-5" /* 20px */,
        "icon-lg": "size-7" /* 28px */,
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
