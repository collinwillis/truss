# Authentication Architecture

This document explains the authentication setup for the Truss monorepo, which uses **Better Auth**
(not Supabase Auth) with a Next.js authentication server and Supabase PostgreSQL database.

## Overview

```mermaid
graph TD
    A[Next.js Web App] -->|Hosts| B[Better Auth Server]
    C[Precision Desktop] -->|HTTPS/CORS| B
    D[Momentum Desktop] -->|HTTPS/CORS| B
    B -->|pg Pool| E[Supabase PostgreSQL]
    B -->|OAuth| F[GitHub/Google]
    C -->|Deep Links| G[OAuth Callback truss://]
    D -->|Deep Links| G

    style B fill:#22c55e,stroke:#16a34a,stroke-width:2px
    style E fill:#3ecf8e,stroke:#10b981,stroke-width:2px
```

**Important**: Supabase Auth is **DISABLED** in `supabase/config.toml` (line 123). We use Better
Auth for framework-agnostic authentication.

## Architecture Components

### 1. Better Auth Server (Next.js)

The Next.js application serves dual purposes:

- **Marketing website** for downloading desktop apps
- **Centralized authentication server** for all applications (web + desktop)

**Location**: `apps/web/app/api/auth/[...all]/route.ts`

**Configuration**: `packages/auth/src/server.ts`

**Features**:

- Email/password authentication
- OAuth providers (GitHub, Google)
- Two-factor authentication (TOTP)
- Admin role management
- Organization/team management with custom fields
- Tauri deep link support (`@daveyplate/better-auth-tauri`)
- Connection pooling via `pg` Pool (10 max connections)
- Session management (7-day expiry, 5-minute cookie cache)

### 2. Database Connection

Better Auth uses **pg Pool** for efficient connection pooling:

```typescript
database: new Pool({
  connectionString: DATABASE_URL,
  max: 10, // Maximum connections
  idleTimeoutMillis: 30000, // 30s idle timeout
  connectionTimeoutMillis: 2000, // 2s connection timeout
});
```

**Environment Variables** (priority order):

1. `DATABASE_URL` (primary)
2. `SUPABASE_DB_URL` (fallback for backward compatibility)

**Recommended for Production**: Use Supabase transaction pooler URL:

```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true
```

### 3. Tauri Desktop Apps

Both Precision and Momentum connect to the Better Auth server via CORS:

- **Local Development**: `http://localhost:3000`
- **Staging**: `https://staging.truss.forerelic.com`
- **Production**: `https://truss.forerelic.com`

**Deep Link Scheme**: `truss://` (configured in `tauri.conf.json`)

**Plugin**: `@daveyplate/better-auth-tauri` handles OAuth flows and session persistence via cookies
through Tauri's HTTP Plugin.

### 4. Organization Management

Better Auth organization plugin provides multi-tenant workspaces:

**Roles**:

- `owner`: Full control of organization + all apps
- `admin`: Can manage members + set app permissions
- `member`: Default role, app permissions control access
- `guest`: Limited access, must have explicit app permissions

**Custom Fields** (email domain auto-join, like Slack):

```typescript
allowedDomains: string[]  // ["company.com", "acme.org"]
autoJoinEnabled: boolean  // Auto-add users with matching domains
```

**User Limits**:

- Max organizations per user: 10
- Users can switch between organizations
- App-specific permissions managed separately

## Setup Guide

### Prerequisites

1. **Supabase Project** (for PostgreSQL database)
2. **Bun** (`curl -fsSL https://bun.sh/install | bash`)
3. **Node.js** v20.11.0 (see `.nvmrc`)
4. **Supabase CLI** (`brew install supabase/tap/supabase`)

### Local Development

#### 1. Start Supabase

```bash
bun run db:start  # Start local Supabase on port 54321
```

#### 2. Environment Variables

**⚠️ CRITICAL**: Use **`.env.local`** files (NOT `.env`). The `.env` pattern is too easily committed
to git.

**Web App** (`apps/web/.env.local`):

```env
# Application URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Database (use local Supabase connection pooler for testing)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres

# Better Auth secret (generate with: openssl rand -base64 32)
BETTER_AUTH_SECRET=your-secret-key-here

# Supabase public config
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-local-anon-key

# OAuth (optional for local dev)
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-secret
```

**Desktop Apps** (`apps/precision/.env.local`, `apps/momentum/.env.local`):

```env
# Auth server URL (points to Next.js app)
VITE_API_BASE_URL=http://localhost:3000

# Supabase public config (must match web app)
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=your-local-anon-key

# App metadata
VITE_APP_NAME=Precision  # or Momentum
VITE_APP_VERSION=0.1.0

# Development/debug
VITE_DEBUG_MODE=true
VITE_DEBUG_AUTH=true
```

