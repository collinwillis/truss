# CLAUDE.md

Instructions for Claude Code when working with this repository.

## ⚠️ CRITICAL: Read Before Coding

**BEFORE implementing any code, you MUST read and follow:**

- [`comment-principles.md`](.context/comment-principles.md) - Professional commenting requirements
- [`design-principles.md`](.context/design-principles.md) - Professional UI design requirements

**Key Rules:**

- All exported functions/types require JSDoc
- Explain WHY, not WHAT
- Keep comments concise and professional
- No verbose usage examples
- Follow Google TypeScript Style Guide

## Visual Development

**Design Principles**

- Comprehensive design checklist in /context/design-principles.md
- Brand style guide in /context/style-guide.md
- When making visual (front-end, UI/UX) changes, always refer to these files for guidance

**Quick Visual Check**

- IMMEDIATELY after implementing any front-end change:

1. Identify what changed - Review the modified components/pages
2. Navigate to affected pages - Use mcp**playwright**browser_navigate to visit each changed view
3. Verify design compliance - Compare against /context/design-principles.md and
   /context/style-guide.md
4. Validate feature implementation - Ensure the change fulfills the user's specific request
5. Check acceptance criteria - Review any provided context files or requirements
6. Capture evidence - Take full page screenshot at desktop viewport (1440px) of each changed view
7. Check for errors - Run mcp**playwright**browser_console_messages

- This verification ensures changes meet design standards and user requirements.

## Bash Commands

### Development

```bash
bun run dev:web          # Web app (localhost:3000)
bun run dev:precision    # Precision desktop (localhost:1420)
bun run dev:momentum     # Momentum desktop (localhost:1420)
```

### Quality Checks

```bash
bun run lint             # ESLint all packages
bun run check-types      # TypeScript type check
bun run format           # Prettier format
bun run format:check     # Check formatting (CI)
```

### Building

```bash
bun run build            # All apps
bun run build:web        # Web only
bun run build:precision  # Precision only
bun run build:momentum   # Momentum only
```

### Database (Supabase)

```bash
bun run db:start                    # Start local Supabase
bun run db:stop                     # Stop local Supabase
bun run db:status                   # Check status
bun run db:studio                   # Open Studio UI
bun run db:reset                    # Reset local DB
bun run db:migration:create <name>  # Create migration + generate types
bun run db:generate                 # Generate TypeScript types
bun run db:types:check              # Check for type drift
bun run db:validate                 # Validate SQL syntax
```

### Utilities

```bash
bun run cleanup-ports    # Kill processes on port 3000/1420
bun run clean            # Clean build artifacts
```

## Critical Rules

### Package Manager

- ✅ **ALWAYS** use `bun` commands
- ❌ **NEVER** use `npm install` or `yarn`

### Package Organization

**Foundation Packages** (no dependencies):

- ✅ **@truss/types**: Centralized TypeScript type definitions
- ✅ **@truss/lib**: Utility functions and helpers
- ✅ **@truss/config**: Configuration, constants, and environment helpers

**Infrastructure Packages**:

- ✅ **@truss/database**: Supabase types and client
- ✅ **@truss/auth**: Better Auth server config and clients (web/tauri)
- ✅ **@truss/ui**: Platform-agnostic UI components (work in both Vite and Next.js)

**Feature Packages**:

- ✅ **@truss/features**: Modular business logic (organizations, projects, time-tracking)

**Rules**:

- ❌ **NEVER** import Next.js-specific features in shared packages
- ❌ **NEVER** use Node.js-only libraries in shared packages
- ✅ Next.js-specific code belongs in `apps/web/src/lib/` instead
- ✅ Follow the dependency flow: Foundation → Infrastructure → Features → Apps

### Environment Files

- ✅ **Package-specific** `.env.local` files in each app directory
- ❌ **NEVER** create root `.env.local` file (causes variable leakage)
- ✅ Structure:
  ```
  apps/web/.env.local
  apps/precision/.env.local
  apps/momentum/.env.local
  ```

### Authentication

- ✅ **Better Auth** is used (configured in `packages/auth/src/server.ts`)
- ❌ **Supabase Auth is DISABLED** (see `supabase/config.toml` line 123)
- ✅ Reason: Better Auth is framework-agnostic and more flexible

### Database Migrations

- ✅ Types committed **WITH** migrations (atomic changes)
- ✅ Use `bun run db:migration:create` for interactive helper
- ❌ **NEVER** manually commit types without migration
- ✅ Pre-push hook validates SQL syntax + type drift
- ⚠️ If type drift detected: run `bun run db:generate`

