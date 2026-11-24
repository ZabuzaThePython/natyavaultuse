import { Om } from "@/components/Om";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { unlockAdmin } from "@/lib/admin";
import {
  clearInstallPrompt,
  markInstallPromptPending,
} from "@/lib/install";
import {
  forgetAccount,
  getLastAccount,
  rememberAccount,
  type LastAccount,
} from "@/lib/last-account";
import { setActiveClass, setRole, type Role } from "@/lib/vault";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  GraduationCap,
  IdCard,
  KeyRound,
  Loader2,
  Lock,
  Presentation,
  UserRound,
} from "lucide-react";
import { STORAGE_PLANS } from "@/lib/plans";
import { useAction, useConvex, useQuery } from "convex/react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

interface AuthProps {
  redirectAfterAuth?: string;
}

function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
) {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo;
  }
  return fallback;
}

const ROLES: {
  value: Role;
  label: string;
  blurb: string;
  icon: typeof GraduationCap;
}[] = [
  {
    value: "student",
    label: "Student",
    blurb: "Practice & upload",
    icon: GraduationCap,
  },
  {
    value: "teacher",
    label: "Teacher",
    blurb: "Run classes & review",
    icon: Presentation,
  },
];

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,32}$/;

/** The two ways a teacher's sign-up can place them in a studio. */
const STUDIO_MODES = [
  { value: "create" as const, label: "Start a studio" },
  { value: "join" as const, label: "Join a studio" },
];

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, signIn } = useAuth();
  const convex = useConvex();
  const ensureAdminAccount = useAction(api.admin.ensureAdminAccount);
  // Whether the admin has opened NatyaVault to other dance studios.
  const openToPublic = useQuery(api.admin.publicMode) === true;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = resolveRedirectAfterAuth(
    searchParams.get("returnTo"),
    redirectAfterAuth,
  );
  // The account this browser signed in with last, so a returning visitor is
  // asked for a password instead of their whole name and a new account.
  const [lastAccount, setLastAccount] = useState<LastAccount | null>(() =>
    getLastAccount(),
  );
  // Deep links can open the card on a specific section: the landing page's
  // "Sign in" buttons arrive with ?mode=signIn, and a browser with a remembered
  // account opens on Sign in too — signing up again is never what it wants.
  const [mode, setMode] = useState<"signUp" | "signIn">(() => {
    const requested = searchParams.get("mode");
    if (requested === "signUp") return "signUp";
    if (requested === "signIn") return "signIn";
    return getLastAccount() ? "signIn" : "signUp";
  });
  // The name field starts on the remembered account whenever the card opens
  // on Sign in, so coming back only needs the password typed. A brand-new
  // account is named from scratch.
  const [usernameValue, setUsernameValue] = useState(() =>
    mode === "signUp" ? "" : (lastAccount?.username ?? ""),
  );
  const [role, setSelectedRole] = useState<Role>("student");
  const [classCode, setClassCode] = useState("");
  // A teacher's sign-up also names a studio: join one with its code, or start
  // one. A student's comes from their class code instead.
  const [studioMode, setStudioMode] = useState<"join" | "create">("create");
  const [studioCode, setStudioCode] = useState("");
  const [studioName, setStudioName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect);
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  // A student can only create an account with the six-character code their
  // teacher gave them; it is what puts them in the right class. (A teacher
  // signs up without one and creates classes from the Classes page.)
  const needsClassCode = mode === "signUp" && role !== "teacher";
  // Every teacher belongs to a studio — their studio — from the moment the
  // account exists; otherwise their classes would belong to nobody.
  const needsStudio = mode === "signUp" && role === "teacher";
  const normalizedCode = classCode.trim().toUpperCase();
  const codeCheck = useQuery(api.classes.validateCode, { code: normalizedCode });
  const normalizedStudioCode = studioCode.trim().toUpperCase();
  const studioCheck = useQuery(api.studios.validateCode, {
    code: needsStudio && studioMode === "join" ? normalizedStudioCode : "",
  });

  const switchMode = (next: "signUp" | "signIn") => {
    if (isLoading) return;
    setMode(next);
    setError(null);
    // The remembered name belongs to the sign-in card: a new account is being
    // named from scratch, while coming back fills the old name in again.
    if (next === "signUp") {
      if (usernameValue === (lastAccount?.username ?? "")) {
        setUsernameValue("");
      }
    } else if (!usernameValue) {
      setUsernameValue(lastAccount?.username ?? "");
    }
  };

  /** "Not you?" — drop the remembered account and take a fresh name. */
  const useDifferentAccount = () => {
    forgetAccount();
    setLastAccount(null);
    setUsernameValue("");
    setMode("signIn");
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading) return;

    const formData = new FormData(event.currentTarget);
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const confirmation = String(formData.get("confirmPassword") ?? "");

    setError(null);
    // Account creation asks for a full name: it is what teachers, class lists,
    // chats and call tiles show. The username stays the sign-in handle.
    const fullName = String(formData.get("fullName") ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (mode === "signUp" && fullName.length < 2) {
      setError(
        "Enter your full name — it's what your teacher and classmates see.",
      );
      return;
    }
    // Signing in accepts a username or the display name shown on class lists,
    // so only account creation is held to the username format.
    if (!username) {
      setError(
        mode === "signUp"
          ? "Choose a username — 3–32 characters: letters, numbers, dots, dashes, underscores or @."
          : "Enter your username or your name.",
      );
      return;
    }
    if (mode === "signUp" && !USERNAME_PATTERN.test(username)) {
      setError(
        "Your username must be 3–32 characters: letters, numbers, dots, dashes, underscores or @.",
      );
      return;
    }
    // The `admin` username is the built-in admin sign-in account.
    const isAdminSignIn =
      mode === "signIn" && username.toLowerCase() === "admin";
    if (mode === "signUp" && username.toLowerCase() === "admin") {
      setError("That name is reserved for the admin area.");
      return;
    }
    if (mode === "signUp" && password !== confirmation) {
      setError("Those passwords don't match yet.");
      return;
    }
    if (needsStudio) {
      if (studioMode === "join" && normalizedStudioCode.length !== 6) {
        setError("Enter the six-character code your studio gave you.");
        return;
      }
      if (studioMode === "create" && studioName.trim().length < 2) {
        setError("Give your studio a name — it is what your classes show.");
        return;
      }
      if (studioMode === "join") {
        // Checked again on submit so a cached answer can't let a dead code in:
        // a teacher account must never be created belonging to no studio.
        const check = await convex.query(api.studios.validateCode, {
          code: normalizedStudioCode,
        });
        if (!check.ok) {
          setError(
            check.closed
              ? "That studio isn't taking new teachers right now — ask its owner to add you."
              : "That studio code doesn't match any studio — check it and try again.",
          );
          return;
        }
      }
    }
    if (needsClassCode) {
      if (normalizedCode.length !== 6) {
        setError("Enter the six-character class code your teacher gave you.");
        return;
      }
      // Checked again on submit so a cached answer can't let a bad code in.
      const check = await convex.query(api.classes.validateCode, {
        code: normalizedCode,
      });
      if (!check.ok) {
        setError(
          "That class code doesn't match any class — check it with your teacher.",
        );
        return;
      }
    }

    setIsLoading(true);
    try {
      if (mode === "signUp") {
        // Stop early with a clear message if the username is already used.
        const taken = await convex.query(api.usernames.isTaken, { username });
        if (taken) {
          setError("That name has already been taken.");
          setIsLoading(false);
          return;
        }
        // Remember the student/teacher choice in this device's vault.
        // (Sign-in doesn't touch it — the picker is account-creation only.)
        setRole(role);
        // A brand-new account still owes itself the add-to-home-screen steps,
        // shown on the dashboard (see AddToHomeScreenDialog). Written before
        // the account is created so the flag is already there when that page
        // mounts; a failed sign-up clears it again below, and a retry sets it
        // afresh. Waving the popup away keeps it quiet for a week rather than
        // bringing it back at every visit, and it stops asking altogether
        // after a second dismissal or an actual install.
        markInstallPromptPending();
      }

      if (isAdminSignIn) {
        // Signing in as `admin` — verify the credentials server-side and make
        // sure the admin account exists (a fresh deployment has none), then
        // land straight in the admin area.
        let adminOk = false;
        try {
          adminOk = (
            await ensureAdminAccount({
              adminUsername: username,
              adminPassword: password,
            })
          ).ok;
        } catch (caught) {
          console.error("Admin verification error:", caught);
          setError(
            "Couldn't verify the admin credentials. Check your connection.",
          );
          setIsLoading(false);
          return;
        }
        if (!adminOk) {
          setError("Those admin credentials are incorrect.");
          setIsLoading(false);
          return;
        }
      }

      // The password provider keys accounts by username, so a typed display
      // name is turned into the usernames it could be first (names are not
      // unique) and each is tried with the password that was typed.
      let handles = [username];
      if (mode === "signIn" && !isAdminSignIn) {
        try {
          const candidates = await convex.query(api.usernames.resolve, {
            name: username,
          });
          if (candidates.length > 0) handles = candidates;
        } catch (caught) {
          console.error("Could not resolve that name:", caught);
        }
      }

      let failure: unknown = null;
      let signedInAs = "";
      for (const handle of handles) {
        try {
          await signIn("password", {
            flow: mode,
            username: handle,
            password,
            role,
            classCode: normalizedCode,
            // Sign-up only — signing in never rewrites the stored name.
            ...(mode === "signUp" ? { fullName } : {}),
            // The studio a teacher's account belongs to, recorded server-side by
            // the password provider (see convex/studios.ts → studioOnSignUp).
            ...(needsStudio
              ? studioMode === "join"
                ? { studioCode: normalizedStudioCode }
                : { studioName: studioName.trim() }
              : {}),
          });
          failure = null;
          signedInAs = handle;
          break;
        } catch (caught) {
          failure = caught;
        }
      }
      if (failure !== null) throw failure;
      // Remember who signed in here: opening NatyaVault again should come
      // back to this account, not to a blank "who are you?" (see
      // src/lib/last-account.ts).
      rememberAccount(signedInAs || username);
      // The studio itself is placed server-side from the code or name above
      // (convex/auth/password.ts schedules studios.studioOnSignUp). It is not
      // repeated from here: a client call racing that one could found a second
      // studio for the same account. If placement ever fails, the "Name your
      // studio" card offers it again on the first visit.
      if (mode === "signUp" && needsClassCode) {
        // The class this browser opens, straight away — no second code entry.
        setActiveClass(normalizedCode);
        // The membership itself is recorded server-side as part of creating
        // the account (convex/auth/password.ts schedules classes.joinOnSignUp),
        // because a call from here can beat the new session's token. This is
        // just the fast path when the session is already on the wire.
        try {
          const joined = await convex.mutation(api.classes.joinClass, {
            code: normalizedCode,
          });
          if (!joined.ok) {
            console.warn(
              "The server records this membership at sign-up:",
              joined.error,
            );
          }
        } catch (caught) {
          console.error("Could not join the class:", caught);
        }
      }
      if (isAdminSignIn) {
        unlockAdmin(username, password);
        navigate("/dashboard");
        return;
      }
      navigate(redirect);
    } catch (error) {
      console.error("Password sign-in error:", error);
      // No account was created, so drop the install popup the attempt queued.
      if (mode === "signUp") clearInstallPrompt();
      const message = error instanceof Error ? error.message : "";
      if (mode === "signUp" && /already exists/i.test(message)) {
        // Race fallback: the account was created between our check and now.
        setError("That name has already been taken.");
      } else if (mode === "signUp") {
        setError("Couldn't create your account. Please try again.");
      } else {
        setError("That name and password combination didn't work.");
      }
      setIsLoading(false);
    }
  };

  // A live session already answers this page: it lands in the vault instead
  // of showing the card for a moment on the way (see the effect above).
  if (isAuthenticated) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Auth Content */}
      <div className="flex flex-1 items-center justify-center px-4 py-6 sm:py-10">
        <div className="flex w-full max-w-[400px] flex-col items-center">
          <Card className="w-full max-w-[400px] pb-0 border shadow-md">
            <CardHeader className="text-center">
              <div className="flex justify-center">
                <button
                  type="button"
                  aria-label="Back to home"
                  onClick={() => navigate("/")}
                  className="mx-auto mb-4 mt-2 flex size-14 items-center justify-center rounded-xl bg-red-800 shadow-sm transition-transform hover:scale-105"
                >
                  <Om className="text-3xl text-yellow-300" />
                </button>
              </div>
              <CardTitle className="text-xl">
                {mode === "signUp" && openToPublic
                  ? "Create your studio vault"
                  : "Create your vault"}
              </CardTitle>
              <CardDescription>
                {mode === "signUp"
                  ? openToPublic
                    ? "Open to dance studios — your full name, a username, a password, and you're in"
                    : "Enter your full name, choose a username, and set a password — students also need their class code"
                  : "Welcome back — your username or your name, plus your password"}
              </CardDescription>
              {mode === "signIn" && lastAccount && (
                <p className="pt-1 text-xs text-muted-foreground">
                  Staying signed in as{" "}
                  <span className="font-medium text-foreground">
                    {lastAccount.username}
                  </span>{" "}
                  on this device — just your password.
                </p>
              )}
            </CardHeader>

            <form onSubmit={handleSubmit}>
              <CardContent className="space-y-4">
                {/* Student / Teacher selection — account creation only */}
                {mode === "signUp" && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      I am a
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {ROLES.map((option) => {
                        const Icon = option.icon;
                        const selected = role === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            disabled={isLoading}
                            aria-pressed={selected}
                            onClick={() => {
                              setSelectedRole(option.value);
                              setError(null);
                            }}
                            className={
                              selected
                                ? "flex flex-col items-start gap-1 rounded-lg border border-primary bg-primary px-3 py-2.5 text-left text-primary-foreground shadow-sm transition-colors"
                                : "flex flex-col items-start gap-1 rounded-lg border border-border bg-card px-3 py-2.5 text-left text-foreground transition-colors hover:border-primary/50 hover:bg-muted"
                            }
                          >
                            <span className="flex items-center gap-1.5 text-sm font-semibold">
                              <Icon className="h-4 w-4" />
                              {option.label}
                            </span>
                            <span
                              className={
                                selected
                                  ? "text-xs text-primary-foreground/80"
                                  : "text-xs text-muted-foreground"
                              }
                            >
                              {option.blurb}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Studio — a teacher joins one with its code, or starts one */}
                {needsStudio && (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Your studio
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {STUDIO_MODES.map((option) => {
                        const selected = studioMode === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            disabled={isLoading}
                            aria-pressed={selected}
                            onClick={() => {
                              setStudioMode(option.value);
                              setError(null);
                            }}
                            className={
                              selected
                                ? "cursor-pointer rounded-lg border border-primary bg-primary px-3 py-2 text-left text-sm font-semibold text-primary-foreground transition-colors"
                                : "cursor-pointer rounded-lg border border-border bg-card px-3 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-muted"
                            }
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="relative">
                      <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="studio"
                        value={studioMode === "join" ? studioCode : studioName}
                        onChange={(event) =>
                          studioMode === "join"
                            ? setStudioCode(
                                event.target.value
                                  .toUpperCase()
                                  .replace(/[^A-Z0-9]/g, "")
                                  .slice(0, 6),
                              )
                            : setStudioName(event.target.value)
                        }
                        placeholder={
                          studioMode === "join"
                            ? "Studio join code"
                            : "Name of your studio"
                        }
                        autoComplete="off"
                        autoCapitalize={
                          studioMode === "join" ? "characters" : "sentences"
                        }
                        spellCheck={false}
                        className="pl-9"
                        disabled={isLoading}
                      />
                    </div>
                    {studioMode === "join" && studioCheck?.closed ? (
                      <p className="text-xs text-amber-600 dark:text-amber-500">
                        {studioCheck.name} isn't taking new teachers right now.
                      </p>
                    ) : null}
                    {studioMode === "join" && studioCheck?.ok ? (
                      <p className="text-xs text-muted-foreground">
                        Joining{" "}
                        <span className="font-medium text-foreground">
                          {studioCheck.name}
                        </span>
                      </p>
                    ) : null}
                  </div>
                )}

                {/* Class code — new students must know the class they join */}
                {needsClassCode && (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="classCode"
                        value={classCode}
                        onChange={(event) =>
                          setClassCode(
                            event.target.value
                              .toUpperCase()
                              .replace(/[^A-Z0-9]/g, "")
                              .slice(0, 6),
                          )
                        }
                        placeholder="Class code from your teacher"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={6}
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    {normalizedCode.length === 6 && (
                      <p
                        className={
                          codeCheck?.ok
                            ? "text-xs text-emerald-600"
                            : "text-xs text-red-500"
                        }
                      >
                        {codeCheck?.ok
                          ? `You'll join “${codeCheck.name}”.`
                          : "That code doesn't match any class."}
                      </p>
                    )}
                  </div>
                )}

                {/* Create account / Sign in toggle */}
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                  {(
                    [
                      ["signUp", "Create account"],
                      ["signIn", "Sign in"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isLoading}
                      onClick={() => switchMode(value)}
                      className={
                        mode === value
                          ? "rounded-md bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
                          : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Full name — account creation only */}
                {mode === "signUp" && (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <IdCard className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        name="fullName"
                        placeholder="Your full name"
                        type="text"
                        autoComplete="name"
                        autoCapitalize="words"
                        maxLength={80}
                        className="pl-9"
                        disabled={isLoading}
                        required
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      This is the name on class lists, chats and calls.
                    </p>
                  </div>
                )}

                {/* Username — what they sign in with */}
                <div className="space-y-1.5">
                  <div className="relative">
                    <UserRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      name="username"
                      value={usernameValue}
                      onChange={(event) => setUsernameValue(event.target.value)}
                      placeholder={
                        mode === "signUp"
                          ? "Choose a username"
                          : "Username or full name"
                      }
                      type="text"
                      autoComplete="username"
                      className="pl-9"
                      disabled={isLoading}
                      required
                    />
                  </div>
                  {mode === "signUp" && (
                    <p className="text-[11px] text-muted-foreground">
                      Username — 3–32 letters, numbers, dots, dashes,
                      underscores or @. You sign in with this.
                    </p>
                  )}
                  {lastAccount && (
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={useDifferentAccount}
                      className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                    >
                      Not {lastAccount.username}? Use a different account
                    </button>
                  )}
                </div>

                {/* Password */}
                <div className="relative">
                  <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    name="password"
                    placeholder={
                      mode === "signUp" ? "Create a password" : "Your password"
                    }
                    type={showPassword ? "text" : "password"}
                    autoComplete={
                      mode === "signUp" ? "new-password" : "current-password"
                    }
                    className="pl-9 pr-10"
                    disabled={isLoading}
                    required
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-3 text-muted-foreground transition-colors hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>

                {/* Confirm password (account creation only) */}
                {mode === "signUp" && (
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      name="confirmPassword"
                      placeholder="Confirm your password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      className="pl-9"
                      disabled={isLoading}
                      required
                    />
                  </div>
                )}

                {mode === "signUp" && !error && (
                  <p className="text-xs text-muted-foreground">
                    {openToPublic &&
                      `Free to start — ${STORAGE_PLANS[0].storage} of vault storage, upgrade whenever your studio grows. `}
                    {needsClassCode
                      ? "Your class code is what puts you in your class — every class keeps its own vault, folders, practice log, and attendance. "
                      : "A teacher starts without a class and creates classes from the Classes page. "}
                    Your name: 3–32 characters (letters, numbers, dots, dashes,
                    underscores). Any password you like — nothing is emailed,
                    the password is what gets you in.
                  </p>
                )}

                {error && (
                  <p className="text-sm text-red-500">{error}</p>
                )}

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {mode === "signUp"
                        ? "Creating your vault..."
                        : "Signing in..."}
                    </>
                  ) : (
                    <>
                      {mode === "signUp"
                        ? "Create my vault"
                        : "Open my vault"}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              </CardContent>
            </form>

            <div className="py-4 px-6 text-xs text-center text-muted-foreground bg-muted border-t rounded-b-lg">
              Secured by{" "}
              <a
                href="https://freebuff.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary transition-colors"
              >
                freebuff.com
              </a>
            </div>
          </Card>

          <Button
            type="button"
            variant="ghost"
            className="mt-3 text-muted-foreground hover:text-foreground"
            onClick={() => navigate("/")}
          >
            <ArrowLeft />
            Back to homepage
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  );
}
