# @truss/features

**Purpose**: Modular business logic features for all applications

## Usage

```typescript
// Organizations and access
import { useWorkspace, WorkspaceProvider, useAppAccess } from "@truss/features/organizations/workspace-context";
import type { WorkspaceContext, OrganizationRole } from "@truss/features/organizations/types";
import type { EffectiveAppAccess } from "@truss/features/access/types";
import { AppAccessSelect, ShareEstimateDialog } from "@truss/features/access";

// Example: gate on the caller's access to an app
function MyComponent() {
  const { workspace } = useWorkspace();
  const { access, hasAccess } = useAppAccess("precision");

  if (!hasAccess) return <div>No access</div>;
  const editsEverything = access === "full" || access === "edit_all";
  return (
    <div>
      {workspace?.organization_name}: {editsEverything ? "edits every estimate" : "limited"}
    </div>
  );
}
```

## What Goes Here

✅ **DO** add:

- Feature-specific business logic
- Multi-step operations
- React context providers and hooks
- Domain-specific utilities
- Feature modules (organizations, projects, time-tracking, etc.)

❌ **DON'T** add:

- UI components (use `@truss/ui`)
- Generic utilities (use `@truss/lib`)
- Type definitions only (use `@truss/types`)
- Configuration (use `@truss/config`)

## Rules

1. **Feature isolation** - Each feature is self-contained in its own directory
2. **Single Responsibility** - One feature = one business domain
3. **Composable** - Features can depend on each other but avoid circular deps
4. **Platform-agnostic** - Must work in both Next.js and Tauri (use "use client" when needed)

## File Structure

```
src/
├── access/                  - Who can see and change what (docs/ACCESS.md)
│   ├── types.ts            - Access vocabulary (app access, item levels)
│   ├── labels.ts           - Every word the access screens use
│   ├── app-access-select.tsx - One Member's access to one app
│   ├── item-access-panel.tsx - Share dialog / People panel body
│   ├── use-item-access.ts  - Convex wiring for one estimate or project
│   └── index.ts            - Barrel export
│
├── admin/                   - Members page and member detail (Owner/Admin)
│
├── organizations/           - Organization & workspace management
│   ├── types.ts            - TypeScript types
│   ├── permissions.ts      - Role labels and legacy level helpers
│   ├── workspace-context.tsx - React context provider
│   └── index.ts            - Barrel export
│
└── index.ts                - Top-level barrel export
```

## Current Features

### Organizations and access

Multi-tenant workspace management with one access setting per app (see `docs/ACCESS.md`).

**Key concepts:**

- Users can belong to multiple organizations
- Each organization member has one role: owner, admin or member
- Owners and Admins have `full` access to both apps
- A Member has one setting per app: `none`, `assigned`, `view_all` or `edit_all`, plus Can edit /
  Can view on the single estimates or projects they were added to
- Personal workspace (no organization) = no access to either app

**Components:**

- `WorkspaceProvider` - React context for current workspace
- `useWorkspace()` - Access workspace data (`precisionAccess`, `momentumAccess`, `role`)
- `useAppAccess(app)` - The caller's access to one app, and whether it lets them in
- `AppAccessSelect`, `ItemAccessPanel`, `ShareEstimateDialog` - The access controls (`./access`)
- `hasPermission()` - Deprecated: compares the legacy none/read/write/admin levels

## Dependencies

- `@truss/auth` (peer) - Authentication and user sessions
- `@truss/database` (peer) - Database operations
- `@truss/config` (peer) - Configuration and constants
- `@truss/lib` (peer) - Utility functions
- `@truss/types` (peer) - Type definitions
- `react` (peer) - For context providers and hooks