## Code Style

### TypeScript

- Use ES modules (`import`/`export`), not CommonJS (`require`)
- Destructure imports when possible: `import { foo } from 'bar'`
- Explicit return types on exported functions
- Use `type` for object shapes, `interface` for extendable contracts

### React

- Functional components only (no class components)
- React 19 features available
- Use `"use client"` directive when needed (Next.js Server Components)

### Imports

```typescript
// Types
import type { ApiResponse, HttpStatus } from "@truss/types/api";
import type { Database } from "@truss/types/database";
import type { Result, Nullable } from "@truss/types/common";

// Utilities
import { formatDate, formatRelativeTime } from "@truss/lib/date";
import { slugify, truncate } from "@truss/lib/string";
import { isValidEmail, isStrongPassword } from "@truss/lib/validation";
import { isTauri, getOS } from "@truss/lib/platform";
import { debounce, sleep } from "@truss/lib/utils";

// Configuration
import { AUTH, URLS, PAGINATION } from "@truss/config/constants";
import { getEnv, isDev, getApiUrl } from "@truss/config/env";
import { features, isFeatureEnabled } from "@truss/config/features";

// Database
import type { Database } from "@truss/database";
import { getSupabaseClient } from "@truss/database/client";

// Authentication
import { auth } from "@truss/auth/server";
import { authClient, useSession } from "@truss/auth/client"; // Shared features & desktop
import { tauriAuthClient } from "@truss/auth/client/tauri"; // Desktop explicit import

// UI Components
import { Button } from "@truss/ui/components/button";
import { cn } from "@truss/ui/lib/utils";

// Business Logic & Features
import { hasPermission, getAppAccess } from "@truss/features/organizations/permissions";
import { useWorkspace, WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import type { WorkspaceContext, AppPermissionLevel } from "@truss/features/organizations/types";

// Web app (Next.js specific)
import { getSupabaseServerClient } from "@/lib/supabase/server";
```

## Architecture

### Monorepo Structure

```
apps/
  web/        - Next.js 15 marketing site (Vercel)
  precision/  - Tauri v2 desktop app (estimation)
  momentum/   - Tauri v2 desktop app (tracking)
packages/
  types/      - Centralized TypeScript types (@truss/types)
  lib/        - Utility functions and helpers (@truss/lib)
  config/     - Configuration and constants (@truss/config)
  database/   - Supabase types and client (@truss/database)
  auth/       - Better Auth server and clients (@truss/auth)
  ui/         - Platform-agnostic UI components (@truss/ui)
  features/   - Business logic features (@truss/features)
  eslint-config/
  typescript-config/
scripts/      - Automation scripts
```

### Tech Stack

- **Web**: Next.js 15 + Tailwind CSS v4 + Better Auth
- **Desktop**: Tauri v2 + React 19 + Vite
- **Database**: Supabase Postgres (Better Auth tables)
- **Build**: Turborepo with remote caching
- **Package Manager**: Bun 1.3.0+
- **Styling**: Tailwind CSS v4 (design tokens)

### Deployment Pipeline

```
Local (any branch) → Staging (develop) → Production (main)
```

- **Local**: `localhost:3000` + local Convex
- **Staging**: TBD
- **Production**: TBD

## Workflow

### Creating a Migration

```bash
# 1. Create migration + types in one command
bun run db:migration:create add_users_table

# 2. Interactive helper will:
#    - Create migration file
#    - Open in editor
#    - Apply locally
#    - Generate types
#    - Format with Prettier

# 3. Commit both files
git add supabase/migrations/ packages/database/src/types.ts
git commit -m "feat: add users table"
```

### Git Hooks

- **Pre-commit**: Auto-formats with Prettier (no ESLint)
- **Pre-push**: Validates migrations + checks type drift
- Bypass with `--no-verify` (not recommended)

### Type Checking

- **Always** run `bun run check-types` after making changes
- CI will fail if types don't match database schema
- Fix drift: `bun run db:generate`

### Changesets (Versioning)

```bash
# 1. Create changeset
bun run changeset
# Select packages, bump type, write summary

# 2. Commit
git add .changeset/
git commit -m "chore: add changeset"

# 3. CI creates "Version Packages" PR
# 4. Merge PR → triggers releases
```

## Repository Etiquette

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `chore/description` - Maintenance

### Commits

