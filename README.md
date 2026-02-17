<div align="center">

# Truss

**Professional cross-platform desktop applications for construction project management**

Modern TypeScript monorepo powering Momentum (project tracking) and Precision (estimation). Built
with Turborepo, Tauri v2, React 19, and Convex.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?style=flat&logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat&logo=react&logoColor=white)](https://react.dev)
[![Convex](https://img.shields.io/badge/Convex-Backend-FF6B35?style=flat)](https://convex.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## Applications

| App           | Description                              | Stack                        |
| ------------- | ---------------------------------------- | ---------------------------- |
| **Momentum**  | Project tracking and progress management | Tauri v2 + React 19 + Convex |
| **Precision** | Professional project estimation          | Tauri v2 + React 19 + Convex |

## Prerequisites

- **[Bun](https://bun.sh)** v1.3.0+
- **[Node.js](https://nodejs.org)** v20.11.0 (see `.nvmrc`)
- **[Rust](https://www.rust-lang.org/tools/install)** (for Tauri)

## Quick Start

```bash
git clone https://github.com/collinwillis/truss.git
cd truss

bun install

# Setup environment variables
./scripts/setup-env.sh
# Edit apps/momentum/.env.local with your Convex URLs

# Start developing
bun run dev:momentum
```

## Architecture

```
apps/
  momentum/          Tauri v2 desktop app (project tracking)
  precision/         Tauri v2 desktop app (estimation)
packages/
  backend/           Convex backend (serverless functions)
  auth/              Better Auth server + clients
  config/            Constants and environment helpers
  features/          Business logic (organizations, projects, progress)
  lib/               Utility functions
  types/             Centralized TypeScript types
  ui/                Platform-agnostic UI components (shadcn/ui)
  eslint-config/     Shared ESLint config
  typescript-config/ Shared TypeScript config
```

## Development

```bash
bun run dev:momentum     # Momentum desktop app
bun run dev:precision    # Precision desktop app
bun run dev:backend      # Convex backend

bun run build:momentum   # Build Momentum installer
bun run build:precision  # Build Precision installer

bun run lint             # ESLint all packages
bun run check-types      # TypeScript type check
bun run format           # Prettier format
```

## Tech Stack

- **Desktop**: [Tauri v2](https://tauri.app) + [Vite](https://vitejs.dev)
- **Frontend**: [React 19](https://react.dev) + [TypeScript 5.9](https://www.typescriptlang.org/)
- **Backend**: [Convex](https://convex.dev) (serverless)
- **Auth**: [Better Auth](https://www.better-auth.com) with Tauri deep link OAuth
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
- **Monorepo**: [Turborepo](https://turbo.build/repo) + [Bun](https://bun.sh)

## Releasing

Releases are automated via GitHub Actions:

```bash
# Manual release
# Go to Actions > Release Desktop > Run workflow > Select app + version

# Automated release (via changesets)
bun run changeset
git add . && git commit -m "chore: add changeset"
git push
# Merge the "Version Packages" PR to trigger builds
```

Builds are produced for macOS (ARM64 + Intel), Windows, and Linux. Auto-updates are delivered via
`tauri-plugin-updater` with signature verification.

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** - Development guidelines and architecture
- **[docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md)** - Environment variable reference

## License

MIT - see [LICENSE](./LICENSE).

---

<div align="center">

[Report Bug](https://github.com/collinwillis/truss/issues) ·
[Request Feature](https://github.com/collinwillis/truss/issues)

</div>
