/**
 * Better Auth adapter for the Local Install component.
 *
 * WHY: Local Install requires adapter functions to be exported from
 * the component so Better Auth can read/write auth tables.
 *
 * @module
 */

import { createApi } from "@convex-dev/better-auth";
import schema from "./schema";
import { createAuthOptions } from "../auth";

export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany } =
  createApi(schema, createAuthOptions);
