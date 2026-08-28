/**
 * Common utility types for all applications.
 */

/**
 * Make all properties optional recursively.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Flatten type to improve IDE intellisense.
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

/**
 * Extract promise type.
 */
export type Await<T> = T extends Promise<infer U> ? U : T;

/**
 * Make specific keys required.
 */
export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Make specific keys optional.
 */
export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Nullable type.
 */
export type Nullable<T> = T | null;

/**
 * Optional type (nullable or undefined).
 */
export type Optional<T> = T | null | undefined;

/**
 * Extract union of all values from an object type.
 */
export type ValueOf<T> = T[keyof T];

/**
 * Result type pattern for operations that can fail.
 */
export type Result<T, E = Error> =
  { ok: true; value: T; error?: never } | { ok: false; value?: never; error: E };
