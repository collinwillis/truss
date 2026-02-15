/**
 * Convex HTTP router with Better Auth routes.
 *
 * WHY: Auth requests from desktop apps and the web app are handled
 * directly by Convex HTTP endpoints, eliminating the Next.js proxy.
 *
 * @module
 */

import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
