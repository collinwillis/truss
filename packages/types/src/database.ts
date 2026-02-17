/**
 * Database utility types.
 *
 * WHY: Supabase types removed. Convex types are auto-generated
 * in @truss/backend/convex/_generated/dataModel.
 */

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];
