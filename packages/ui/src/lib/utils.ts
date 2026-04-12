import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Extended tailwind-merge that recognizes macOS HIG named text styles
 * as font-size utilities (not colors). Without this, twMerge treats
 * `text-callout` as a color and drops `text-primary-foreground`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "largeTitle",
            "title1",
            "title2",
            "title3",
            "headline",
            "body",
            "callout",
            "subheadline",
            "footnote",
            "caption1",
            "caption2",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
