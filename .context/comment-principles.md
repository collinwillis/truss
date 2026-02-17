# Code Commenting Standards

Professional commenting guidelines for the Truss monorepo, based on Google TypeScript Style Guide
and Silicon Valley open-source best practices.

## Core Principles

### 1. Explain WHY, Not WHAT

**Good:**

```typescript
// Debounce to prevent excessive API calls during rapid user input
const debouncedSearch = debounce(search, 300);
```

**Bad:**

```typescript
// Create debounced search function
const debouncedSearch = debounce(search, 300);
```

### 2. Use JSDoc for All Exported Code

Every exported function, class, type, and interface must have JSDoc documentation.

**Required Format:**

```typescript
/**
 * Brief description in one sentence.
 *
 * @param paramName - Description of what this parameter does
 * @returns Description of what is returned
 */
export function myFunction(paramName: string): ReturnType {
  return result;
}
```

### 3. Keep Comments Concise

Verbose comments create maintenance burden and reduce readability.

**Good:**

```typescript
/**
 * Create a Supabase client for server-side operations.
 *
 * @returns Supabase server client with cookie-based session management
 */
```

**Bad:**

````typescript
/**
 * Create a Supabase client for server-side operations in Next.js.
 *
 * This client is specifically for:
 * - Server Components (reading data)
 * - Server Actions (mutations with revalidation)
 * - API Route Handlers
 *
 * IMPORTANT: Next.js 15 requires `await cookies()` (async API)
 *
 * Usage in Server Component:
 * ```tsx
 * import { getSupabaseServerClient } from '@/lib/supabase/server'
 *
 * export default async function Page() {
 *   const supabase = await getSupabaseServerClient()
 *   const { data } = await supabase.from('projects').select('*')
 *   return <div>{JSON.stringify(data)}</div>
 * }
 * ```
 *
 * @returns Supabase server client with cookie-based session management
 */
````

### 4. No Obvious Comments

Remove comments that merely restate the code.

**Bad:**

```typescript
// Export all constants
export * from "./constants";

// Get database URL from environment
const getDatabaseUrl = () => {
  /* ... */
};
```

**Good:**

```typescript
export * from "./constants";

const getDatabaseUrl = () => {
  /* ... */
};
```

### 5. Professional Tone

No marketing language, emojis (unless user-facing strings), or informal tone.

**Good:**

```typescript
/**
 * Authentication client for Tauri desktop applications with deep link OAuth support.
 */
```

**Bad:**

```typescript
/**
 * ✨ Super awesome auth client for Tauri apps! 🚀
 * This makes authentication a breeze!
 */
```

## Comment Types

### JSDoc Comments (`/** */`)

Use for all exported code that users will interact with.

```typescript
/**
 * Validates email address format.
 *
 * @param email - Email address to validate
 * @returns true if email format is valid
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
```

### Inline Comments (`//`)

Use sparingly for non-obvious implementation decisions.

```typescript
export function processQueue() {
  // Process in reverse order to handle dependencies correctly
  for (let i = queue.length - 1; i >= 0; i--) {
    process(queue[i]);
  }
}
```

### TODO Comments

Acceptable for marking incomplete work or future improvements.

```typescript
// TODO: Implement email provider integration
console.log("Send invitation email:", data);
```

## JSDoc Standards

### Required Elements

1. **Brief description** - One sentence ending with period
2. **@param** - For each parameter (if any)
3. **@returns** - For non-void return types
4. **@throws** - For thrown exceptions (optional but recommended)

### Optional Elements

- `@example` - Only for complex APIs requiring demonstration
- `@see` - Links to related documentation
- `@deprecated` - Mark deprecated code

### Parameter Descriptions

Use hyphens for consistency:

```typescript
/**
 * Calculate project completion percentage.
 *
 * @param completed - Number of completed tasks
 * @param total - Total number of tasks
 * @returns Completion percentage (0-100)
 */
```

### Generic Type Parameters

Document complex generic types:

```typescript
/**
 * Create a typed API client.
 *
 * @template T - The API response type
 * @param endpoint - API endpoint URL
 * @returns Typed API client instance
 */
export function createClient<T>(endpoint: string): Client<T> {
  return new Client<T>(endpoint);
}
```

