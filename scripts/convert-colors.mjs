#!/usr/bin/env node
/**
 * Color conversion script to convert HSL colors to OKLCH format
 * Uses culori library for accurate color space conversion
 */

import { converter, formatCss } from 'culori';

const hslToOklch = converter('oklch');

const colors = {
  precision: {
    light: {
      primary: 'hsl(180 65% 42%)',
      secondary: 'hsl(180 25% 90%)',
      secondaryForeground: 'hsl(180 65% 25%)',
      accent: 'hsl(180 50% 95%)',
      accentForeground: 'hsl(180 65% 30%)',
      muted: 'hsl(180 15% 96%)',
      mutedForeground: 'hsl(180 10% 45%)',
      success: 'hsl(150 65% 45%)',
      info: 'hsl(200 65% 50%)',
      sidebarPrimary: 'hsl(180 65% 42%)',
      sidebarAccent: 'hsl(180 30% 96%)',
      sidebarAccentForeground: 'hsl(180 65% 25%)',
      sidebarRing: 'hsl(180 65% 50%)',
    },
    dark: {
      primary: 'hsl(180 70% 55%)',
      primaryForeground: 'hsl(180 90% 10%)',
      secondary: 'hsl(180 25% 20%)',
      secondaryForeground: 'hsl(180 50% 90%)',
      accent: 'hsl(180 35% 18%)',
      accentForeground: 'hsl(180 60% 85%)',
      muted: 'hsl(180 15% 16%)',
      mutedForeground: 'hsl(180 10% 60%)',
      success: 'hsl(150 60% 50%)',
      successForeground: 'hsl(150 90% 10%)',
      info: 'hsl(200 65% 55%)',
      infoForeground: 'hsl(200 90% 10%)',
      sidebarPrimary: 'hsl(180 70% 55%)',
      sidebarPrimaryForeground: 'hsl(180 90% 10%)',
      sidebarAccent: 'hsl(180 30% 16%)',
      sidebarAccentForeground: 'hsl(180 60% 90%)',
      sidebarRing: 'hsl(180 70% 60%)',
    },
  },
  momentum: {
    light: {
      primary: 'hsl(270 70% 50%)',
      secondary: 'hsl(270 30% 90%)',
      secondaryForeground: 'hsl(270 70% 25%)',
      accent: 'hsl(270 55% 95%)',
      accentForeground: 'hsl(270 70% 30%)',
      muted: 'hsl(270 20% 96%)',
      mutedForeground: 'hsl(270 15% 45%)',
      success: 'hsl(150 65% 45%)',
      info: 'hsl(250 65% 55%)',
      sidebarPrimary: 'hsl(270 70% 50%)',
      sidebarAccent: 'hsl(270 35% 96%)',
      sidebarAccentForeground: 'hsl(270 70% 25%)',
      sidebarRing: 'hsl(270 70% 55%)',
    },
    dark: {
      primary: 'hsl(270 75% 60%)',
      primaryForeground: 'hsl(270 90% 10%)',
      secondary: 'hsl(270 30% 20%)',
      secondaryForeground: 'hsl(270 55% 90%)',
      accent: 'hsl(270 40% 18%)',
      accentForeground: 'hsl(270 65% 85%)',
      muted: 'hsl(270 20% 16%)',
      mutedForeground: 'hsl(270 15% 60%)',
      success: 'hsl(150 60% 50%)',
      successForeground: 'hsl(150 90% 10%)',
      info: 'hsl(250 65% 60%)',
      infoForeground: 'hsl(250 90% 10%)',
      sidebarPrimary: 'hsl(270 75% 60%)',
      sidebarPrimaryForeground: 'hsl(270 90% 10%)',
      sidebarAccent: 'hsl(270 35% 16%)',
      sidebarAccentForeground: 'hsl(270 65% 90%)',
      sidebarRing: 'hsl(270 75% 65%)',
    },
  },
  base: {
    light: {
      background: 'hsl(0 0% 100%)',
      foreground: 'hsl(240 10% 3.9%)',
      card: 'hsl(0 0% 100%)',
      cardForeground: 'hsl(240 10% 3.9%)',
      popover: 'hsl(0 0% 100%)',
      popoverForeground: 'hsl(240 10% 3.9%)',
      primary: 'hsl(240 5.9% 10%)',
      primaryForeground: 'hsl(0 0% 98%)',
      secondary: 'hsl(240 4.8% 95.9%)',
      secondaryForeground: 'hsl(240 5.9% 10%)',
      muted: 'hsl(240 4.8% 95.9%)',
      mutedForeground: 'hsl(240 3.8% 46.1%)',
      accent: 'hsl(240 4.8% 95.9%)',
      accentForeground: 'hsl(240 5.9% 10%)',
      destructive: 'hsl(0 84.2% 60.2%)',
      destructiveForeground: 'hsl(0 0% 98%)',
      border: 'hsl(240 5.9% 90%)',
      input: 'hsl(240 5.9% 90%)',
      ring: 'hsl(240 10% 3.9%)',
    },
    dark: {
      background: 'hsl(240 10% 3.9%)',
      foreground: 'hsl(0 0% 98%)',
      card: 'hsl(240 10% 3.9%)',
      cardForeground: 'hsl(0 0% 98%)',
      popover: 'hsl(240 10% 3.9%)',
      popoverForeground: 'hsl(0 0% 98%)',
      primary: 'hsl(0 0% 98%)',
      primaryForeground: 'hsl(240 5.9% 10%)',
      secondary: 'hsl(240 3.7% 15.9%)',
      secondaryForeground: 'hsl(0 0% 98%)',
      muted: 'hsl(240 3.7% 15.9%)',
      mutedForeground: 'hsl(240 5% 64.9%)',
      accent: 'hsl(240 3.7% 15.9%)',
      accentForeground: 'hsl(0 0% 98%)',
      destructive: 'hsl(0 62.8% 30.6%)',
      destructiveForeground: 'hsl(0 0% 98%)',
      border: 'hsl(240 3.7% 15.9%)',
      input: 'hsl(240 3.7% 15.9%)',
      ring: 'hsl(240 4.9% 83.9%)',
    },
  },
  sidebar: {
    light: {
      sidebar: 'hsl(0 0% 98%)',
      sidebarForeground: 'hsl(240 5.3% 26.1%)',
      sidebarPrimary: 'hsl(240 5.9% 10%)',
      sidebarPrimaryForeground: 'hsl(0 0% 98%)',
      sidebarAccent: 'hsl(240 4.8% 95.9%)',
      sidebarAccentForeground: 'hsl(240 5.9% 10%)',
      sidebarBorder: 'hsl(220 13% 91%)',
      sidebarRing: 'hsl(217.2 91.2% 59.8%)',
    },
    dark: {
      sidebar: 'hsl(240 5.9% 10%)',
      sidebarForeground: 'hsl(240 4.8% 95.9%)',
      sidebarPrimary: 'hsl(224.3 76.3% 48%)',
      sidebarPrimaryForeground: 'hsl(0 0% 100%)',
      sidebarAccent: 'hsl(240 3.7% 15.9%)',
      sidebarAccentForeground: 'hsl(240 4.8% 95.9%)',
      sidebarBorder: 'hsl(240 3.7% 15.9%)',
      sidebarRing: 'hsl(217.2 91.2% 59.8%)',
    },
  },
};

