import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isStaleChunkError, reloadForUpdate } from "@/lib/chunk-reload";
import { Loader2, RefreshCw } from "lucide-react";
import React from "react";

/**
 * The boundary for pages that are loaded on demand.
 *
 * Every route in this app is a lazy import, so a redeploy that happens while a
 * tab is open can make the next click fail with "Failed to fetch dynamically
 * imported module" — the tab's `index.html` still names chunk files the new
 * build replaced. That is not a bug in the page and there is nothing to explain
 * or debug: the app needs the current `index.html`, so it reloads itself once
 * and lands on the clicked route.
 *
 * If a reload was already tried a moment ago and the chunk is still missing,
 * the card appears instead, so a genuinely broken deployment cannot turn into a
 * refresh loop.
 */
export class ChunkUpdateBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown; reloading: boolean }
> {
  state: { error: unknown; reloading: boolean } = {
    error: null,
    reloading: false,
  };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    // Only a redeploy is automatic; a real crash belongs on screen.
    if (isStaleChunkError(error) && reloadForUpdate()) {
      this.setState({ reloading: true });
    }
  }

  render() {
    if (this.state.error === null) return this.props.children;

    if (this.state.reloading) {
      return (
        <main className="flex min-h-[60vh] items-center justify-center p-6">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Updating NatyaVault…
          </p>
        </main>
      );
    }

    const stale = isStaleChunkError(this.state.error);

    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">
              {stale ? "NatyaVault was updated" : "This page didn't load"}
            </CardTitle>
            <CardDescription>
              {stale
                ? "This tab is still running an older version of the app, so the page it asked for has moved. Reloading fetches the current version — your work is saved on the server, nothing is lost."
                : "Something went wrong opening this page. Reloading usually brings it back."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {import.meta.env.DEV ? (
              <pre className="max-h-40 overflow-auto rounded border border-border/60 p-2 text-left text-[10px] leading-4 text-muted-foreground">
                {this.state.error instanceof Error
                  ? (this.state.error.stack ?? this.state.error.message)
                  : String(this.state.error)}
              </pre>
            ) : null}
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button className="w-full" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 size-4" />
              Reload
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                window.location.href = "/dashboard";
              }}
            >
              Back to the dashboard
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }
}
