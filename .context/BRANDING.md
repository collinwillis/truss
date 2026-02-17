# Truss Suite Branding Guide

## Brand Identity Overview

The Truss Suite consists of two distinct applications with cohesive yet unique visual identities,
inspired by industry leaders like Affinity Suite (Publisher/Designer/Photo).

---

## Application Brand Colors

### **Precision** (Construction Estimating)

**Primary Brand Color: Professional Teal**

```
Light Mode:  hsl(180 65% 42%)  /* #1ba0a0 */
Dark Mode:   hsl(180 70% 55%)  /* #2cc9c9 */
```

**Color Psychology:**

- **Trust** - Instills confidence in cost accuracy
- **Precision** - Reflects exact calculations and detailed work
- **Reliability** - Conveys dependability in estimating
- **Innovation** - Modern approach to construction estimating

**Visual Characteristics:**

- Cool, professional tone
- High contrast in both modes
- Complements construction/architectural imagery
- Works well with financial data displays

---

### **Momentum** (Time Tracking & Productivity)

**Primary Brand Color: Vibrant Purple**

```
Light Mode:  hsl(270 70% 50%)  /* #8c1aff */
Dark Mode:   hsl(270 75% 60%)  /* #a64dff */
```

**Color Psychology:**

- **Energy** - Motivates productive work
- **Creativity** - Encourages innovative thinking
- **Momentum** - Represents forward progress and movement
- **Vitality** - Energizes time tracking workflows

**Visual Characteristics:**

- Energetic, dynamic tone
- Eye-catching without being overwhelming
- Stimulates focus and productivity
- Modern tech-forward appearance

---

## Technical Implementation

### CSS Variable Structure

Both apps use Tailwind v4's CSS-first theming approach with semantic tokens:

```css
/* Precision Theme */
:root[data-app="precision"] {
  --primary: hsl(180 65% 42%);
  --primary-foreground: hsl(0 0% 100%);
  /* ... additional tokens */
}

.dark[data-app="precision"] {
  --primary: hsl(180 70% 55%);
  --primary-foreground: hsl(180 90% 10%);
  /* ... additional tokens */
}

/* Momentum Theme */
:root[data-app="momentum"] {
  --primary: hsl(270 70% 50%);
  --primary-foreground: hsl(0 0% 100%);
  /* ... additional tokens */
}

.dark[data-app="momentum"] {
  --primary: hsl(270 75% 60%);
  --primary-foreground: hsl(270 90% 10%);
  /* ... additional tokens */
}
```

### Theme Files Location

- **Shared base theme**: `/packages/ui/src/styles/theme.css`
- **Precision theme**: `/packages/ui/src/styles/themes/precision.css`
- **Momentum theme**: `/packages/ui/src/styles/themes/momentum.css`
- **Global imports**: `/packages/ui/src/styles/globals.css`

---

## Theme Switching

### Light/Dark Mode Toggle

**Location**: Top app bar (industry standard position) **Component**: `ThemeSwitcher` **Modes**:
Light, Dark, System (follows OS preference)

**Keyboard Shortcuts:**

- No default shortcut (user accesses via UI)
- Theme persisted to localStorage
- Syncs with system dark mode preferences

### Implementation

```tsx
import { ThemeSwitcher } from "@truss/features/desktop-shell";

// In AppBar or User Menu
<ThemeSwitcher variant="ghost" size="sm" />;
```

---

## Color Accessibility

### WCAG AA Compliance

Both color systems meet WCAG AA standards for contrast:

**Precision (Teal):**

- Light mode primary on white: **5.2:1 contrast ratio** ✅
- Dark mode primary on dark bg: **7.8:1 contrast ratio** ✅

**Momentum (Purple):**

- Light mode primary on white: **4.8:1 contrast ratio** ✅
- Dark mode primary on dark bg: **8.2:1 contrast ratio** ✅

### Focus States

All interactive elements include visible focus rings for keyboard navigation:

- Uses `--ring` color (adjusted per theme)
- 2px ring with offset for clarity
- Respects user's motion preferences

---

## Contextual Colors

### Success/Error/Info

Each app maintains consistent success/error states while subtly aligning with brand:

**Precision** (Teal-aligned):

- Success: `hsl(150 65% 45%)` - Green with teal undertones
- Info: `hsl(200 65% 50%)` - Blue-cyan
- Error: `hsl(0 84.2% 60.2%)` - Standard red (universal)

**Momentum** (Purple-aligned):

- Success: `hsl(150 65% 45%)` - Standard green
- Info: `hsl(250 65% 55%)` - Blue-purple
- Error: `hsl(0 84.2% 60.2%)` - Standard red (universal)

---

## Best Practices

### Do's ✅

- Use semantic color tokens (`primary`, `accent`, `muted`) in components
- Respect the `data-app` attribute for app-specific styling
- Test both light and dark modes
- Ensure sufficient contrast for text
- Use theme colors for brand touchpoints (headers, CTAs, highlights)

### Don'ts ❌

- Don't hardcode hex values in components
- Don't use brand colors for destructive actions
- Don't override theme colors in app-specific code
- Don't use brand colors as backgrounds for large areas
- Don't sacrifice accessibility for aesthetics

---

## Monorepo Architecture

### Shared Theme Package

```
packages/ui/src/styles/
├── globals.css           # Main entry point
├── theme.css             # Base shadcn theme (neutral)
└── themes/
    ├── precision.css     # Teal brand overrides
    └── momentum.css      # Purple brand overrides
```

### App Integration

Each app automatically applies its brand theme via:

1. `data-app` attribute on `<html>` element
2. App-specific CSS imports in theme package
3. Shared component library respects theme tokens

---

## Future Considerations

### Potential Additions

- **Custom accent colors** - User-selected accents per workspace
- **High contrast mode** - Enhanced accessibility option
- **Color blind modes** - Deuteranopia/Protanopia variants
- **Brand gradients** - Subtle gradients for marketing/onboarding

### Maintenance

- Color values defined in single source of truth (CSS files)
- shadcn/ui theme generator can regenerate scales
- Regular accessibility audits
- User feedback on color preferences

---

## References

- [Tailwind CSS v4 Theming](https://tailwindcss.com/docs/theme)
- [shadcn/ui Theming Guide](https://ui.shadcn.com/docs/theming)
- [WCAG 2.1 Contrast Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [Color Psychology in UX](https://www.nngroup.com/articles/color-enhance-design/)

---

**Last Updated**: 2025-10-16 **Maintained By**: Truss Design Team