- Use conventional commits: `feat:`, `fix:`, `chore:`
- Keep commits atomic and focused
- Reference issues: `fix: resolve #123`

### Merging

- **Merge**, don't rebase (preserves history)
- Squash feature branches when merging to develop
- Keep main/develop clean

### PRs

- Title: conventional commit format
- Description: what changed and why
- CI must pass before merge
- If touching Supabase: migration validation required

## Environment Setup

### Required Tools

- Bun 1.3.0+ (`curl -fsSL https://bun.sh/install | bash`)
- Supabase CLI (`brew install supabase/tap/supabase`)
- Node.js v20.11.0 (see `.nvmrc`)

### Initial Setup

```bash
# 1. Install dependencies
bun install

# 2. Setup environment variables
./scripts/setup-env.sh

# 3. Configure credentials
# Edit .env.local files in each app:
#   - apps/web/.env.local
#   - apps/precision/.env.local
#   - apps/momentum/.env.local
# See docs/ENVIRONMENT.md for detailed setup guide

# 4. Start local Supabase
bun run db:start

# 5. Generate types
bun run db:generate:local
```

**Important**: See [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md) for comprehensive environment
variable documentation.

## Unexpected Behaviors & Warnings

### Port Conflicts

- **Issue**: "EADDRINUSE: address already in use"
- **Fix**: `bun run cleanup-ports`

### Supabase Auth Disabled

- **Warning**: `supabase/config.toml` has `auth.enabled = false`
- **Reason**: Using Better Auth instead (more flexible)
- **Don't** enable Supabase Auth - causes conflicts

### Type Errors After Schema Changes

- **Issue**: TypeScript errors after migration
- **Fix**: `bun run db:generate`
- **Prevention**: Use `bun run db:migration:create` (auto-generates)

### Build Failures

- **Issue**: Builds fail with env errors
- **Fix**: Check `.env.local` exists in affected app
- **Common**: Forgetting to copy `.env.example` → `.env.local`

### Connection Pooling

- **Enabled** in `supabase/config.toml` (port 54329)
- **Mode**: Transaction pooling
- **Limits**: 20 connections per user, 100 max clients

### Turborepo Cache

- **Remote caching enabled** (requires `TURBO_TOKEN`)
- **Local cache**: `.turbo/cache/` (gitignored)
- **Bust cache**: `bun run clean`

## Core Files

### Configuration

- `turbo.json` - Turborepo config (envMode: "strict")
- `supabase/config.toml` - Supabase local config
- `.nvmrc` - Node version (v20.11.0)
- `.editorconfig` - Editor consistency

### Git Hooks

- `.husky/pre-commit` - Prettier formatting
- `.husky/pre-push` - Migration validation

### Database

- `supabase/migrations/` - SQL migration files
- `packages/database/src/types.ts` - Generated types
- `packages/database/src/client.ts` - Browser client
- `supabase/seed.sql` - Seed data

### Auth

- `packages/auth/src/server.ts` - Better Auth config
- `packages/auth/src/client/web.ts` - Web client
- `packages/auth/src/client/tauri.ts` - Tauri desktop client
- `apps/web/app/api/auth/[...all]/route.ts` - Auth API handler

### Scripts

- `scripts/db-migration-helper.sh` - Interactive migration creator
- `scripts/db-check-type-drift.ts` - Type drift validator
- `scripts/db-generate-types.ts` - Type generator

## Documentation

For comprehensive deployment instructions, see **`DEPLOYMENT.md`** (600+ lines, single source of
truth).

For authentication details, see **`docs/AUTHENTICATION.md`**.

## Turborepo & Package Best Practices

This monorepo follows **2025 industry standards** and modern monorepo architecture patterns.

### Package Architecture Principles

#### Single Responsibility Principle

Each package has ONE clear purpose:

- ✅ `@truss/types` - TypeScript types ONLY
- ✅ `@truss/lib` - Pure utility functions ONLY
- ✅ `@truss/config` - Configuration and constants ONLY
- ✅ `@truss/database` - Database types and client ONLY
- ✅ `@truss/auth` - Authentication logic ONLY
- ✅ `@truss/ui` - UI components ONLY
- ✅ `@truss/features` - Business logic features ONLY
- ❌ NEVER mix concerns (e.g., auth logic in UI package)

#### Just-in-Time (JIT) Strategy

We use **JIT packages** (recommended 2025 approach):

```json
{
  "exports": {
    "./components/button": "./src/components/button.tsx" // ← TypeScript source, not compiled
  }
}
```

