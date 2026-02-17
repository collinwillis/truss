import { NextRequest, NextResponse } from "next/server";

// Allowed origins for CORS (development + production)
const allowedOrigins = [
  "http://localhost:1420", // Tauri apps (Precision & Momentum)
  "http://localhost:3000", // Next.js web app
  "https://localhost:1420", // Tauri apps (HTTPS)
];

const corsOptions = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Name",
};

export function middleware(request: NextRequest) {
  // Get the origin from the request
  const origin = request.headers.get("origin") ?? "";
  const isAllowedOrigin = allowedOrigins.includes(origin);

  // Handle preflight OPTIONS requests
  const isPreflight = request.method === "OPTIONS";

  if (isPreflight) {
    const preflightHeaders = {
      ...(isAllowedOrigin && { "Access-Control-Allow-Origin": origin }),
      ...corsOptions,
    };
    return NextResponse.json({}, { headers: preflightHeaders });
  }

  // Handle simple requests
  const response = NextResponse.next();

  if (isAllowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
  }

  Object.entries(corsOptions).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

// Apply middleware only to API routes, excluding auth routes
// Better Auth handles its own CORS through trustedOrigins configuration
export const config = {
  matcher: [
    "/api/((?!auth).*)", // Exclude /api/auth routes as Better Auth handles its own CORS
  ],
};