## Special Cases

### Configuration Objects

Document important configuration, not every property:

```typescript
export const auth = betterAuth({
  database: new Pool({
    connectionString: getDatabaseUrl(),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    autoSignIn: true,
  },

  // Multi-tenant organization management with domain-based auto-join
  organization({
    allowUserToCreateOrganization: true,
    organizationLimit: 10,
    // ...
  }),
});
```

### Type Definitions

Simple types don't need verbose JSDoc:

```typescript
/**
 * User role in the system.
 */
export type UserRole = "admin" | "member" | "guest";

/**
 * API response wrapper.
 */
export type ApiResponse<T> = {
  data: T;
  error: string | null;
  status: number;
};
```

### React Components

Document props and component purpose:

```typescript
/**
 * Display user profile information with edit capability.
 *
 * @param userId - ID of user to display
 * @param onEdit - Callback when edit button is clicked
 */
export function UserProfile({ userId, onEdit }: UserProfileProps) {
  return <div>{/* ... */}</div>;
}
```

### Helper Functions

Private helpers may not need JSDoc, but should have inline comments for non-obvious logic:

```typescript
// Retrieves database URL from environment variables
const getDatabaseUrl = () => {
  if (typeof process !== "undefined") {
    const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (dbUrl) return dbUrl;
  }

  throw new Error("Missing DATABASE_URL environment variable");
};
```

## Anti-Patterns

### ❌ Verbose Usage Examples

Don't include multi-line usage examples in JSDoc unless absolutely necessary.

**Bad:**

````typescript
/**
 * Authentication client for web applications.
 *
 * Usage:
 * ```tsx
 * import { authClient, useSession } from '@truss/auth/client'
 *
 * function MyComponent() {
 *   const { data: session, isPending } = useSession()
 *
 *   if (isPending) return <Loading />
 *   if (!session) return <Login />
 *
 *   return <Dashboard user={session.user} />
 * }
 * ```
 */
````

**Good:**

```typescript
/**
 * Authentication client for web applications with type-safe hooks and session management.
 */
```

### ❌ Redundant Type Information

TypeScript provides type information; don't duplicate it.

**Bad:**

```typescript
/**
 * Get the user's email address.
 *
 * @param user - The user object of type User
 * @returns The email address as a string
 */
export function getEmail(user: User): string {
  return user.email;
}
```

**Good:**

```typescript
/**
 * Extract email address from user object.
 */
export function getEmail(user: User): string {
  return user.email;
}
```

### ❌ Outdated Comments

Comments that don't match the code are worse than no comments.

**Bad:**

```typescript
// Return user's full name
export function getDisplayName(user: User): string {
  return user.email; // Code changed but comment didn't
}
```

**Good:**

```typescript
/**
 * Get display name for user (falls back to email if name not set).
 */
export function getDisplayName(user: User): string {
  return user.name || user.email;
}
```

### ❌ Comment Blocks and ASCII Art

Keep comments clean and simple.

**Bad:**

```typescript
/************************************
 *                                  *
 *    AUTHENTICATION HELPERS        *
 *                                  *
 ************************************/
```

**Good:**

```typescript
// Authentication helpers
```

## File Headers

Don't use verbose file headers. Let the code speak for itself.

**Bad:**

```typescript
/**
 * @file server.ts
 * @description Better Auth server configuration
 * @author Engineering Team
 * @created 2025-01-15
 * @modified 2025-01-20
 */
```

**Good:**

```typescript
/**
 * Authentication server configuration using Better Auth.
 * Provides email/password auth, social providers, two-factor authentication,
 * admin roles, and organization management.
 */
```

## Enforcement

These standards are enforced through:

1. **Code review** - All PRs must follow commenting standards
2. **CLAUDE.md** - Claude Code must review this file before implementing code
3. **Team culture** - Lead by example; refactor verbose comments when you see them

## References

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [TSDoc Specification](https://tsdoc.org/)
- [Better Auth Documentation](https://www.better-auth.com/docs)

---

**Last Updated**: 2025-10-11