**Why JIT?**

- Modern bundlers (Turbopack, Vite, Next.js) compile source directly
- No build step needed for internal packages
- Faster development iteration
- Better debugging (source maps from original TS)

**When to use Compiled Packages:**

- Publishing to npm (external packages)
- Need explicit control over output
- Complex build configurations

#### Declaration Files

```typescript
// tsconfig.json
{
  "compilerOptions": {
    "declaration": false,  // ← Disabled for JIT packages
    "declarationMap": false
  }
}
```

**Why disabled?**

- JIT packages don't need `.d.ts` files
- Modern bundlers read TypeScript source directly
- Prevents issues with complex library type references (e.g., Better Auth)
- **Exception**: `@truss/auth` disables declarations due to Better Auth plugin architecture

### Package Structure Standards

#### Required Files

Every package MUST have:

```
packages/my-package/
├── package.json      # Package metadata and exports
├── tsconfig.json     # TypeScript configuration
├── eslint.config.mjs # ESLint configuration
├── src/
│   └── index.ts      # Main entry point
└── README.md         # Package documentation (optional but recommended)
```

#### package.json Structure

```json
{
  "name": "@truss/package-name",
  "version": "0.0.0",
  "private": true, // ← Internal packages are private
  "type": "module", // ← ESM modules
  "exports": {
    ".": "./src/index.ts", // ← Main export
    "./sub-module": "./src/sub-module.ts" // ← Subpath exports
  },
  "scripts": {
    "lint": "eslint . --max-warnings 0",
    "check-types": "tsc --noEmit"
  },
  "peerDependencies": {
    // ← External dependencies
    "react": "^19.1.0"
  },
  "devDependencies": {
    // ← Build tools only
    "@truss/eslint-config": "*",
    "@truss/typescript-config": "*",
    "typescript": "5.9.2"
  }
}
```

**Key Rules:**

- ✅ Use `peerDependencies` for external libraries (React, Supabase, etc.)
- ✅ Use `devDependencies` for build tools (ESLint, TypeScript, etc.)
- ❌ NEVER use `dependencies` in internal packages
- ✅ Use workspace protocol: `"@truss/other-package": "*"`

#### tsconfig.json Structure

```json
{
  "extends": "@truss/typescript-config/react-library.json", // ← Shared base config
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "module": "ESNext", // ← Modern ESM
    "moduleResolution": "Bundler" // ← Bundler-specific resolution
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}
```

**Key Rules:**

- ✅ Extend shared config from `@truss/typescript-config`
- ✅ Use `module: "ESNext"` and `moduleResolution: "Bundler"`
- ❌ NEVER use `NodeNext` module resolution (causes `.js` extension issues)
- ✅ Set `declaration: false` for JIT packages

### Import/Export Patterns

#### Barrel Exports (index.ts)

```typescript
// ✅ GOOD: Re-export everything from a barrel file
// packages/features/src/index.ts
export * from "./organizations";

// packages/features/src/organizations/index.ts
export type * from "./types";
export * from "./permissions";
export * from "./utils";
export * from "./workspace-context";
```

#### Subpath Exports

```json
{
  "exports": {
    ".": "./src/index.ts", // Main export
    "./organizations": "./src/organizations/index.ts", // Subpath
    "./organizations/types": "./src/organizations/types.ts" // Deep subpath
  }
}
```

**Usage:**

```typescript
// ✅ GOOD: Use specific imports
import { hasPermission } from "@truss/features/organizations";
import type { WorkspaceContext } from "@truss/features/organizations/types";

// ❌ BAD: Don't use deep file imports
import { hasPermission } from "@truss/features/src/organizations/permissions";
```

### TypeScript Best Practices

#### Type Inference

Use Better Auth's type inference pattern:

```typescript
// Server (packages/auth/src/server.ts)
export const auth = betterAuth({
  // configuration...
});

// Client (packages/auth/src/client/web.ts)
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "../server";

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<typeof auth>(), // ← Type inference from server
  ],
});
```

**Benefits:**

- Type safety from server to client
- No manual type definitions needed
- Automatic updates when server config changes

#### No Type Hacks

❌ **NEVER use these:**

```typescript
// @ts-ignore
// @ts-expect-error
// @ts-nocheck
// eslint-disable-next-line
```

✅ **Fix the root cause instead:**

- Research the proper API usage
- Check official documentation
- Use correct type inference patterns

### Dependency Management

#### Workspace Dependencies

