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
        /* Bordered control that sits on card ground rather than window ground. */
        surface: "bg-card text-foreground border hover:bg-fill-quaternary",
        ghost: "hover:bg-fill-quaternary hover:text-foreground dark:hover:bg-fill-quaternary",
        /* Ghost that recedes until pointed at — for toolbars of many icon controls. */
        subtle: "text-muted-foreground hover:bg-fill-quaternary hover:text-foreground",
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
      density: {
        compact: "",
        /*
         * The focus ring rides on `comfortable` rather than the base string: adding it to
         * the base would restyle every button in Precision, which ships without one today.
         * Precision can adopt it by opting into this density or by adding the ring itself.
         */
        comfortable: "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      },
    },
    compoundVariants: [
      /* Comfortable restates every metric the size sets, so tailwind-merge resolves the pair. */
      { density: "comfortable", size: "default", class: "h-8 px-3 text-body has-[>svg]:px-3" },
      {
        density: "comfortable",
        size: "sm",
        class: "h-7 gap-1.5 px-2.5 text-subheadline has-[>svg]:px-2.5",
      },
      { density: "comfortable", size: "lg", class: "h-9 px-4 text-body has-[>svg]:px-4" },
      { density: "comfortable", size: "icon", class: "size-8" },
      { density: "comfortable", size: "icon-sm", class: "size-7" },
      { density: "comfortable", size: "icon-lg", class: "size-9" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
      density: "compact",
    },
  }
);

/**
 * Action control shared by every Truss app.
 *
 * `density` is the control-height scale, not a spacing preference: `compact` is the
 * macOS HIG height ladder (20/24/28px) desktop apps built to Apple's metrics need, and
 * `comfortable` is the web-app ladder (28/32/36px) an editorial layout needs. It defaults
 * to `compact`, so apps that never pass it are unaffected.
 */
function Button({
  className,
  variant,
  size,
  density,
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
      className={cn(buttonVariants({ variant, size, density, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
