import { useBetterAuthTauri } from "@daveyplate/better-auth-tauri/react";
import { tauriAuthClient, useSession, signOut } from "./lib/auth-client";
import { WorkspaceProvider } from "@truss/features/organizations/workspace-context";
import { AppShell, AuthScreen, SettingsPage } from "@truss/features";
import { Card, CardContent, CardHeader, CardTitle } from "@truss/ui/components/card";
import { Button } from "@truss/ui/components/button";
import { precisionShellConfig } from "./config/shell-config";
import { useState, useEffect } from "react";

function App() {
  // Handle OAuth deep links for Tauri
  useBetterAuthTauri({
    authClient: tauriAuthClient,
    scheme: "truss",
    debugLogs: false,
    onRequest: () => {},
    onSuccess: () => {},
    onError: () => {},
  });

  return (
    <WorkspaceProvider>
      <PrecisionApp />
    </WorkspaceProvider>
  );
}

function PrecisionApp() {
  const { data: session, isPending } = useSession();
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  useEffect(() => {
    const handleLocationChange = () => {
      setCurrentPath(window.location.pathname);
    };

    window.addEventListener("popstate", handleLocationChange);
    return () => window.removeEventListener("popstate", handleLocationChange);
  }, []);

  const handleLogout = async () => {
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          // Session will automatically update and trigger re-render
          console.log("Successfully logged out");
        },
        onError: (error) => {
          console.error("Failed to logout:", error);
        },
      },
    });
  };

  if (isPending) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Precision...</p>
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <AuthScreen
        appName="Precision"
        appDescription="Project estimating and cost management for construction professionals"
        onSuccess={() => {
          // Session hook will automatically update and re-render
        }}
      />
    );
  }

  const renderContent = () => {
    if (currentPath === "/settings") {
      return <SettingsPage />;
    }
    return <DashboardView user={session.user} />;
  };

  return (
    <AppShell
      config={precisionShellConfig}
      onCommandExecute={(commandId) => {}}
      onLogout={handleLogout}
    >
      {renderContent()}
    </AppShell>
  );
}

function DashboardView({ user }: { user: { name?: string; email: string } }) {
  return (
    <>
      {/* Breadcrumb navigation will be handled by the shell */}
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome back, {user.name || user.email}!
          </h1>
          <p className="text-muted-foreground">
            Here's an overview of your estimating projects and recent activity.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Active Estimates</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">12</div>
              <p className="text-xs text-muted-foreground">+2 from last week</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Total Project Value</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">$4.2M</div>
              <p className="text-xs text-muted-foreground">Across all active estimates</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Win Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">68%</div>
              <p className="text-xs text-muted-foreground">Last 30 days</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent Estimates</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Your recent estimates will appear here. Use the sidebar to navigate to different
              sections of the application.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => (window.location.href = "/estimates/new")}>New Estimate</Button>
            <Button variant="outline" onClick={() => (window.location.href = "/projects")}>
              Browse Projects
            </Button>
            <Button variant="outline" onClick={() => (window.location.href = "/reports")}>
              View Reports
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export default App;