```json
{
  "peerDependencies": {
    "@truss/auth": "*", // ← Workspace protocol
    "@truss/database": "*"
  }
}
```

**Rules:**

- ✅ Use `"*"` for internal workspace packages
- ✅ Use exact versions or ranges for external packages
- ✅ List packages in alphabetical order

#### Avoiding Circular Dependencies

```
❌ BAD:
@truss/ui → @truss/auth → @truss/features → @truss/ui  (circular!)

✅ GOOD:
apps/web → @truss/features → @truss/auth → @truss/config
                          → @truss/database → @truss/config
                          → @truss/lib
                          → @truss/types → @truss/database
        → @truss/ui → @truss/lib
                  → @truss/types
```

**Rules:**

- ✅ Apps depend on packages (one direction)
- ✅ Packages can depend on other packages (acyclic)
- ❌ NEVER create circular dependencies
- ✅ Use `nx graph` or `turbo graph` to visualize dependencies

### Turborepo Task Configuration

#### Pipeline Best Practices

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"], // ← Wait for dependencies to build first
      "outputs": [".next/**", "dist/**"],
      "env": ["NEXT_PUBLIC_*", "VITE_*"]
    },
    "check-types": {
      "dependsOn": ["^check-types"], // ← Type check dependencies first
      "cache": true // ← Cache results for faster subsequent runs
    }
  }
}
```

**Key Concepts:**

- `^build` = Run build on **dependencies first**
- `dependsOn: ["^build"]` = Topological task execution
- `outputs` = Files to cache for faster rebuilds
- `env` = Environment variables that affect the task

### Common Pitfalls to Avoid

#### ❌ Don't: Mix Platform-Specific Code

```typescript
// ❌ BAD: Next.js code in shared package
import Image from "next/image"; // Don't do this in @truss/ui

// ✅ GOOD: Keep in app directory
// apps/web/src/components/OptimizedImage.tsx
import Image from "next/image";
```

#### ❌ Don't: Use Relative Imports Across Packages

```typescript
// ❌ BAD: Relative import from another package
import { auth } from "../../auth/src/server";

// ✅ GOOD: Use package import
import { auth } from "@truss/auth/server";
```

#### ❌ Don't: Commit Built Files

```gitignore
# ✅ ALWAYS in .gitignore
dist/
.next/
.turbo/
node_modules/
```

### Adding a New Package

**Checklist:**

1. **Create package directory:**

   ```bash
   mkdir -p packages/my-package/src
   ```

2. **Create package.json:**

   ```json
   {
     "name": "@truss/my-package",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "exports": {
       ".": "./src/index.ts"
     },
     "scripts": {
       "lint": "eslint . --max-warnings 0",
       "check-types": "tsc --noEmit"
     },
     "devDependencies": {
       "@truss/eslint-config": "*",
       "@truss/typescript-config": "*",
       "typescript": "5.9.2"
     }
   }
   ```

3. **Create tsconfig.json:**

   ```json
   {
     "extends": "@truss/typescript-config/base.json",
     "compilerOptions": {
       "outDir": "./dist",
       "rootDir": "./src",
       "module": "ESNext",
       "moduleResolution": "Bundler"
     },
     "include": ["src/**/*.ts"],
     "exclude": ["node_modules", "dist"]
   }
   ```

4. **Create eslint.config.mjs:**

   ```javascript
   import { config } from "@truss/eslint-config/react-internal";
   export default config;
   ```

5. **Create src/index.ts:**

   ```typescript
   /**
    * @truss/my-package
    *
    * Package description
    */

   export function myFunction() {
     // Implementation
   }
   ```

6. **Install dependencies:**

   ```bash
   bun install
   ```

7. **Verify setup:**
   ```bash
   cd packages/my-package
   bun run lint
   bun run check-types
   ```

### Quality Standards

Every package MUST:

- ✅ Pass `bun run lint` with 0 warnings
- ✅ Pass `bun run check-types` with 0 errors
- ✅ Have proper exports in `package.json`
- ✅ Use correct peer dependencies
- ✅ Follow Single Responsibility Principle
- ✅ Document all public APIs with JSDoc comments
- ✅ Use proper TypeScript types (no `any`)

### References

- **Turborepo Docs**: https://turborepo.com/docs/core-concepts/internal-packages
- **Better Auth**: https://www.better-auth.com/docs/concepts/typescript
- **Supabase**: https://supabase.com/docs

---

**Last Updated**: 2025-10-11
