# @truss/auth

**Purpose**: Unified authentication for web and desktop apps using Better Auth

## Quick Start

```typescript
// Server
import { auth } from "@truss/auth/server";
const session = await auth.api.getSession({ headers: request.headers });

// Client (used by desktop apps and shared features)
import { authClient, useSession } from "@truss/auth/client";
const { data: session } = useSession();

// Desktop Client (Tauri)
import { tauriAuthClient, useSession } from "@truss/auth/client/tauri";
await tauriAuthClient.signIn.social({ provider: "github" });
```

## What Goes Here

✅ **DO** add:

- Better Auth server configuration
- Authentication clients (web, desktop)
- Plugin configurations (2FA, admin, organization)
- Auth-related hooks and utilities

❌ **DON'T** add:

- Database schemas (use `supabase/migrations/`)
- UI components (use `@truss/ui`)
- Business logic (use `@truss/features`)
- API endpoints (keep in `apps/*/app/api/`)

## Why Better Auth?

Supabase Auth is **disabled** in this project (`supabase/config.toml:123`) because Better Auth
provides:

1. **Framework-agnostic** - Works with Next.js, Tauri, and any React app
2. **Desktop-first** - Native OAuth flows via deep links for Tauri
3. **Type inference** - Automatic type safety from server to client
4. **Plugin ecosystem** - Easy to extend (2FA, admin, organizations)
5. **Database flexibility** - Uses standard pg Pool, not tied to Supabase SDK

## Common Workflows

### Sign In / Sign Up

```typescript
// Email + Password
await authClient.signIn.email({
  email: "user@example.com",
  password: "password123",
});

await authClient.signUp.email({
  email: "user@example.com",
  password: "password123",
  name: "John Doe",
});

// OAuth (opens browser for Tauri)
await authClient.signIn.social({
  provider: "github",
  callbackURL: "/dashboard",
});

// Sign Out
await authClient.signOut();
```

### Protected Routes (Next.js)

```typescript
import { auth } from "@truss/auth/server";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/auth/sign-in");

  return <div>Welcome, {session.user.email}!</div>;
}
```

### Protected API Routes

```typescript
import { auth } from "@truss/auth/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ data: "Protected" });
}
```

### Client-Side Protection

```typescript
"use client";

import { useSession } from "@truss/auth/client";

function ProtectedComponent() {
  const { data: session, isPending } = useSession();

  if (isPending) return <div>Loading...</div>;
  if (!session) return redirect("/auth/sign-in");

  return <div>Protected content</div>;
}
```

## Plugins

### Two-Factor Authentication (TOTP)

```typescript
// Enable 2FA
await authClient.twoFactor.enable({ password: "user-password" });

// Get QR code for authenticator app
const { data: qrCode } = await authClient.twoFactor.getTotpUri();

// Verify TOTP code
await authClient.twoFactor.verifyTotp({ code: "123456" });

// Disable 2FA
await authClient.twoFactor.disable({ password: "user-password" });
```

### Organization Management

```typescript
// Create organization
const org = await authClient.organization.create({
  name: "My Company",
  slug: "my-company",
});

// Invite members
await authClient.organization.inviteMember({
  organizationId: org.id,
  email: "user@example.com",
  role: "member", // owner, admin, member, guest
});

// Get active organization
const { data: activeOrg } = useActiveOrganization();

// List user's organizations
const { data: orgs } = useListOrganizations();

// Switch organization
await authClient.organization.setActive({ organizationId: "org-id" });
```

**Organization Roles:**

- `owner` - Full control (delete org, manage billing)
- `admin` - Manage members, settings, app permissions
- `member` - Default role, controlled by app permissions
- `guest` - Limited access, requires explicit permissions

### Admin Roles

```typescript
// Check if user is admin
const { data: isAdmin } = authClient.admin.isAdmin();

if (isAdmin) {
  // Show admin UI
}
```

## Type Inference

Better Auth provides **automatic type inference** from server to client:

```typescript
// Server (packages/auth/src/server.ts)
export const auth = betterAuth({
  user: {
    additionalFields: {
      role: { type: "string" },
      metadata: { type: "json" },
    },
  },
});

// Client (packages/auth/src/client/tauri.ts)
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "../server";

export const tauriAuthClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
});

// Usage - fully typed!
const { data: session } = useSession();
console.log(session.user.role); // ✅ TypeScript knows this exists
```