/**
 * Convert a color to OKLCH format and round to 3 decimal places
 */
function convertToOklch(hslColor) {
  const oklch = hslToOklch(hslColor);
  if (!oklch) {
    return null;
  }

  // Round to 3 decimal places for cleaner output
  const l = Number(oklch.l.toFixed(3));
  const c = Number(oklch.c.toFixed(3));
  const h = oklch.h !== undefined ? Number(oklch.h.toFixed(2)) : 0;

  return `oklch(${l} ${c} ${h})`;
}

/**
 * Convert all colors in a theme object
 */
function convertTheme(theme) {
  const result = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === 'string') {
      result[key] = convertToOklch(value);
    } else if (typeof value === 'object') {
      result[key] = convertTheme(value);
    }
  }
  return result;
}

// Convert all colors
const convertedColors = convertTheme(colors);

// Output as JSON for easy reference
console.log(JSON.stringify(convertedColors, null, 2));

// Also output as formatted CSS comments
console.log('\n\n=== CSS Format ===\n');

console.log('/* Base Theme - Light Mode */');
for (const [key, value] of Object.entries(convertedColors.base.light)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.base.light[key]} */`);
}

console.log('\n/* Base Theme - Dark Mode */');
for (const [key, value] of Object.entries(convertedColors.base.dark)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.base.dark[key]} */`);
}

console.log('\n/* Precision - Light Mode */');
for (const [key, value] of Object.entries(convertedColors.precision.light)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.precision.light[key]} */`);
}

console.log('\n/* Precision - Dark Mode */');
for (const [key, value] of Object.entries(convertedColors.precision.dark)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.precision.dark[key]} */`);
}

console.log('\n/* Momentum - Light Mode */');
for (const [key, value] of Object.entries(convertedColors.momentum.light)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.momentum.light[key]} */`);
}

console.log('\n/* Momentum - Dark Mode */');
for (const [key, value] of Object.entries(convertedColors.momentum.dark)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.momentum.dark[key]} */`);
}

console.log('\n/* Sidebar - Light Mode */');
for (const [key, value] of Object.entries(convertedColors.sidebar.light)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.sidebar.light[key]} */`);
}

console.log('\n/* Sidebar - Dark Mode */');
for (const [key, value] of Object.entries(convertedColors.sidebar.dark)) {
  console.log(`  --${key}: ${value}; /* was: ${colors.sidebar.dark[key]} */`);
}
