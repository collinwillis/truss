/// <reference types="vite/client" />

/**
 * Better Auth seeding for the Convex suites.
 *
 * WHY THE COMPONENT IS REGISTERED RATHER THAN STUBBED: the guards resolve the
 * caller through `components.betterAuth.adapter` and `safeGetAuthUser`. Stub
 * either and a test stops proving anything about authorization — every refusal
 * would pass because nobody ever authenticated.
 *
 * The session row is not decoration for the same reason: `safeGetAuthUser`
 * refuses an identity whose session is missing or expired, so a principal seeded
 * without one reads as unauthenticated everywhere.
 *
 * TEST-ONLY. Never import from production code.
 */

import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";

import { components } from "../convex/_generated/api";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";
import type { TestRunner } from "./convexFixtures";

const modules = import.meta.glob("../convex/**/*.*s");
const authModules = import.meta.glob("../convex/betterAuth/**/*.*s");

/** A `t` bound to one principal's session — how a test makes an authenticated call. */
export type Caller = ReturnType<TestRunner["withIdentity"]>;

/** A seeded principal: their Better Auth ids plus a `t` bound to their session. */
export interface Principal {
  userId: string;
  memberId: string;
  /** `t` scoped to this principal's identity — call functions through this. */
  as: Caller;
}

/** Build a test instance with the Better Auth component registered. */
export function authHarness(): TestRunner {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}

/** The `create` argument shape, narrowed to the models these fixtures seed. */
type CreateArgs = FunctionArgs<typeof components.betterAuth.adapter.create>;
type SeedableInput = Extract<
  CreateArgs["input"],
  { model: "user" | "session" | "organization" | "member" }
>;

/** Insert a row into a Better Auth component table. */
async function createAuthRow(t: TestRunner, input: SeedableInput): Promise<{ _id: string }> {
  const created = await t.run(async (ctx) =>
    ctx.runMutation(components.betterAuth.adapter.create, { input })
  );
  return created as { _id: string };
}

/** Seed an organization and return its id. */
export async function seedOrganization(t: TestRunner, slug: string): Promise<string> {
  const org = await createAuthRow(t, {
    model: "organization",
    data: { name: slug, slug, createdAt: Date.now() },
  });
  return org._id;
}

/** Seed a user, their membership in `organizationId`, and a live session. */
export async function seedPrincipal(
  t: TestRunner,
  options: { organizationId: string; role: "owner" | "admin" | "member"; email: string }
): Promise<Principal> {
  const now = Date.now();

  const user = await createAuthRow(t, {
    model: "user",
    data: {
      name: options.email,
      email: options.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const member = await createAuthRow(t, {
    model: "member",
    data: {
      organizationId: options.organizationId,
      userId: user._id,
      role: options.role,
      createdAt: now,
    },
  });

  const session = await createAuthRow(t, {
    model: "session",
    data: {
      userId: user._id,
      token: `token-${options.email}`,
      expiresAt: now + 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    },
  });

  return {
    userId: user._id,
    memberId: member._id,
    as: t.withIdentity({ subject: user._id, sessionId: session._id }),
  };
}

/**
 * A harness whose caller is an organization owner.
 *
 * For the suites that test behaviour rather than authorization: every Precision
 * function now requires a permitted caller, so those tests need SOME identity,
 * and the owner is the one principal guaranteed full access with no
 * `appPermissions` row (see `model/precisionAccess.ts`). Use `t` for fixture
 * seeding and `t.run`, and `as` for every API call.
 */
export async function ownerHarness(): Promise<{ t: TestRunner; as: Caller }> {
  const t = authHarness();
  const organizationId = await seedOrganization(t, "acme");
  const owner = await seedPrincipal(t, {
    organizationId,
    role: "owner",
    email: "owner@acme.test",
  });
  return { t, as: owner.as };
}
