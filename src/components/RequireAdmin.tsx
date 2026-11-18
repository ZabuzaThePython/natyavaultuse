import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { unlockAdmin, useAdminAccess } from "@/lib/admin";
import { useAction, useMutation } from "convex/react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

/**
 * Blocks admin features until the admin username and password are entered.
 *
 * The credentials are checked server-side by the Convex `admin.verify`
 * action; on success the unlock is kept on this browser (localStorage), so
 * closing and reopening NatyaVault stays unlocked until the admin signs out.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  // The stored unlock, or a session signed in as the admin account. The second
  // is answered by the deployment, so a browser that lost its localStorage no
  // longer drops the admin back to this form.
  const { isAdmin, loading: checking } = useAdminAccess();
  const verifyAdmin = useAction(api.admin.verify);
  const claimAdminAccess = useMutation(api.admin.claimAdminAccess);
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isAdmin) return children;

  if (checking) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Checking admin access…
        </p>
      </main>
    );
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading) return;

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    setIsLoading(true);
    setError(null);
    try {
      const ok = await verifyAdmin({ username, password });
      if (ok) {
        // Remember the unlock in this browser (instant on the next load) and on
        // the deployment (survives a cleared browser or a different device).
        unlockAdmin(username, password);
        try {
          await claimAdminAccess({ username, password });
        } catch (error) {
          console.error("Could not store the admin unlock:", error);
        }
      } else {
        setError("That username or password is incorrect.");
        setIsLoading(false);
      }
    } catch (error) {
      console.error("Admin verification error:", error);
      setError("Couldn't verify the credentials. Check your connection.");
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex justify-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
              <ShieldCheck className="size-5 text-primary" />
            </div>
          </div>
          <CardTitle className="text-xl">Admin credentials required</CardTitle>
          <CardDescription>
            Enter the admin username and password to unlock admin features.
          </CardDescription>
          <p className="pt-1 text-xs text-muted-foreground">
            Tip: signing in with the admin username and password lands you here
            directly.
          </p>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-3">
            <div className="relative">
              <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                name="username"
                placeholder="Username"
                autoComplete="username"
                className="pl-9"
                disabled={isLoading}
                autoFocus
                required
              />
            </div>
            <Input
              name="password"
              placeholder="Password"
              type="password"
              autoComplete="current-password"
              disabled={isLoading}
              required
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                <>
                  Unlock admin
                  <ShieldCheck className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => navigate("/dashboard")}
              disabled={isLoading}
            >
              Back to dashboard
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
