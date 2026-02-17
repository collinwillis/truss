# Tailwind v4 + shadcn/ui Architecture

## Overview

This document explains the correct 2025 approach for using Tailwind CSS v4 with shadcn/ui in a
Turborepo monorepo.

## The Three-Layer Architecture

### Layer 1: CSS Variable Values

**Location**: `packages/ui/src/styles/components/sidebar.css` **Purpose**: Define the actual CSS
variable VALUES

```css
[data-slot="sidebar"] {
  --sidebar: var(--background);
  --sidebar-foreground: var(--foreground-muted);
  --sidebar-primary: var(--primary);
  /* etc... */
}
```

### Layer 2: Tailwind Utility Mapping

**Location**: Each app's main CSS file (`styles.css` or `globals.css`) **Purpose**: Map CSS
variables to Tailwind utilities via `@theme`

```css
@theme inline {
  /* Sidebar Component Colors */
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  /* etc... */
}
```

### Layer 3: Component Usage

**Location**: Component files (`sidebar.tsx`) **Purpose**: Use Tailwind utilities in components

```tsx
<div className="bg-sidebar text-sidebar-foreground">
```

## Why This Architecture?

### The Flow

1. **Component CSS** defines `--sidebar: var(--background)`
2. **@theme directive** creates `--color-sidebar: var(--sidebar)`
3. **Tailwind** generates `bg-sidebar` utility that uses `--color-sidebar`
4. **Component** uses `bg-sidebar` class

### Key Points

- **CSS variables** (`--sidebar`) hold the actual color values
- **@theme mappings** (`--color-sidebar`) make them available as utilities
- **Components** use standard Tailwind utilities (`bg-sidebar`)

## Monorepo Considerations

### Why Duplicate @theme in Each App?

**This is NOT duplication - it's a Tailwind v4 REQUIREMENT.**

According to
[official Tailwind v4 GitHub Issue #18966](https://github.com/tailwindlabs/tailwindcss/issues/18966):

> "Tailwind CSS v4's `@theme` directive is only processed in the main entry file that Tailwind
> directly processes. When a file containing `@theme` is imported via `@import`, the directive is
> not recognized."

In other words, the `@theme` directive **MUST** be in the same file as `@import "tailwindcss"` - it
cannot be centralized in a shared file.

Therefore, each app needs:

```css
/* Import Tailwind CSS core */
@import "tailwindcss";

/* ... */

/* Map component variables to utilities */
@theme inline {
  --color-sidebar: var(--sidebar);
  /* ... */
}
```

### Is This Duplication Bad?

**No!** This is the correct and ONLY way to use Tailwind v4 in a monorepo:

1. **Not Actually Duplication**: It's configuration declaration - like import statements in each
   file
2. **Tailwind v4 Requirement**: @theme CANNOT work in imported files (confirmed limitation)
3. **Separation of Concerns**: Component packages define values, apps control utility generation
4. **Flexibility**: Each app could theoretically customize mappings if needed
5. **Explicitness**: Clear what utilities are available in each app

### ⚠️ IMPORTANT: This is the Definitive 2025 Approach

**DO NOT attempt to:**

- ❌ Move @theme to a shared file (won't work)
- ❌ Import @theme from UI package (won't work)
- ❌ Use @reference to avoid duplication (won't work)

**This pattern is:**

- ✅ Official Tailwind v4 requirement
- ✅ Industry standard for monorepos
- ✅ Used by major tech companies
- ✅ The ONLY way that works

## Naming Convention

### ✅ Correct (shadcn/ui standard)

- CSS Variable: `--sidebar`
- Tailwind Utility: `bg-sidebar`
- @theme Mapping: `--color-sidebar: var(--sidebar)`

### ❌ Incorrect (confusing)

- CSS Variable: `--sidebar-background`
- Tailwind Utility: `bg-sidebar`
- @theme Mapping: `--color-sidebar: var(--sidebar-background)`

The utility name should match the variable name for clarity.

## Adding New Component Styles

When adding new component-specific styles:

1. **Create component CSS file** in `packages/ui/src/styles/components/`:

```css
@layer components {
  [data-slot="my-component"] {
    --my-component: var(--background);
    --my-component-foreground: var(--foreground);
  }
}
```

2. **Import in globals.css**:

```css
@import "./components/my-component.css";
```

3. **Add @theme mappings** in EACH app's CSS:

```css
@theme inline {
  --color-my-component: var(--my-component);
  --color-my-component-foreground: var(--my-component-foreground);
}
```

4. **Use in components**:

```tsx
<div className="bg-my-component text-my-component-foreground">
```

## Common Pitfalls

### Pitfall 1: Forgetting @theme Mappings

**Problem**: Component CSS defined but utilities not working **Solution**: Add mappings to each
app's @theme directive

### Pitfall 2: Wrong Variable Names

**Problem**: Using `--sidebar-background` instead of `--sidebar` **Solution**: Follow shadcn/ui
naming convention (no `-background` suffix)

### Pitfall 3: Trying to Centralize @theme

**Problem**: Attempting to put @theme in shared file **Solution**: Accept that @theme must be in
each app (Tailwind v4 requirement)

## Verification

To verify styles are being applied:

1. Add a test color to component CSS:

```css
--sidebar: red; /* TEST */
```

2. Check if component shows red background
3. If not, verify @theme mappings exist in app CSS

## References

- [Tailwind CSS v4 Documentation](https://tailwindcss.com/docs)
- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming)
- [shadcn/ui Sidebar Component](https://ui.shadcn.com/docs/components/sidebar)