**Custom organization fields are also typed:**

```typescript
const { data: org } = useActiveOrganization();
console.log(org?.allowedDomains); // ✅ Type-safe!
console.log(org?.autoJoinEnabled); // ✅ Type-safe!
```

## Platform-Specific Clients

### Tauri Client (`client/tauri.ts`)

For desktop apps:

- Tauri HTTP client for CORS handling
- OAuth via deep links (`truss://callback`)
- Opens system browser, returns to app

```typescript
import { tauriAuthClient } from "@truss/auth/client/tauri";
await tauriAuthClient.signIn.social({ provider: "github" });
// → Opens browser → User signs in → Deep link: truss://callback?token=...
```

**Deep link configuration** in `tauri.conf.json`:

```json
{
  "identifier": "com.forerelic.truss",
  "deepLinks": {
    "schemes": ["truss"]
  }
}
```

## Environment Setup

### Required Variables

```bash
# Server
DATABASE_URL="postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres"
BETTER_AUTH_SECRET="your-secret-key"  # Generate: openssl rand -base64 32
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# OAuth (optional)
GITHUB_CLIENT_ID="github-client-id"
GITHUB_CLIENT_SECRET="github-client-secret"
GOOGLE_CLIENT_ID="google-client-id"
GOOGLE_CLIENT_SECRET="google-client-secret"
```

### Database Connection

Better Auth uses a PostgreSQL connection pool (**not** Supabase SDK):

```typescript
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  }),
});
```

## Security Best Practices

1. **Secure cookies in production**:

   ```typescript
   advanced: {
     useSecureCookies: process.env.NODE_ENV === "production",
   }
   ```

2. **Require email verification** (production):

   ```typescript
   emailAndPassword: {
     requireEmailVerification: true,
     autoSignIn: false,
   }
   ```

3. **Use strong secrets**: Generate with `openssl rand -base64 32`

4. **Rate limit auth endpoints**: Use middleware or Vercel Rate Limit

5. **Validate on server**: Never trust client-side session checks alone

## Troubleshooting

### "Missing DATABASE_URL environment variable"

**Fix**: Set `DATABASE_URL` in `.env.local`:

```bash
DATABASE_URL="postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres"
```

### OAuth redirect not working

1. Check `NEXT_PUBLIC_APP_URL` is set correctly
2. Verify provider callback URLs match (e.g., `http://localhost:3000/api/auth/callback/github`)
3. For Tauri, ensure deep link scheme is registered in `tauri.conf.json`

### "Session not found" errors

1. Check cookies are enabled in browser
2. Verify `BETTER_AUTH_SECRET` is consistent across deploys
3. For cross-domain, enable `crossSubDomainCookies`

### Type errors with `user.role` or custom fields

**Fix**: Use type inference:

```typescript
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "../server";

export const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
});
```

### Tauri OAuth not working

1. Verify deep link scheme matches server config and `tauri.conf.json`
2. Check Tauri has permission: `"shell": { "open": true }`
3. Test deep link: `open truss://callback?token=test`

## Database Schema

Better Auth **automatically creates and manages** these tables:

- `user` - User accounts
- `session` - Active sessions
- `account` - OAuth provider accounts
- `verification` - Email verification tokens
- `twoFactor` - 2FA TOTP secrets
- `organization` - Workspace/team data
- `organizationMember` - Membership relationships
- `invitation` - Pending invitations

**Important**: These are managed by Better Auth, not Supabase migrations.

## Resources

- [Better Auth Docs](https://www.better-auth.com/docs)
- [TypeScript Guide](https://www.better-auth.com/docs/concepts/typescript)
- [Plugin Documentation](https://www.better-auth.com/docs/plugins)
- [Tauri Plugin](https://github.com/daveyplate/better-auth-tauri)

## Dependencies

- `better-auth` (peer) - Core authentication library
- `@daveyplate/better-auth-tauri` (peer) - Tauri desktop support
- `pg` (peer) - PostgreSQL connection pool
- `react` (peer) - React 19.1.0+ for hooks
- `@truss/config` (peer) - Environment configuration
- `@truss/database` (peer) - Database types
- `@truss/types` (peer) - Shared TypeScript types
