# Tauri Authentication Integration

## Overview

Better Auth integration for Tauri desktop applications with proper CORS support.

## Architecture

### Server Configuration (`packages/auth/src/server.ts`)

- Better Auth server with Tauri plugin
- Trusted origins configuration for CORS
- Email/password and social authentication support
- Organization management and two-factor authentication

### Client Configuration (`packages/auth/src/client/tauri.ts`)

- Standard Better Auth client for Tauri applications
- Token-based authentication in production
- Cookie-based authentication in development

### App-Level Configuration

- **Precision**: `apps/precision/src/lib/auth-client.ts`
- **Momentum**: `apps/momentum/src/lib/auth-client.ts`
- Platform detection for macOS-specific requirements
- Tauri HTTP plugin integration for cookie support

### CORS Handling (`apps/web/app/api/auth/[...all]/route.ts`)

Manual CORS header implementation due to known Better Auth issue with `toNextJsHandler`.

## Key Implementation Details

### Cookies vs Tokens

- **Development**: Cookies work via `http://localhost` origins
- **Production**: Token-based authentication (cookies don't work in Tauri)

### macOS Requirements

```typescript
// Platform detection for macOS
if (isTauri() && platform() === "macos") {
  // Use Tauri HTTP plugin fetch
  customFetchImpl: tauriFetch as typeof fetch;
}
```

### Required Tauri Plugins

```toml
# Cargo.toml
tauri-plugin-http = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-os = "2"
```

## Authentication Flow

### Email/Password

```typescript
// Sign up
await signUp.email({
  email: "user@example.com",
  password: "SecurePassword123!",
  name: "User Name",
});

// Sign in
await signIn.email({
  email: "user@example.com",
  password: "SecurePassword123!",
});

// Session management
const { data: session } = useSession();
```

### OAuth Support

OAuth flows handled via `useBetterAuthTauri` hook with deep link callbacks.

## Environment Variables

```env
# Development (.env.local)
VITE_BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres

# Production
VITE_BETTER_AUTH_URL=https://api.production.com
DATABASE_URL=postgresql://production-connection-string
```

## Troubleshooting

### CORS Errors

Ensure origins are added to both:

1. `trustedOrigins` in auth server configuration
2. `ALLOWED_ORIGINS` in API route handler

### Deep Link Issues

Verify `tauri.conf.json` includes:

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

## References

- [Better Auth Documentation](https://www.better-auth.com/docs)
- [Better Auth Tauri Plugin](https://github.com/daveyplate/better-auth-tauri)
- [Tauri v2 Documentation](https://v2.tauri.app/docs)

---

**Status**: Production Ready **Last Updated**: October 2025
