"use client";

import { useState } from "react";
import { tauriAuthClient } from "@truss/auth/client/tauri";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { cn } from "@truss/ui/lib/utils";
import { Eye, EyeOff, Check, X, Loader2, ArrowRight } from "lucide-react";

interface AuthScreenProps {
  onSuccess?: () => void;
  appName: string;
}

/**
 * The sign-in window for the desktop apps.
 *
 * ⚠️ IT MUST FIT THE SMALLEST WINDOW WITHOUT SCROLLING. Both apps allow a
 * 1000x600 window, and a sign-in form that scrolls reads as a web page placed
 * inside an app. The previous version was exactly that: a gradient background,
 * a floating card with a heavy shadow, 44px touch-sized inputs, a marketing
 * tagline, and a Terms of Service line that linked to no terms. It measured
 * ~827px at the default 800px window and ~980px in sign-up.
 *
 * Built the way native desktop sign-ins are built (Linear, Slack, Figma,
 * Raycast): one narrow column centred on the window's own background, no card,
 * and the design system's own control sizes. `@truss/ui` already encodes macOS
 * controls; this screen uses its Large size (28px) for emphasis rather than
 * overriding to web sizes. "Forgot password?" sits beside its field's label,
 * the convention that saves a row.
 *
 * Budget, measured against the tokens: sign-in ~360px, and the tallest state —
 * sign-up with the password checklist AND an error showing — ~540px including
 * the title-bar inset, inside 600. The top inset is the overlay title bar's
 * height, so nothing ever sits under the traffic lights.
 */
