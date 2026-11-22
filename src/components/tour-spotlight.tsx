import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { api } from "@/convex/_generated/api";
import { useIsAdmin } from "@/lib/admin";
import { useViewerIsStaff } from "@/lib/classes";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault";
import { useMutation } from "convex/react";
import { ArrowRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLocation } from "react-router";

/** The card's width when it sits beside the spotlighted element. */
const CARD_W = 340;
/** Space between the spotlight and the card. */
const GAP = 16;
/** Space kept between the card and the edge of the screen. */
const MARGIN = 16;
/** Sticky app header, so an element under it is scrolled clear. */
const HEADER_H = 64;
/** Corner radius of the lit cut-out — the dim's inner edge uses the same one. */
const HOLE_RADIUS = 12;

/**
 * Pages a stop can live on, with the menu entry that opens each one.
 *
 * The tour never jumps pages by itself: it sends the reader through the menu,
 * so they learn where each section is.
 */
const PAGES: Record<string, { label: string; nav: string }> = {
  "/dashboard": { label: "Dashboard", nav: "nav-dashboard" },
  "/dashboard/practice": { label: "Practice Log", nav: "nav-practice" },
  "/dashboard/attendance": { label: "Attendance", nav: "nav-attendance" },
  "/dashboard/vault": { label: "Media Vault", nav: "nav-vault" },
  "/dashboard/messages": { label: "Messages", nav: "nav-messages" },
  "/dashboard/classes": { label: "Classes", nav: "nav-classes" },
};

/** One stop: a real element and the words that explain it. */
interface TourStep {
  id: string;
  title: string;
  body: string;
  /** `data-tour` value of the element this stop points at. */
  target?: string;
  /** The real page the stop lives on; the tour opens it. */
  path?: string;
}

interface Spot {
  top: number;
  left: number;
  width: number;
  height: number;
}

type Side = "left" | "right" | "top" | "bottom";

type Placement =
  | {
      kind: "anchor";
      side: Side;
      left: number;
      top: number;
      /** Where along the card's edge the pointer sits. */
      arrow: number;
    }
  | { kind: "dock"; left: number; right: number; bottom: number }
  | { kind: "center" };

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

const sameSpot = (a: Spot, b: Spot) =>
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

const sameBoxes = (a: Record<string, Spot>, b: Record<string, Spot>) => {
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((key) => a[key] !== undefined && sameSpot(a[key], b[key]));
};

/** The first laid-out match, preferring one already on screen. */
function findTarget(target: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(
    `[data-tour="${target}"]`,
  );
  let fallback: HTMLElement | null = null;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    fallback ??= node;
    if (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    ) {
      return node;
    }
  }
  return fallback;
}

