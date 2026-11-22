import { Om } from "@/components/Om";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import natarajaImage from "@/assets/nataraja.jpg";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { STORAGE_PLANS } from "@/lib/plans";
import {
  ArrowRight,
  Check,
  Clock3,
  Disc3,
  HardDrive,
  MessageSquareText,
  Music2,
  NotebookPen,
  Trophy,
} from "lucide-react";
import { useQuery } from "convex/react";
import { Link, Navigate } from "react-router";

function BrandMark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const iconSize =
    size === "lg"
      ? "text-3xl"
      : size === "sm"
        ? "text-base"
        : "text-2xl";
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-red-800 ${
        size === "lg" ? "size-11" : size === "sm" ? "size-7" : "size-9"
      }`}
    >
      <Om className={`${iconSize} text-yellow-300`} />
    </span>
  );
}

const FEATURES = [
  {
    icon: Disc3,
    title: "Media vault",
    body: "Audio and video, tagged and searchable.",
    tint: "bg-primary/10 text-primary",
  },
  {
    icon: NotebookPen,
    title: "Practice log",
    body: "Every session logged in seconds.",
    tint: "bg-gold/25 text-gold-foreground",
  },
  {
    icon: MessageSquareText,
    title: "Messages",
    body: "Chat with your teacher and share clips.",
    tint: "bg-terracotta/15 text-terracotta",
  },
];

/**
 * Landing page. Two states, decided by the admin's public launch switch
 * (`publicMode`): a private, invitation-only vault for one class, or an open
 * front door for other dance studios with the storage plans they sign up on.
 */
export default function Landing() {
  const openToPublic = useQuery(api.admin.publicMode) === true;
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const primaryCta = openToPublic ? "Start your studio" : "Create your vault";

  // This device is already signed in — reopening NatyaVault picks the vault
  // back up instead of asking who you are (the page still renders while the
  // session is being read, so a first-time visitor never waits on it).
  if (!authLoading && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    // With the public launch off the page is the single fixed-viewport screen
    // it has always been; opening it to studios adds the plans section below
    // the fold, so the page is allowed to scroll.
    <div
      className={`flex min-h-dvh flex-col bg-background text-foreground ${
        openToPublic ? "" : "lg:h-dvh lg:overflow-hidden"
      }`}
    >
      {/* ------------------------------------------------------------ nav */}
      <header className="shrink-0 border-b border-border/70 bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <span className="font-samarkan text-xl leading-tight">
              NatyaVault
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              asChild
            >
              <Link to="/auth?mode=signIn">Sign in</Link>
            </Button>
            <Button type="button" size="sm" asChild>
              <Link to="/auth">
                {primaryCta}
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* ----------------------------------------------------------- hero */}
      <main className="flex min-h-0 flex-1 items-center">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-6 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-2 lg:gap-12">
          <div className="flex flex-col items-start gap-3 sm:gap-4">
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/5 text-primary"
            >
              {openToPublic
                ? "For Bharatanatyam studios"
                : "Bharatanatyam practice, organised"}
            </Badge>
            <h1 className="text-[1.75rem] leading-[1.05] font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Every adavu,
              <span className="text-primary"> every composition</span>- in one
              vault.
            </h1>
            <p className="max-w-md text-sm leading-6 text-muted-foreground lg:text-base lg:leading-7">
              Your personal archive for Bharatanatyam — every adavu, every
              composition, and every practice session, kept in folders so your
              tracks, clips, and logs stay organised and always at hand.
              {openToPublic && (
                <>
                  {" "}
                  Run a dance studio? Open a vault for your studio and invite
                  every class.
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" asChild>
                <Link to="/auth">
                  {primaryCta}
                  <ArrowRight />
                </Link>
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link to="/auth?mode=signIn">Sign in</Link>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Music2 className="size-3.5 text-gold-foreground" />
                Audio &amp; video in one vault
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="size-3.5 text-gold-foreground" />
                Practice streaks by session
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Trophy className="size-3.5 text-gold-foreground" />
                Leaderboard of practice minutes
              </span>
            </div>
          </div>

          {/* static Nataraja photograph */}
          <figure className="mx-auto w-full max-w-[min(18rem,60vh)] lg:max-w-[min(22rem,44vh)]">
            <div className="overflow-hidden rounded-2xl border border-gold/25 bg-primary p-1 sm:p-1.5">
              <img
                src={natarajaImage}
                alt="Nataraja — bronze statue of Shiva, the cosmic dancer, against a weathered wall"
                className="mx-auto max-h-[50vh] w-auto rounded-xl object-contain"
              />
              <figcaption className="py-1 text-center text-[11px] font-medium tracking-wide text-gold sm:text-xs">
                Natarāja — the cosmic dancer
              </figcaption>
            </div>
          </figure>
        </div>
      </main>

      {/* ---------------------------------------------- features strip */}
      <section className="shrink-0 border-t border-border/70 bg-card/60">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-x-6 gap-y-3 px-4 py-3 min-[420px]:grid-cols-2 sm:grid-cols-3 sm:px-6">
          {FEATURES.map(({ icon: Icon, title, body, tint }) => (
            <div key={title} className="flex items-start gap-2.5">
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-md ${tint}`}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="truncate text-xs font-semibold tracking-tight">
                  {title}
                </h3>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------ public launch: studios */}
      {openToPublic && (
        <section
          id="studios"
          className="shrink-0 border-t border-border/70 bg-background"
        >
          <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
            <div className="flex flex-col items-start gap-2">
              <Badge
                variant="outline"
                className="border-gold/40 bg-gold/15 text-gold-foreground"
              >
                For dance studios
              </Badge>
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Bring your studio onto NatyaVault
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Every studio gets its own vault — separate folders, practice
                logs, and messages for your classes. Start free and pay a small
                monthly amount for the storage you actually use.
              </p>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              {STORAGE_PLANS.map((plan) => (
                <div
                  key={plan.name}
                  className={`flex flex-col gap-3 rounded-xl border p-5 ${
                    plan.featured
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/70 bg-card"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">
                      {plan.name}
                    </h3>
                    {plan.featured && (
                      <Badge className="bg-primary text-primary-foreground">
                        Most popular
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-bold tracking-tight">
                      {plan.price}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {plan.cadence}
                    </span>
                  </div>
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <HardDrive className="size-3.5 shrink-0 text-primary" />
                    {plan.storage} of storage
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {plan.blurb}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                      >
                        <Check className="mt-0.5 size-3.5 shrink-0 text-gold-foreground" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button
                    type="button"
                    variant={plan.featured ? "default" : "outline"}
                    className="mt-auto w-full"
                    asChild
                  >
                    <Link to="/auth">Start with {plan.name}</Link>
                  </Button>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Billed monthly, per studio — cancel whenever you like, and your
              files stay yours.
            </p>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- footer */}
      <footer className="shrink-0 border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-2 sm:px-6">
          <p className="text-[11px] text-muted-foreground">
            NatyaVault · Practice logs, media, and folders for Bharatanatyam.
          </p>
          <p className="hidden text-[11px] text-muted-foreground sm:block">
            © {new Date().getFullYear()} NatyaVault · Made for the dance room
          </p>
        </div>
      </footer>
    </div>
  );
}