export function AuthScreen({ onSuccess, appName }: AuthScreenProps) {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot-password" | "reset-password">(
    "signin"
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // UI state
  const [showPassword, setShowPassword] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  // Animation state
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Password validation
  const passwordChecks = {
    length: password.length >= 8,
    lowercase: /[a-z]/.test(password),
    uppercase: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
  };

  const passwordStrength = Object.values(passwordChecks).filter(Boolean).length;
  const isPasswordValid = mode === "signin" || passwordStrength >= 3;

  // Clear the banners when the mode changes.
  //
  // Adjusted during render rather than in an effect: an effect would paint the previous mode's
  // error for one frame and cost every render of this screen a second pass. This is React's
  // documented shape for "reset some state when a prop changes".
  const [bannerMode, setBannerMode] = useState(mode);
  if (bannerMode !== mode) {
    setBannerMode(mode);
    setError(null);
    setSuccessMessage(null);
  }

  /** Handles signin and signup form submission. */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      setError("Please enter your email and password");
      return;
    }

    if (mode === "signup" && !name) {
      setError("Please enter your name");
      return;
    }

    if (mode === "signup" && !isPasswordValid) {
      setError("Please choose a stronger password");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (mode === "signup") {
        const { error } = await tauriAuthClient.signUp.email({
          email,
          password,
          name,
        });

        if (error) {
          setError(error.message || "Failed to create account");
          return;
        }
      } else {
        const { error } = await tauriAuthClient.signIn.email({
          email,
          password,
          rememberMe,
        });

        if (error) {
          setError(error.message || "Failed to sign in");
          return;
        }
      }

      setTimeout(() => {
        onSuccess?.();
      }, 500);
    } catch (err) {
      console.error("Auth error:", err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  /** Request a password reset email. */
  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      setError("Please enter your email address");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { error } = await tauriAuthClient.$fetch("/request-password-reset", {
        method: "POST",
        body: { email },
      });

      if (error) {
        setError(error.message || "Failed to send reset email");
        return;
      }

      setMode("reset-password");
      setSuccessMessage("Check your email for a password reset link. Enter the token below.");
    } catch (err) {
      console.error("Forgot password error:", err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  /** Reset password with token and new password. */
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!resetToken) {
      setError("Please enter the reset token from your email");
      return;
    }

    if (!newPassword || newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { error } = await tauriAuthClient.resetPassword({
        newPassword,
        token: resetToken,
      });

      if (error) {
        setError(error.message || "Failed to reset password");
        return;
      }

      setResetToken("");
      setNewPassword("");
      setMode("signin");
      setSuccessMessage("Password reset successfully. Sign in with your new password.");
    } catch (err) {
      console.error("Reset password error:", err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  /** Smoothly transitions between modes. */
  const switchMode = (next: typeof mode) => {
    setIsTransitioning(true);
    setTimeout(() => {
      setMode(next);
      setIsTransitioning(false);
    }, 150);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-8 pt-11 pb-6">
      <div
        className={cn(
          "w-full max-w-[300px] transition-opacity duration-150",
          isTransitioning && "opacity-0"
        )}
      >
        {/* The app, and the one thing this window is for */}
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
            <div className="h-5 w-5 rounded-md bg-primary" />
          </div>
          <h1 className="text-title2 font-semibold text-foreground">
            {mode === "signin" && `Sign in to ${appName}`}
            {mode === "signup" && `Create your ${appName} account`}
            {mode === "forgot-password" && "Reset your password"}
            {mode === "reset-password" && "Enter new password"}
          </h1>
          <p className="mt-1 text-callout text-muted-foreground">
            {mode === "signin" && "Sign in to continue to your workspace"}
            {mode === "signup" && "Get started with your free account"}
            {mode === "forgot-password" && "Enter your email and we'll send you a reset link"}
            {mode === "reset-password" &&
              "Paste the token from your email and choose a new password"}
          </p>
        </div>

        {successMessage && (
          <div className="mb-3 rounded-lg bg-success/10 px-3 py-2">
            <p className="text-callout text-success-text">{successMessage}</p>
          </div>
        )}

        {/* ── Sign in / sign up ── */}
        {(mode === "signin" || mode === "signup") && (
          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === "signup" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  disabled={isLoading}
                  className="h-7"
                  autoComplete="name"
                  required={mode === "signup"}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={isLoading}
                className="h-7"
                autoComplete="email"
                required
                autoFocus={mode === "signin"}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                {mode === "signin" && (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-callout font-normal text-muted-foreground hover:text-foreground"
                    onClick={() => switchMode("forgot-password")}
                    disabled={isLoading}
                  >
                    Forgot password?
                  </Button>
                )}
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  placeholder={
                    mode === "signin" ? "Enter your password" : "Choose a strong password"
                  }
                  disabled={isLoading}
                  className="h-7 pr-8"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="absolute right-0 top-0 h-7 w-8 px-0 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
              </div>

              {/* Password strength (sign-up only) */}
              {mode === "signup" && password && (
                <div
                  className={cn(
                    "space-y-1.5 pt-0.5 transition-opacity duration-300",
                    passwordFocused ? "opacity-100" : "opacity-60"
                  )}
                >
                  <div className="flex h-1 gap-1">
                    {[...Array(4)].map((_, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex-1 rounded-full transition-colors duration-300",
                          i < passwordStrength
                            ? passwordStrength <= 2
                              ? "bg-destructive"
                              : passwordStrength === 3
                                ? "bg-warning"
                                : "bg-success"
                            : "bg-fill-secondary"
                        )}
                      />
                    ))}
                  </div>
                  <div className="space-y-0.5 text-caption1">
                    {[
                      { met: passwordChecks.length, label: "At least 8 characters" },
                      {
                        met: passwordChecks.uppercase && passwordChecks.lowercase,
                        label: "Mix of upper & lowercase letters",
                      },
                      { met: passwordChecks.number, label: "Contains numbers" },
                    ].map((check) => (
                      <div key={check.label} className="flex items-center gap-1.5">
                        {check.met ? (
                          <Check className="h-3 w-3 text-success-text" />
                        ) : (
                          <X className="h-3 w-3 text-muted-foreground" />
                        )}
                        <span className={check.met ? "text-foreground" : "text-muted-foreground"}>
                          {check.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {mode === "signin" && (
              <div className="flex items-center gap-2">
                <input
                  id="remember"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  disabled={isLoading}
                  className="h-3.5 w-3.5 rounded border-input bg-transparent text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Label
                  htmlFor="remember"
                  className="cursor-pointer select-none text-callout font-normal"
                >
                  Remember me for 7 days
                </Label>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2">
                <p className="text-callout text-destructive">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              className="h-7 w-full text-body font-medium"
              disabled={isLoading || (mode === "signup" && !isPasswordValid)}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {mode === "signin" ? "Signing in..." : "Creating account..."}
                </>
              ) : (
                <>
                  {mode === "signin" ? "Sign in" : "Create account"}
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </form>
        )}

        {/* ── Forgot password ── */}
        {mode === "forgot-password" && (
          <form onSubmit={handleForgotPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="reset-email">Email address</Label>
              <Input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={isLoading}
                className="h-7"
                autoComplete="email"
                required
                autoFocus
              />
            </div>

            {error && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2">
                <p className="text-callout text-destructive">{error}</p>
              </div>
            )}

            <Button type="submit" className="h-7 w-full text-body font-medium" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Sending reset link...
                </>
              ) : (
                <>
                  Send reset link
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </form>
        )}

        {/* ── Reset password (token + new password) ── */}
        {mode === "reset-password" && (
          <form onSubmit={handleResetPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="token">Reset token</Label>
              <Input
                id="token"
                type="text"
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                placeholder="Paste the token from your email"
                disabled={isLoading}
                className="h-7 font-mono"
                autoComplete="off"
                required
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Choose a new password"
                  disabled={isLoading}
                  className="h-7 pr-8"
                  autoComplete="new-password"
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="absolute right-0 top-0 h-7 w-8 px-0 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>

            {error && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2">
                <p className="text-callout text-destructive">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              className="h-7 w-full text-body font-medium"
              disabled={isLoading || !resetToken || newPassword.length < 8}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Resetting password...
                </>
              ) : (
                <>
                  Reset password
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </form>
        )}

        {/* Switch between sign-in and sign-up, or back out of a reset */}
        <div className="mt-5 text-center">
          {(mode === "signin" || mode === "signup") && (
            <p className="text-callout text-muted-foreground">
              {mode === "signin" ? "Don't have an account?" : "Already have an account?"}
              <Button
                type="button"
                variant="link"
                className="ml-1 h-auto p-0 text-callout font-medium"
                onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
                disabled={isLoading}
              >
                {mode === "signin" ? "Sign up" : "Sign in"}
              </Button>
            </p>
          )}
          {(mode === "forgot-password" || mode === "reset-password") && (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-callout text-muted-foreground hover:text-foreground"
              onClick={() => switchMode("signin")}
              disabled={isLoading}
            >
              Back to sign in
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
