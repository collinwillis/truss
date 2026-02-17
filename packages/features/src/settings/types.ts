/**
 * Settings feature types
 */

/**
 * Available settings sections
 */
export type SettingsSection = "profile" | "account" | "preferences" | "notifications";

/**
 * Theme preference options
 */
export type ThemePreference = "light" | "dark" | "system";

/**
 * User profile update data
 */
export interface ProfileUpdateData {
  name?: string;
  email?: string;
  image?: string;
}

/**
 * Account settings data
 */
export interface AccountSettingsData {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

/**
 * User preferences data
 */
export interface PreferencesData {
  theme: ThemePreference;
  language?: string;
  timezone?: string;
}