**Setup Script**:

```bash
# Copy example files
cp apps/web/.env.example apps/web/.env.local
cp apps/precision/.env.example apps/precision/.env.local
cp apps/momentum/.env.example apps/momentum/.env.local

# Edit each file with your values
```

#### 3. Run Migrations

```bash
bun run db:reset       # Reset and apply all migrations
bun run db:generate    # Generate TypeScript types
```

#### 4. Start Development

```bash
# Option 1: Start individual app (auto-starts web server)
bun run dev:precision  # Starts Next.js + Vite + Tauri
bun run dev:momentum   # Starts Next.js + Vite + Tauri

# Option 2: Start web app only
bun run dev:web

# Option 3: Start all (separate terminals)
bun run dev:web        # Terminal 1
bun run tauri:dev      # Terminal 2 (from precision or momentum dir)
```

The `beforeDevCommand` in `tauri.conf.json` automatically:

- Waits for Next.js server on port 3000
- Starts Vite dev server on port 1420
- Launches Tauri app

### Production Deployment

#### 1. Deploy Next.js to Vercel

**Set Environment Variables in Vercel Dashboard** (Project → Settings → Environment Variables):

```env
# Application URL
NEXT_PUBLIC_APP_URL=https://truss.forerelic.com

# Database (use transaction pooler for production!)
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true

# Better Auth secret (MUST be different from dev/staging!)
BETTER_AUTH_SECRET=<generate-unique-secret-with-openssl-rand-base64-32>

# Supabase public config
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# OAuth (optional)
GITHUB_CLIENT_ID=your-production-github-client-id
GITHUB_CLIENT_SECRET=your-production-github-secret
GOOGLE_CLIENT_ID=your-production-google-client-id
GOOGLE_CLIENT_SECRET=your-production-google-secret
```

**Scopes**: Set each variable to `Production`, `Preview`, and `Development` as needed.

**Deploy**:

```bash
git push origin main  # Vercel auto-deploys via Git integration
```

#### 2. Build Desktop Apps for Production

**Update Environment** (`apps/precision/.env.production`, `apps/momentum/.env.production`):

```env
VITE_API_BASE_URL=https://truss.forerelic.com
VITE_SUPABASE_URL=https://[project-ref].supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
VITE_APP_NAME=Precision  # or Momentum
VITE_APP_VERSION=1.0.0
VITE_DEBUG_MODE=false
VITE_DEBUG_AUTH=false
```

**Build**:

```bash
# Via GitHub Actions (recommended)
git tag precision-v1.0.0
git push origin precision-v1.0.0
# Triggers .github/workflows/release-desktop.yml

# Or manually
cd apps/precision
bun run build
bun run tauri build
```

## Authentication Flow

### 1. Email/Password Authentication

```mermaid
sequenceDiagram
    participant U as User
    participant T as Tauri App
    participant A as Better Auth API
    participant P as pg Pool
    participant D as Supabase PostgreSQL

    U->>T: Enter credentials
    T->>A: POST /api/auth/sign-in
    A->>P: Get connection
    P->>D: Query user + verify password
    D-->>P: User data
    P-->>A: Release connection
    A->>A: Create session + sign cookie
    A-->>T: Set-Cookie + session data
    T->>T: Store session (via Tauri HTTP)
    T-->>U: Authenticated ✓
```

### 2. OAuth Authentication (GitHub/Google)

```mermaid
sequenceDiagram
    participant U as User
    participant T as Tauri App
    participant A as Better Auth API
    participant O as OAuth Provider (GitHub)
    participant D as Database

    U->>T: Click "Sign in with GitHub"
    T->>A: GET /api/auth/sign-in/github
    A->>O: Redirect to OAuth authorize
    O->>U: Show authorization prompt
    U->>O: Click "Authorize"
    O->>A: Callback with authorization code
    A->>O: Exchange code for access token
    O-->>A: Access token + user profile
    A->>D: Create/update user + session
    A->>T: Deep link: truss://auth/callback?token=...
    Note over T: @daveyplate/better-auth-tauri<br/>handles deep link
    T->>T: Complete auth flow + store session
    T-->>U: Authenticated ✓
```

### 3. Session Management

**Session Lifecycle**:

- **Duration**: 7 days (`expiresIn: 60 * 60 * 24 * 7`)
- **Update Frequency**: 24 hours (`updateAge: 60 * 60 * 24`)
- **Cookie Cache**: 5 minutes (`cookieCache.maxAge: 5 * 60`)
- **Secure Cookies**: Production only (`useSecureCookies: process.env.NODE_ENV === "production"`)

**Tauri Session Persistence**:

- Handled automatically by `@daveyplate/better-auth-tauri`
- Uses Tauri HTTP Plugin with cookie support
- No custom storage needed

## API Endpoints

Better Auth provides these endpoints under `/api/auth/`:

### Authentication

- `POST /sign-up` - Register new user
- `POST /sign-in` - Sign in with email/password
- `POST /sign-out` - Sign out
- `GET /get-session` - Get current session
- `POST /verify-email` - Verify email address
- `POST /forgot-password` - Request password reset
- `POST /reset-password` - Reset password

### OAuth

- `GET /sign-in/github` - GitHub OAuth flow
- `GET /sign-in/google` - Google OAuth flow

### User Management

- `POST /update-user` - Update user profile
- `POST /delete-user` - Delete account

### Two-Factor Authentication

- `POST /two-factor/enable` - Enable 2FA
- `POST /two-factor/verify` - Verify 2FA code
- `POST /two-factor/disable` - Disable 2FA

### Organization Management

- `POST /organization/create` - Create organization
- `GET /organization/list` - List user's organizations
- `POST /organization/invite` - Invite member
- `POST /organization/set-active` - Switch active organization
- `POST /organization/update` - Update organization settings

### Admin

- `POST /admin/set-role` - Set user role (admin only)
- `POST /admin/list-users` - List all users (admin only)

## CORS Configuration

The API route (`apps/web/app/api/auth/[...all]/route.ts`) includes CORS headers for desktop app
access:

**Allowed Origins**:

```typescript
const allowedOrigins = [
  "http://localhost:1420", // Tauri dev server
  "http://localhost:1421", // Alternative Tauri port
  "tauri://localhost", // Tauri production
  "https://tauri.localhost", // Tauri production HTTPS
  process.env.NEXT_PUBLIC_APP_URL, // Production web URL
];
```

**CORS Headers**:

- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Accept`
- `Access-Control-Allow-Origin: <origin>` (dynamic based on request)

**Development Mode**: Allows all `localhost` origins for easier development.

## Deep Links Configuration

Both Tauri apps use the `truss://` scheme for OAuth callbacks:

**`tauri.conf.json`**:

```json
{
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["truss"]
      }
    }
  }
}
```

**Better Auth Server Plugin**:

```typescript
tauri({
  scheme: "truss", // Must match tauri.conf.json
  callbackURL: "/", // Post-auth redirect
  successText: "Authentication successful! You can close this window.",
  debugLogs: process.env.NODE_ENV === "development",
});
```

**Tauri App Hook** (`useBetterAuthTauri` from `@daveyplate/better-auth-tauri/react`):

```typescript
useBetterAuthTauri({
  authClient: tauriAuthClient,
  scheme: "truss",
  debugLogs: import.meta.env.DEV,
  onSuccess: (callbackURL) => {
    console.log("✅ Auth successful");
    // Navigate to dashboard or callback URL
  },
  onError: (error) => {
    console.error("❌ Auth error:", error);
  },
});
```

## Security Considerations

### 1. Connection Pooling

Better Auth uses `pg` Pool for efficient database connections:

- **Max connections**: 10 (prevents exhaustion)
- **Idle timeout**: 30 seconds
- **Connection timeout**: 2 seconds
- **Production**: Use Supabase transaction pooler URL

### 2. Supabase Auth Disabled

Supabase Auth is explicitly disabled in `supabase/config.toml`:

```toml
[auth]
enabled = false  # Using Better Auth instead
```

**Why?**

- Better Auth is framework-agnostic (works in Next.js + Tauri)
- More flexible plugin system
- No conflicts with Supabase Auth hooks/triggers

### 3. Secure Token Storage

- **Web**: Cookies with `httpOnly` and `secure` flags (production)
- **Desktop**: Handled by `@daveyplate/better-auth-tauri` via Tauri HTTP Plugin

### 4. Environment Variables

- ✅ **Use `.env.local`** (gitignored) - NOT `.env`
- ✅ **Different secrets per environment** (dev/staging/production)
- ✅ **Transaction pooler URL for production**
- ❌ **Never commit `.env.local`** to git
- ❌ **Never expose service role keys**

### 5. PKCE Flow

Desktop apps use PKCE (Proof Key for Code Exchange) for OAuth:

- More secure for public clients (no client secret needed)
- Better Auth + Tauri plugin handle PKCE automatically

### 6. Admin Role Protection

Admin-only operations are protected by the Better Auth admin plugin:

```typescript
import { authClient } from "@truss/auth/client";

const { data: session } = authClient.useSession();
const isAdmin = session?.user?.role === "admin";
```

## Type Safety

Better Auth provides full TypeScript type inference:

**Server Types**:

```typescript
import type { auth } from "@truss/auth/server";

// Infer types from server config
type User = typeof auth.$Infer.User;
type Session = typeof auth.$Infer.Session;
```

**Client Types**:

```typescript
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "./server";

// Infer additional user fields
const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
});
```

**Organization Types**:

```typescript
import { inferOrgAdditionalFields } from "better-auth/client/plugins";

// Infer organization custom fields (allowedDomains, autoJoinEnabled)
organizationClient({
  schema: inferOrgAdditionalFields<typeof auth>(),
});
```

## Troubleshooting

### Common Issues

#### 1. "Failed to load resource: Could not connect to the server"

**Symptoms**: Desktop app can't reach auth server

**Solution**:

```bash
# Check Next.js server is running
curl http://localhost:3000/api/auth/get-session

# Verify desktop app env
cat apps/precision/.env.local | grep VITE_API_BASE_URL
# Should be: VITE_API_BASE_URL=http://localhost:3000
```

#### 2. OAuth redirect not working

**Symptoms**: OAuth flow opens browser but doesn't return to app

**Solution**:

- Verify deep link scheme matches: `truss://` in both `tauri.conf.json` and Better Auth config
- Check OAuth provider callback URL in GitHub/Google console
- Enable debug logs: `VITE_DEBUG_AUTH=true`

#### 3. CORS errors

**Symptoms**: "Access-Control-Allow-Origin" errors in console

**Solution**:

```typescript
// Verify origin is allowed in apps/web/app/api/auth/[...all]/route.ts
const allowedOrigins = [
  "http://localhost:1420", // ← Check this matches your Vite port
  // ...
];
```

#### 4. Database connection errors

**Symptoms**: "Connection timeout" or "Too many connections"

**Solution**:

```bash
# Production: Use transaction pooler URL
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true

# Check pool config in packages/auth/src/server.ts
max: 10,  # Max connections (increase if needed)
```

#### 5. Session not persisting

**Symptoms**: User logged out after refresh

**Solution**:

- Verify `useBetterAuthTauri` hook is in App component root
- Check Tauri HTTP Plugin is enabled
- Enable debug: `debugLogs: true` in `useBetterAuthTauri`

### Debug Mode

Enable comprehensive debug logging:

**Web App** (`apps/web/.env.local`):

```env
NODE_ENV=development
```

**Desktop Apps** (`apps/precision/.env.local`):

```env
VITE_DEBUG_MODE=true
VITE_DEBUG_AUTH=true
```

**Better Auth Server**:

- Already logs in development mode
- Check server console for API requests

**Tauri Console**:

```bash
# macOS
~/Library/Logs/dev.truss.precision/

# Windows
%APPDATA%\dev.truss.precision\logs\

# Linux
~/.local/share/dev.truss.precision/logs/
```

## Testing Authentication

### Local Testing Checklist

- [ ] Start Supabase: `bun run db:start`
- [ ] Start web app: `bun run dev:web`
- [ ] Start desktop app: `bun run dev:precision`
- [ ] Test sign-up with email/password
- [ ] Verify user in Supabase Studio: `bun run db:studio`
- [ ] Test sign-in with same credentials
- [ ] Test OAuth flow (GitHub/Google)
- [ ] Test session persistence (close/reopen app)
- [ ] Test sign-out

### Production Testing Checklist

- [ ] Deploy to Vercel with production env vars
- [ ] Build desktop app with production env
- [ ] Test all auth flows (email, GitHub, Google)
- [ ] Verify deep links work (OAuth callback)
- [ ] Test session persistence
- [ ] Check CORS with production URL
- [ ] Verify database connections use pooler URL

## Migration from Other Auth Systems

If migrating from another authentication system:

1. **Export user data** from old system (CSV, SQL dump)
2. **Transform to Better Auth schema**:

   ```sql
   -- user table
   id, email, emailVerified, name, image, createdAt, updatedAt, role, metadata

   -- session table
   id, userId, expiresAt, token, ipAddress, userAgent
   ```

3. **Import to Supabase** using Better Auth migration tools
4. **Update user passwords**: Require reset on first login if hashing changed
5. **Migrate OAuth connections**: Link existing OAuth accounts to Better Auth users

## Support

For issues or questions:

- **Better Auth Docs**: https://better-auth.com
- **Better Auth Tauri Plugin**: https://github.com/DaveyPlate/better-auth-tauri
- **Tauri Docs**: https://tauri.app
- **Supabase Docs**: https://supabase.com/docs
- **GitHub Issues**: Create issue in this repository

---

**Last Updated**: 2025-10-11 **Maintainer**: Claude Code **Better Auth Version**: Latest (check
`packages/auth/package.json`)