/** Cut a big element down to the part that can actually be seen. */
function clampToViewport(spot: Spot, vw: number, vh: number): Spot | null {
  const pad = 6;
  const left = Math.max(0, spot.left - pad);
  const top = Math.max(0, spot.top - pad);
  const right = Math.min(vw, spot.left + spot.width + pad);
  const bottom = Math.min(vh, spot.top + spot.height + pad);
  if (right - left < 8 || bottom - top < 8) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The guided walkthrough — a spotlight tour of the real app.
 *
 * One real element is lit on each stop, with a compact card pinned beside it
 * (below it on a phone), progress dots, and Back / Next. The rest of
 * NatyaVault is dimmed and paused, so every stop is only about the thing the
 * card is describing. A stop that lives on another page asks the reader to
 * open it from the menu — the lit menu entry is clickable — and the element is
 * scrolled into view when it is below the fold.
 *
 * Whether the tour is owed at all comes from the deployment (`convex/tour.ts`),
 * so it appears after sign-up on any device and never again — finishing and
 * skipping both count as seen. Staff-only pages are only described to staff.
 */
export function TourSpotlight({
  open,
  onDone,
}: {
  open: boolean;
  /** Called once the tour has been finished or skipped. */
  onDone: () => void;
}) {
  const finish = useMutation(api.tour.finish);
  const isAdmin = useIsAdmin();
  const { isStaff } = useViewerIsStaff();
  const practiceEnabled = useVault().practiceLogEnabled;
  const { setOpenMobile, setOpen, isMobile } = useSidebar();
  const { pathname } = useLocation();

  const [index, setIndex] = useState(0);
  const [boxes, setBoxes] = useState<Record<string, Spot>>({});
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [cardHeight, setCardHeight] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The stop whose target has already been scrolled into view, so the tour
  // does not fight the reader by re-centering on every frame.
  const scrolledFor = useRef<string | null>(null);

  const steps = useMemo(() => {
    const list: TourStep[] = [
      {
        id: "welcome",
        title: "Welcome to NatyaVault",
        body: "Your dance studio in one place — the archive, practice, attendance and messages. This is a quick tour of the real screens; skip it any time.",
        path: "/dashboard",
      },
      {
        id: "nav",
        title: "Find your way around",
        body: "Dashboard, Practice Log, Attendance, Media Vault and Messages all live here. Teachers also get Classes.",
        target: "nav",
      },
      {
        id: "dash-actions",
        title: "Quick actions",
        body: "Log a practice, open attendance, or jump straight to an upload.",
        path: "/dashboard",
        target: "dash-actions",
      },
      {
        id: "dash-stats",
        title: "Today's numbers",
        body: "Files in the vault, minutes practised this week, folders, and who has been marked present today.",
        target: "dash-stats",
      },
      {
        id: "dash-leaderboard",
        title: "Leaderboard",
        body: "Minutes practised by everyone in the class over the last 30 days.",
        target: "dash-leaderboard",
      },
      {
        id: "dash-recent",
        title: "Recent media",
        body: "The newest clips and tracks — tap a row to play it right here.",
        target: "dash-recent",
      },
      {
        id: "dash-practice",
        title: isStaff ? "Student practice" : "Your practice",
        body: isStaff
          ? "Your students' latest logged sessions; Open takes you to the full review."
          : "Your most recent sessions — open the full log to add one or look back.",
        target: "dash-practice",
      },
      {
        id: "vault-actions",
        title: "Upload and create",
        body: "New folder groups files; Upload a file adds audio and video. The page also accepts drag-and-drop.",
        path: "/dashboard/vault",
        target: "vault-actions",
      },
      {
        id: "vault-folders",
        title: "Folders",
        body: "Nest folders to keep adavus, compositions and performances apart. Each folder can be moved, renamed or deleted.",
        target: "vault-folders",
      },
      {
        id: "vault-tabs",
        title: "Audios and Videos",
        body: "Two shelves: practice tracks by talam or ragam in Audios, dance clips in Videos.",
        target: "vault-tabs",
      },
      {
        id: "vault-search",
        title: "Search",
        body: "Find a file by its title, the dance item it belongs to, or its folder.",
        target: "vault-search",
      },
      ...(isStaff
        ? ([
            {
              id: "practice-range",
              title: "Time range",
              body: "Switch between last week, last month, last year and lifetime — the totals follow.",
              path: "/dashboard/practice",
              target: "practice-range",
            },
            {
              id: "practice-entries",
              title: "All student entries",
              body: "Every student's sessions, newest first, with the minutes each one adds up to.",
              target: "practice-entries",
            },
          ] satisfies TourStep[])
        : ([
            {
              id: "practice-form",
              title: "Log a practice",
              body: "Date, duration in minutes, and the item you practised — Alarippu, Jatiswaram, Varnam…",
              path: "/dashboard/practice",
              target: "practice-form",
            },
            {
              id: "practice-post",
              title: "Post entry",
              body: "Saves the session to your log, where it appears immediately.",
              target: "practice-post",
            },
            {
              id: "practice-range",
              title: "Time range",
              body: "Switch between last week, last month, last year and lifetime.",
              target: "practice-range",
            },
            {
              id: "practice-entries",
              title: "Your entries",
              body: "Your sessions, newest first. The bin on a row deletes that entry.",
              target: "practice-entries",
            },
          ] satisfies TourStep[])),
      {
        id: "attendance-tallies",
        title: "The day's tally",
        body: "Present, late, absent, not attending and unmarked, counted for the day you're looking at.",
        path: "/dashboard/attendance",
        target: "attendance-tallies",
      },
      {
        id: "attendance-sheet",
        title: "The roll",
        body: "One row per person. Each chip marks present, late, absent or not attending; undo clears a mark.",
        target: "attendance-sheet",
      },
      {
        id: "attendance-calendar",
        title: "Overall attendance",
        body: "The month calendar and the totals behind everyone's marks — tap a day to open it.",
        target: "attendance-calendar",
      },
      {
        id: "messages-actions",
        title: "Notifications and new chats",
        body: "Turn notifications on, and — for teachers — start a new call or chat by searching the studio.",
        path: "/dashboard/messages",
        target: "messages-actions",
      },
      {
        id: "messages-list",
        title: "Your chats",
        body: "Every class room, group and private conversation you belong to, with unread counts.",
        target: "messages-list",
      },
      {
        id: "messages-thread",
        title: "The conversation",
        body: "The call button starts audio or video; the ⓘ panel lists members, media and links, and renames or deletes the chat.",
        target: "messages-thread",
      },
      {
        id: "messages-composer",
        title: "Write a message",
        body: "Attach a photo, video or voice note, send a GIF, and press Enter to send.",
        target: "messages-composer",
      },
    ];

    // The Practice Log can be switched off for the whole studio by the admin,
    // so a student is not shown a section they cannot open.
    if (!practiceEnabled && !isStaff) {
      for (const id of [
        "practice-form",
        "practice-post",
        "practice-range",
        "practice-entries",
      ]) {
        const at = list.findIndex((entry) => entry.id === id);
        if (at >= 0) list.splice(at, 1);
      }
    }

    if (isStaff) {
      list.push(
        {
          id: "classes-list",
          title: "Every class",
          body: "One vault per class. Copy its six-character code, or switch the whole app into that class.",
          path: "/dashboard/classes",
          target: "classes-list",
        },
        {
          id: "classes-new",
          title: "New class",
          body: "Name it once and you get a code to hand out — students enter it when they create their account.",
          target: "classes-new",
        },
      );
    }

    if (isAdmin) {
      list.push({
        id: "admin",
        title: "Admin",
        body: "Accounts, feature switches, password resets and removals all live behind the badge in the header — open it after the tour to look around.",
        target: "account",
      });
    }

    // The closing card is about the device, not a page, so it is read wherever
    // the reader happens to be.
    list.push({
      id: "pocket",
      title: "Keep it in your pocket",
      body: "Add NatyaVault to your home screen from your phone's browser menu. Turn on notifications in Messages so replies and new uploads reach your lock screen.",
    });

    return list;
  }, [isAdmin, isStaff, practiceEnabled]);

  // The role answer can remove a step just as the tour opens; keep the
  // counter inside the list even if that happens.
  const current = Math.min(index, steps.length - 1);
  const step = steps[current];
  const isLast = current >= steps.length - 1;

  // A stop can live on another page. The tour does not teleport the reader
  // there: it keeps its card up and spotlights the menu entry for that page,
  // which is clickable, so the reader walks to the next section themselves and
  // the tour carries on once they arrive.
  const page = step.path ? PAGES[step.path] : undefined;
  const awaitingPage = page !== undefined && pathname !== step.path;

  // Finishing and skipping both count as "seen" — the tour is offered once.
  const close = useCallback(() => {
    setOpenMobile(false);
    setIndex(0);
    onDone();
    void finish().catch(() => {
      // Nothing to recover: the overlay is dismissed either way.
    });
  }, [finish, onDone, setOpenMobile]);

  // On a phone the sidebar only exists once its drawer is open, so the menu
  // button is the entry the reader can actually press first.
  const target =
    awaitingPage && page
      ? isMobile
        ? "nav"
        : page.nav
      : step.target;

  // Measure the lit element every frame, so navigation, a scroll, a filter
  // change or a late font load all land in the right place.
  //
  // The memory of "already scrolled for this highlight" is keyed by the target
  // as well as the stop, because one stop can light two things in turn: the
  // menu entry while the reader walks to the page, then the section itself.
  // Keyed by the stop alone, the second highlight never came into view and sat
  // below the fold.
  useEffect(() => {
    if (!open || !target) return;
    let frame = 0;
    let cancelled = false;
    const scrollKey = `${step.id}:${target}`;
    const tick = () => {
      if (cancelled) return;
      const node = findTarget(target);
      if (node) {
        const rect = node.getBoundingClientRect();
        // Where the lit element counts as seen: clear of the sticky header,
        // and clear of the card when a phone docks it over the bottom of the
        // screen.
        const dockedTop =
          viewport.w < 640
            ? viewport.h - MARGIN - (cardHeight || 280)
            : viewport.h;
        const clear =
          rect.top >= HEADER_H + 12 &&
          rect.bottom <= Math.min(viewport.h - 16, dockedTop - GAP);
        if (!clear && scrolledFor.current !== scrollKey) {
          scrolledFor.current = scrollKey;
          node.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        setBoxes((prev) => {
          const next = {
            [target]: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
          };
          return sameBoxes(prev, next) ? prev : next;
        });
      } else {
        setBoxes((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [open, target, step.id, viewport.w, viewport.h, cardHeight]);

  // Panels are fixed, so a resize has to be measured rather than inherited.
  useEffect(() => {
    if (!open) return;
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // The drawer would cover the spotlight on a phone; the tour never needs it.
  useEffect(() => {
    if (!open) return;
    setOpenMobile(false);
  }, [open, setOpenMobile]);

  // The menu entry that opens the next page has nothing to point at while the
  // sidebar is collapsed, so the tour expands it.
  useEffect(() => {
    if (!open || isMobile || !awaitingPage) return;
    setOpen(true);
  }, [open, isMobile, awaitingPage, setOpen]);

  // The card's height decides where it can sit, so measure it rather than
  // guessing.
  useEffect(() => {
    const el = cardRef.current;
    if (!open || !el) return;
    const update = () => setCardHeight(el.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, step.id]);

  // Keyboard: arrows step through, Escape skips — never while typing.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      const typing =
        element !== null &&
        (element.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
      if (typing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowRight") {
        // A stop waiting on the menu is not skipped with the keyboard.
        if (awaitingPage) return;
        setIndex((i) => Math.min(steps.length - 1, i + 1));
      } else if (event.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, steps.length, awaitingPage]);

  // The walkthrough owns the screen: put focus on the card as each stop
  // appears so the keyboard and screen reader follow along.
  useEffect(() => {
    if (!open) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [open, step.id]);

  const rawSpot = target ? boxes[target] : undefined;
  const hole = rawSpot ? clampToViewport(rawSpot, viewport.w, viewport.h) : null;

  // Place the card beside the spotlight when there is room; otherwise above,
  // below, or centred. A phone uses a full-width card docked to the bottom.
  const placement = useMemo<Placement>(() => {
    if (viewport.w < 640) {
      return { kind: "dock", left: MARGIN, right: MARGIN, bottom: MARGIN };
    }
    if (!hole) return { kind: "center" };

    const width = CARD_W;
    const height = cardHeight || 260;
    const centerX = hole.left + hole.width / 2;
    const centerY = hole.top + hole.height / 2;
    const roomRight = viewport.w - (hole.left + hole.width) - MARGIN;
    const roomLeft = hole.left - MARGIN;
    const roomBelow = viewport.h - (hole.top + hole.height) - MARGIN;
    const roomAbove = hole.top - MARGIN;

    if (roomRight >= width + GAP) {
      const top = clamp(
        centerY - height / 2,
        MARGIN,
        viewport.h - height - MARGIN,
      );
      return {
        kind: "anchor",
        side: "right",
        left: hole.left + hole.width + GAP,
        top,
        arrow: clamp(centerY - top, 20, height - 20),
      };
    }
    if (roomLeft >= width + GAP) {
      const top = clamp(
        centerY - height / 2,
        MARGIN,
        viewport.h - height - MARGIN,
      );
      return {
        kind: "anchor",
        side: "left",
        left: hole.left - GAP - width,
        top,
        arrow: clamp(centerY - top, 20, height - 20),
      };
    }
    if (roomBelow >= height + GAP) {
      const left = clamp(
        centerX - width / 2,
        MARGIN,
        viewport.w - width - MARGIN,
      );
      return {
        kind: "anchor",
        side: "bottom",
        left,
        top: hole.top + hole.height + GAP,
        arrow: clamp(centerX - left, 20, width - 20),
      };
    }
    if (roomAbove >= height + GAP) {
      const left = clamp(
        centerX - width / 2,
        MARGIN,
        viewport.w - width - MARGIN,
      );
      return {
        kind: "anchor",
        side: "top",
        left,
        top: hole.top - GAP - height,
        arrow: clamp(centerX - left, 20, width - 20),
      };
    }
    return { kind: "center" };
  }, [hole, cardHeight, viewport.w, viewport.h]);

  if (!open) return null;

  const cardStyle: CSSProperties =
    placement.kind === "anchor"
      ? { left: placement.left, top: placement.top, width: CARD_W }
      : placement.kind === "dock"
        ? {
            left: placement.left,
            right: placement.right,
            bottom: placement.bottom,
          }
        : {
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: `min(${CARD_W}px, calc(100vw - 2rem))`,
          };

  const arrowStyle: CSSProperties =
    placement.kind !== "anchor"
      ? {}
      : placement.side === "left" || placement.side === "right"
        ? { top: placement.arrow - 6 }
        : { left: placement.arrow - 6 };

  // The shade is one shape with the lit area punched out as a rounded hole
  // (a huge spread shadow, which follows the hole's radius), so its inner edge
  // sits exactly on the gold frame instead of four square-cornered panels
  // meeting around it.
  const shade = hole
    ? {
        top: hole.top,
        left: hole.left,
        width: hole.width,
        height: hole.height,
        borderRadius: HOLE_RADIUS,
        boxShadow: "0 0 0 100vmax rgba(20,14,11,0.72)",
      }
    : { top: 0, left: 0, width: viewport.w, height: viewport.h };

  // Invisible panels around the hole swallow taps in the darkened part, so the
  // only thing that can be pressed is the spotlit element itself.
  const blockers = hole
    ? [
        { top: 0, left: 0, width: viewport.w, height: hole.top },
        {
          top: hole.top + hole.height,
          left: 0,
          width: viewport.w,
          height: Math.max(0, viewport.h - (hole.top + hole.height)),
        },
        { top: hole.top, left: 0, width: hole.left, height: hole.height },
        {
          top: hole.top,
          left: hole.left + hole.width,
          width: Math.max(0, viewport.w - (hole.left + hole.width)),
          height: hole.height,
        },
      ].filter((panel) => panel.width > 0 && panel.height > 0)
    : [];

  return (
    <>
      <div
        aria-hidden
        className={cn(
          "fixed z-30",
          // Without a lit element the shade has to swallow taps (a stop with
          // nothing to point at). While the tour is waiting on the menu it
          // must not, or a phone whose menu entry has not rendered yet would
          // be stuck behind the dim.
          hole || awaitingPage ? "pointer-events-none" : "",
          hole ? "" : "bg-[#140e0b]/70",
        )}
        style={shade}
      />

      {blockers.map((panel, i) => (
        <div
          key={i}
          aria-hidden
          className="fixed z-30"
          style={{
            top: panel.top,
            left: panel.left,
            width: panel.width,
            height: panel.height,
          }}
        />
      ))}

      {/* The lit cut-out: frame only, so the element underneath stays live and
          the reader can open and explore whatever is highlighted. */}
      {hole && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[31] ring-2 ring-gold shadow-[0_0_0_5px_rgba(217,168,78,0.18)]"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            borderRadius: HOLE_RADIUS,
          }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className="fixed z-40 flex flex-col rounded-2xl border-2 border-gold bg-card p-4 text-card-foreground shadow-[0_24px_60px_-16px_rgba(48,28,18,0.55)] ring-1 ring-black/5 outline-none"
        style={cardStyle}
      >
        {/* A small pointer joins the card to the element it explains. */}
        {placement.kind === "anchor" && (
          <span
            aria-hidden
            className={cn(
              "absolute size-3 rotate-45 border-gold bg-card",
              placement.side === "right" && "-left-[7px] border-b border-l",
              placement.side === "left" && "-right-[7px] border-t border-r",
              placement.side === "bottom" && "-top-[7px] border-t border-l",
              placement.side === "top" && "-bottom-[7px] border-r border-b",
            )}
            style={arrowStyle}
          />
        )}

        <div className="flex items-start justify-between gap-3">
          <p className="pt-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Step {current + 1} of {steps.length}
          </p>
          <button
            type="button"
            onClick={close}
            aria-label="Skip the tour"
            title="Skip the tour"
            className="-mt-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <X className="size-4" />
          </button>
        </div>

        <h2
          id="tour-title"
          className="mt-1 text-[17px] leading-snug font-semibold tracking-tight text-foreground"
        >
          {awaitingPage && page ? `Next: ${page.label}` : step.title}
        </h2>
        <p
          id="tour-body"
          className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground"
        >
          {awaitingPage && page
            ? isMobile
              ? `Open the menu at the top and tap ${page.label}. The tour carries on once you are there.`
              : `Tap ${page.label} in the menu on the left — it is highlighted for you. The tour carries on once you are there.`
            : step.body}
        </p>

        <div className="mt-4 flex flex-col gap-2.5 border-t border-border/70 pt-3">
          <div className="flex flex-wrap items-center gap-1">
            {steps.map((entry, i) => (
              <span
                key={entry.id}
                aria-hidden
                className={cn(
                  "h-1 rounded-full transition-all",
                  i === current
                    ? "w-4 bg-primary"
                    : i < current
                      ? "w-1 bg-primary/35"
                      : "w-1 bg-border",
                )}
              />
            ))}
          </div>
          <div className="flex items-center justify-end gap-2">
            {current > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                Back
              </Button>
            )}
            {awaitingPage && page ? (
              <span className="flex items-center gap-1.5 pr-1 text-[11px] font-medium text-muted-foreground">
                <span className="size-1.5 rounded-full bg-gold" />
                Waiting for {page.label}
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => (isLast ? close() : setIndex((i) => i + 1))}
              >
                {isLast ? "Start using it" : "Next"}
                {!isLast && <ArrowRight className="size-4" />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
