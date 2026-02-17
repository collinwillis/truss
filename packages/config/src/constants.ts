/**
 * Application constants shared across all applications.
 */

/**
 * Application metadata.
 */
export const APP_NAME = "Truss";
export const APP_DESCRIPTION = "Project management suite for construction and estimation";
export const APP_VERSION = "0.1.0";

/**
 * Application URLs.
 */
export const URLS = {
  WEB: {
    LOCAL: "http://localhost:3000",
    STAGING: "https://staging.truss.dev",
    PRODUCTION: "https://truss.dev",
  },
  DESKTOP: {
    LOCAL: "http://localhost:1420",
    TAURI_LOCAL: "tauri://localhost",
    TAURI_HTTPS: "https://tauri.localhost",
  },
  DOCS: "https://docs.truss.dev",
  SUPPORT: "https://support.truss.dev",
  GITHUB: "https://github.com/collinwillis/truss",
} as const;

/**
 * Authentication configuration.
 */
export const AUTH = {
  SESSION_DURATION: 60 * 60 * 24 * 7, // 7 days in seconds
  SESSION_UPDATE_AGE: 60 * 60 * 24, // 24 hours
  COOKIE_CACHE_MAX_AGE: 5 * 60, // 5 minutes
  PASSWORD_MIN_LENGTH: 8,
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION: 15 * 60 * 1000, // 15 minutes in milliseconds
} as const;

/**
 * Organization limits.
 */
export const ORGANIZATION = {
  MAX_ORGS_PER_USER: 10,
  MAX_MEMBERS_PER_ORG: 100,
  MAX_NAME_LENGTH: 100,
  MAX_DESCRIPTION_LENGTH: 500,
  DEFAULT_ROLE: "member" as const,
} as const;

/**
 * Database configuration.
 */
export const DATABASE = {
  MAX_POOL_CONNECTIONS: 10,
  IDLE_TIMEOUT: 30000, // 30 seconds
  CONNECTION_TIMEOUT: 2000, // 2 seconds
} as const;

/**
 * File upload limits.
 */
export const UPLOAD = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB in bytes
  MAX_FILES_PER_UPLOAD: 5,
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/gif", "image/webp"],
  ALLOWED_DOCUMENT_TYPES: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
} as const;

/**
 * Pagination configuration.
 */
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  DEFAULT_PAGE: 1,
} as const;

/**
 * Rate limiting configuration.
 */
export const RATE_LIMIT = {
  WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  MAX_REQUESTS: 100,
} as const;

/**
 * Cache durations in seconds.
 */
export const CACHE = {
  SHORT: 60, // 1 minute
  MEDIUM: 300, // 5 minutes
  LONG: 3600, // 1 hour
  VERY_LONG: 86400, // 24 hours
} as const;

/**
 * Validation patterns.
 */
export const PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  USERNAME: /^[a-zA-Z0-9_-]{3,20}$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  PHONE: /^\+?[\d\s-()]+$/,
} as const;

/**
 * Date formats.
 */
export const DATE_FORMATS = {
  FULL: "MMMM d, yyyy",
  SHORT: "MM/dd/yyyy",
  ISO: "yyyy-MM-dd",
  TIME: "h:mm a",
  DATETIME: "MMMM d, yyyy h:mm a",
} as const;

/**
 * UI constants.
 */
export const UI = {
  TOAST_DURATION: 5000, // 5 seconds
  DEBOUNCE_DELAY: 300, // 300ms
  ANIMATION_DURATION: 200, // 200ms
  MOBILE_BREAKPOINT: 768, // pixels
  TABLET_BREAKPOINT: 1024, // pixels
} as const;
