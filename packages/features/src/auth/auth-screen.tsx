"use client";

import { useState, useEffect } from "react";
import { tauriAuthClient } from "@truss/auth/client/tauri";
import { Button } from "@truss/ui/components/button";
import { Input } from "@truss/ui/components/input";
import { Label } from "@truss/ui/components/label";
import { cn } from "@truss/ui/lib/utils";
import { Eye, EyeOff, Check, X, Loader2, ArrowRight } from "lucide-react";

interface AuthScreenProps {
  onSuccess?: () => void;
  appName: string;
  appDescription: string;
}

/**
 * Desktop-native authentication screen for Tauri applications.
 * Provides smooth email/password signin and signup with minimal friction.
 */
export function AuthScreen({ onSuccess, appName, appDescription }: AuthScreenProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [rememberMe, setRememberMe] = useState(true);

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

  // Clear error when switching modes
  useEffect(() => {
    setError(null);
  }, [mode]);

  /**
   * Handles form submission for both signin and signup
   */
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
        // autoSignIn is enabled server-side, so signUp creates a session automatically
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
        // Sign in (only for direct signin, not after signup)
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

      // Success! Call the callback after a brief moment
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

  /**
   * Smoothly transitions between signin and signup modes
   */
  const toggleMode = () => {
    setIsTransitioning(true);
    setTimeout(() => {
      setMode((prev) => (prev === "signin" ? "signup" : "signin"));
      setIsTransitioning(false);
    }, 150);
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-8">
      <div className="w-full max-w-[440px]">
        {/* Logo and app info */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 mb-5 transition-transform hover:scale-105 duration-300">
            <div className="w-10 h-10 rounded-xl bg-primary shadow-lg" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{appName}</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">{appDescription}</p>
        </div>

        {/* Auth card */}
        <div
          className={cn(
            "bg-card border rounded-xl shadow-2xl p-8 transition-all duration-300",
            isTransitioning && "scale-[0.98] opacity-90"
          )}
        >
          <div className="mb-8">
            <h2 className="text-xl font-semibold">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="text-sm text-muted-foreground mt-2">
              {mode === "signin"
                ? "Sign in to continue to your workspace"
                : "Get started with your free account"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Name field (signup only) */}
            {mode === "signup" && (
              <div
                className={cn(
                  "space-y-2 transition-all duration-300",
                  isTransitioning ? "opacity-0" : "opacity-100"
                )}
              >
                <Label htmlFor="name">Full name</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  disabled={isLoading}
                  className="h-11"
                  autoComplete="name"
                  required={mode === "signup"}
                />
              </div>
            )}

            {/* Email field */}
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                disabled={isLoading}
                className="h-11"
                autoComplete="email"
                required
                autoFocus={mode === "signin"}
              />
            </div>

            {/* Password field */}
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
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
                  className="h-11 pr-11"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-11 w-11 px-0 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>

              {/* Password strength indicator (signup only) */}
              {mode === "signup" && password && (
                <div
                  className={cn(
                    "space-y-2 transition-all duration-300",
                    passwordFocused ? "opacity-100" : "opacity-60"
                  )}
                >
                  <div className="flex gap-1 h-1">
                    {[...Array(4)].map((_, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex-1 rounded-full transition-all duration-300",
                          i < passwordStrength
                            ? passwordStrength <= 2
                              ? "bg-destructive"
                              : passwordStrength === 3
                                ? "bg-yellow-500"
                                : "bg-green-500"
                            : "bg-muted"
                        )}
                      />
                    ))}
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center gap-1.5">
                      {passwordChecks.length ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <X className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span
                        className={cn(
                          "text-muted-foreground",
                          passwordChecks.length && "text-foreground"
                        )}
                      >
                        At least 8 characters
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {passwordChecks.uppercase && passwordChecks.lowercase ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <X className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span
                        className={cn(
                          "text-muted-foreground",
                          passwordChecks.uppercase && passwordChecks.lowercase && "text-foreground"
                        )}
                      >
                        Mix of upper & lowercase letters
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {passwordChecks.number ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <X className="h-3 w-3 text-muted-foreground" />
                      )}
                      <span
                        className={cn(
                          "text-muted-foreground",
                          passwordChecks.number && "text-foreground"
                        )}
                      >
                        Contains numbers
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Remember me checkbox (signin only) */}
            {mode === "signin" && (
              <div className="flex items-center space-x-2">
                <input
                  id="remember"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  disabled={isLoading}
                  className="h-4 w-4 rounded border-input bg-transparent text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Label
                  htmlFor="remember"
                  className="text-sm font-normal cursor-pointer select-none"
                >
                  Remember me for 7 days
                </Label>
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            {/* Submit button */}
            <Button
              type="submit"
              className="w-full h-11 font-medium text-base"
              disabled={isLoading || (mode === "signup" && !isPasswordValid)}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {mode === "signin" ? "Signing in..." : "Creating account..."}
                </>
              ) : (
                <>
                  {mode === "signin" ? "Sign in" : "Create account"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            {/* Forgot password link (signin only) */}
            {mode === "signin" && (
              <div className="text-center">
                <Button
                  type="button"
                  variant="link"
                  className="text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    // TODO: Implement forgot password flow
                    console.log("Forgot password clicked");
                  }}
                >
                  Forgot your password?
                </Button>
              </div>
            )}
          </form>

          {/* Mode toggle */}
          <div className="mt-6 pt-6 border-t text-center">
            <p className="text-sm text-muted-foreground">
              {mode === "signin" ? "Don't have an account?" : "Already have an account?"}
              <Button
                type="button"
                variant="link"
                className="text-sm font-medium ml-1 p-0 h-auto"
                onClick={toggleMode}
                disabled={isLoading}
              >
                {mode === "signin" ? "Sign up" : "Sign in"}
              </Button>
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          By continuing, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}
