import { Toaster } from "@/components/ui/sonner";
import { ChunkUpdateBoundary } from "@/components/ChunkUpdateBoundary";
import { isStaleChunkError, reloadForUpdate } from "@/lib/chunk-reload";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireAdmin } from "@/components/RequireAdmin";
import { ConnectionGuard } from "@/components/ConnectionGuard";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { getAuthStorage } from "@/lib/auth-storage";
import { ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const AppShell = lazy(() => import("./components/AppShell.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const PracticeLog = lazy(() => import("./pages/PracticeLog.tsx"));
const Attendance = lazy(() => import("./pages/Attendance.tsx"));
const Classes = lazy(() => import("./pages/Classes.tsx"));
const Studio = lazy(() => import("./pages/Studio.tsx"));
const MediaVault = lazy(() => import("./pages/MediaVault.tsx"));
const Admin = lazy(() => import("./pages/Admin.tsx"));
const Messages = lazy(() => import("./pages/Messages.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in the browser runtime). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string; reloading: boolean }
> {
  state = { hasError: false, message: "", stack: "", reloading: false };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
      // Decided here, not in componentDidCatch: a redeploy should render the
      // quiet updating screen on the very first commit. Reporting it after the
      // crash layout had already painted flashed the error for a frame.
      reloading: isStaleChunkError(error),
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
    // A redeploy is not a crash: this tab is holding an older build's file
    // names, so it reloads onto the current one instead of showing an error.
    if (!isStaleChunkError(err)) return;
    if (!reloadForUpdate()) {
      // A reload was already tried moments ago and the file is still missing:
      // say so on the card rather than refreshing for ever.
      this.setState({ reloading: false });
    }
  }
  render() {
    if (this.state.hasError && this.state.reloading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <p className="animate-pulse text-sm text-muted-foreground">
            Updating NatyaVault…
          </p>
        </div>
      );
    }
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">NatyaVault hit an error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                onClick={() => window.location.reload()}
              >
                Reload
              </button>
              <a
                href="/dashboard"
                className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs font-medium"
              >
                Dashboard
              </a>
            </div>
            {import.meta.env.DEV && this.state.stack ? (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            ) : null}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// A redeploy replaces the hashed chunk files. A tab that still holds the old
// `index.html` then asks for files that no longer exist, which is what the
// browser reports as "Failed to fetch dynamically imported module". Vite raises
// this event instead of letting the failure surface mid-route: take the new
// build rather than an error screen.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadForUpdate();
});

function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {/* Light or dark is a class on <html>, read by the .dark tokens in
          index.css; next-themes remembers the choice per browser. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
        disableTransitionOnChange
      >
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      {/* `storage` keeps the signed-in session in this browser's persistent
          storage, so opening NatyaVault again does not ask for the name and
          password again (see src/lib/auth-storage.ts). */}
      {/* A dropped connection while Convex Auth refreshes the saved session is
          reported as an offline notice with a Retry, not as an uncaught error
          (see src/components/ConnectionGuard.tsx). */}
      <ConnectionGuard>
        <ConvexAuthProvider client={convex} storage={getAuthStorage()}>
          <BrowserRouter>
            <RouteSyncer />
            <ChunkUpdateBoundary>
              <Suspense fallback={<RouteLoading />}>
                <Routes>
                  <Route path="/" element={<Landing />} />
                  <Route
                    path="/auth"
                    element={<AuthPage redirectAfterAuth="/dashboard" />}
                  />
                  <Route
                    path="/dashboard"
                    element={
                      <RequireAuth>
                        <AppShell />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Dashboard />} />
                    <Route path="practice" element={<PracticeLog />} />
                    <Route path="attendance" element={<Attendance />} />
                    <Route path="classes" element={<Classes />} />
                    <Route path="studio" element={<Studio />} />
                    <Route path="vault" element={<MediaVault />} />
                    <Route path="messages" element={<Messages />} />
                    <Route
                      path="admin"
                      element={
                        <RequireAdmin>
                          <Admin />
                        </RequireAdmin>
                      }
                    />
                  </Route>
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </ChunkUpdateBoundary>
          </BrowserRouter>
          <Toaster />
        </ConvexAuthProvider>
      </ConnectionGuard>
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
