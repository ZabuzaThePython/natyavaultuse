/**
 * A live call for one chat.
 *
 * Group calls do not go peer to peer: every device publishes one stream to a
 * LiveKit SFU and subscribes to the others, which is what lets a whole class
 * be on one call without each phone uploading a copy per person. The browser
 * only ever sees a short-lived token from convex/calls.ts; the LiveKit API
 * secret stays on the deployment.
 *
 * Above CAMERA_LIMIT people the call starts with cameras off (anyone can turn
 * theirs on), because a roomful of 30 phone cameras is what turns a call into
 * a slideshow.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { shortNames } from "@/lib/display-name";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import {
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Users,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { Room, RoomEvent, Track, type Participant } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Above this many people a call starts with the camera off. */
const CAMERA_LIMIT = 9;

/** How often a person in a call says "still here", so the chat's banner goes
 * away when everyone closes the app instead of hanging around for hours. */
const HEARTBEAT_MS = 30_000;

type Phase = "connecting" | "live" | "failed" | "unconfigured";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "");
}

/** One person in the call: their video, a name plate, and a mute marker. */
function CallTile({
  participant,
  revision,
  isLocal,
  label,
}: {
  participant: Participant;
  revision: number;
  isLocal: boolean;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const camera = participant.getTrackPublication(Track.Source.Camera);
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const cameraOn = Boolean(camera?.track && !camera.isMuted);
  const micOn = Boolean(microphone?.track && !microphone.isMuted);
  const name = participant.name?.trim() || participant.identity;

  // Attach (and re-attach) the media elements whenever tracks change. `revision`
  // is what re-runs this after a mute, a camera toggle, or a new subscriber.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const track = camera?.track;
    if (!track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [revision, camera, camera?.track]);

  // Remote microphones play through a hidden audio element; the local one is
  // never attached, or you would hear yourself.
  useEffect(() => {
    const element = audioRef.current;
    if (!element || isLocal) return;
    const track = participant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [revision, isLocal, participant]);

  return (
    <div
      className={`relative overflow-hidden rounded-xl border bg-muted/40 ${
        participant.isSpeaking
          ? "border-emerald-500/70 shadow-[0_0_0_2px_rgba(16,185,129,0.25)]"
          : "border-border/70"
      }`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`aspect-video h-full w-full object-cover ${cameraOn ? "" : "invisible"}`}
        style={isLocal ? { transform: "scaleX(-1)" } : undefined}
      />
      {!cameraOn && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
          <span className="flex size-10 items-center justify-center rounded-full bg-background/70 text-sm font-semibold">
            {initials(name)}
          </span>
          <span className="text-[10px]">Camera off</span>
        </div>
      )}
      <audio ref={audioRef} autoPlay />
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 text-[11px] text-white">
        {micOn ? (
          <Mic className="size-3 shrink-0" />
        ) : (
          <MicOff className="size-3 shrink-0 text-red-300" />
        )}
        <span className="truncate">
          {label}
          {isLocal ? " (you)" : ""}
        </span>
      </div>
    </div>
  );
}

export function CallDialog({
  chatId,
  chatTitle,
  open,
  onOpenChange,
}: {
  chatId: Id<"chats"> | null;
  chatTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mintToken = useAction(api.calls.token);
  const startCall = useMutation(api.callState.start);
  const endCall = useMutation(api.callState.end);
  const touch = useMutation(api.callState.touch);

  const [phase, setPhase] = useState<Phase>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [revision, setRevision] = useState(0);
  // Bumped by "Try again", so a retry is a new join.
  const [attempt, setAttempt] = useState(0);
  const roomRef = useRef<Room | null>(null);
  // Only the newest join may write state (React may run the effect twice).
  const joinId = useRef(0);

  const bump = useCallback(() => setRevision((value) => value + 1), []);

  // Join on open, leave on close.
  useEffect(() => {
    if (!open || chatId === null) return;
    const id = ++joinId.current;
    let cancelled = false;

    const connect = async () => {
      setPhase("connecting");
      setMessage(null);
      // Whether this browser is the one that opened the call, so a failed
      // connect can close it again instead of leaving an empty room showing.
      let openedCall = false;
      try {
        const minted = await mintToken({ chatId });
        if (cancelled || joinId.current !== id) return;
        if (!minted.configured) {
          setPhase("unconfigured");
          return;
        }
        if (!minted.ok || !minted.token || !minted.url) {
          setPhase("failed");
          setMessage(minted.error ?? "Couldn't start the call. Try again.");
          return;
        }

        // Record the call first, so the rest of the chat sees it even if this
        // browser is the only one in the room.
        const started = await startCall({ chatId }).catch(() => null);
        openedCall = started?.ok === true && !started.alreadyLive;
        if (cancelled || joinId.current !== id) return;

        const next = new Room({
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: {
            resolution: { width: 640, height: 360, frameRate: 24 },
          },
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        roomRef.current = next;

        next
          .on(RoomEvent.ParticipantConnected, bump)
          .on(RoomEvent.ParticipantDisconnected, bump)
          .on(RoomEvent.TrackSubscribed, bump)
          .on(RoomEvent.TrackUnsubscribed, bump)
          .on(RoomEvent.TrackPublished, bump)
          .on(RoomEvent.TrackUnpublished, bump)
          .on(RoomEvent.TrackMuted, bump)
          .on(RoomEvent.TrackUnmuted, bump)
          .on(RoomEvent.LocalTrackPublished, bump)
          .on(RoomEvent.LocalTrackUnpublished, bump)
          .on(RoomEvent.ActiveSpeakersChanged, bump)
          .on(RoomEvent.ConnectionStateChanged, bump)
          .on(RoomEvent.Disconnected, () => {
            // Only a drop we did not ask for: `leave` clears the ref first.
            if (roomRef.current !== next) return;
            roomRef.current = null;
            setRoom(null);
            setPhase("failed");
            setMessage("The call ended. Tap Try again to rejoin.");
          });

        await next.connect(minted.url, minted.token);
        if (cancelled || joinId.current !== id) {
          void next.disconnect();
          return;
        }

        setRoom(next);
        setPhase("live");
        bump();

        // Browsers only allow audio after a tap, and opening the call was one.
        // iOS is stricter and may still refuse (the connect is async, so the
        // tap is no longer "current"), which is what the sound button below is
        // for.
        await next.startAudio().catch(() => {});
        bump();
        await next.localParticipant.setMicrophoneEnabled(true).catch(() => {});
        const many = next.remoteParticipants.size + 1 > CAMERA_LIMIT;
        await next.localParticipant.setCameraEnabled(!many).catch(() => {});
        bump();
      } catch (error) {
        if (cancelled || joinId.current !== id) return;
        console.error("Call failed:", error);
        if (openedCall) void endCall({ chatId }).catch(() => {});
        setPhase("failed");
        setMessage(
          "Couldn't connect to the call. Check your connection and try again.",
        );
      }
    };

    void connect();

    return () => {
      cancelled = true;
      const current = roomRef.current;
      roomRef.current = null;
      setRoom(null);
      if (current) {
        current.removeAllListeners();
        void current.disconnect();
      }
    };
  }, [open, chatId, attempt, mintToken, startCall, endCall, bump]);

  // While in the call, say so, so the chat's "call live" banner is accurate.
  useEffect(() => {
    if (!open || chatId === null || phase !== "live") return;
    void touch({ chatId }).catch(() => {});
    const timer = setInterval(() => {
      void touch({ chatId }).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [open, chatId, phase, touch]);

  const leave = useCallback(() => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    if (current) {
      const alone = current.remoteParticipants.size === 0;
      current.removeAllListeners();
      void current.disconnect();
      // If nobody is left, close the call for the chat. Otherwise it stays
      // live and the others keep it alive with their own heartbeats.
      if (alone && chatId !== null) void endCall({ chatId }).catch(() => {});
    }
    onOpenChange(false);
  }, [chatId, endCall, onOpenChange]);

  const local = room?.localParticipant ?? null;
  const micOn = local?.isMicrophoneEnabled ?? false;
  const cameraOn = local?.isCameraEnabled ?? false;
  const people: Participant[] = room
    ? [room.localParticipant, ...room.remoteParticipants.values()]
    : [];
  // First names on the tiles, with a last initial when two people on the call
  // share one (see lib/display-name).
  const nameLabels = shortNames(
    people.map((person) => person.name?.trim() || person.identity),
  );

  // Every tap in the call retries the audio unlock, so the first button you
  // press on iOS is enough to hear people.
  const enableSound = useCallback(() => {
    const current = roomRef.current;
    if (!current) return;
    void current.startAudio().then(bump).catch(() => {});
  }, [bump]);

  const toggleMic = () => {
    if (!room) return;
    enableSound();
    void room.localParticipant
      .setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled)
      .catch(() => {})
      .finally(bump);
  };

  const toggleCamera = () => {
    if (!room) return;
    enableSound();
    void room.localParticipant
      .setCameraEnabled(!room.localParticipant.isCameraEnabled)
      .catch(() => {})
      .finally(bump);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) leave();
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <div className="flex items-center gap-2 border-b border-border/70 py-3 pr-11 pl-4">
          <span className="relative flex size-2.5 shrink-0">
            {phase === "live" && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            )}
            <span
              className={`relative inline-flex size-2.5 rounded-full ${
                phase === "live" ? "bg-emerald-500" : "bg-muted-foreground/50"
              }`}
            />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">
              {chatTitle || "Call"}
            </DialogTitle>
            <DialogDescription className="truncate text-[11px]">
              {phase === "connecting"
                ? "Connecting to the call…"
                : phase === "live"
                  ? `In the call · ${people.length} ${
                      people.length === 1 ? "person" : "people"
                    }`
                  : "Not in the call"}
            </DialogDescription>
          </div>
          {phase === "live" && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Users className="size-3.5" />
              {people.length}
            </span>
          )}
        </div>

        {phase === "unconfigured" ? (
          <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm">
            <p className="font-medium">Calls aren't set up yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              This deployment has no LiveKit project. Create a free one at
              livekit.io, then add <code>LIVEKIT_URL</code>,{" "}
              <code>LIVEKIT_API_KEY</code> and <code>LIVEKIT_API_SECRET</code>{" "}
              in the Keys tab — calls work as soon as they are there.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        ) : phase === "failed" ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <p className="text-sm">{message ?? "The call didn't connect."}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={leave}>
                Close
              </Button>
            </div>
          </div>
        ) : phase === "connecting" || room === null ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <p>Joining the call…</p>
            <p className="max-w-xs text-[11px]">
              Allow the microphone and camera when your browser asks.
            </p>
          </div>
        ) : (
          <div className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2 sm:grid-cols-3 sm:p-3 lg:grid-cols-4">
            {people.map((participant) => {
              const fullName = participant.name?.trim() || participant.identity;
              return (
                <CallTile
                  key={participant.identity}
                  participant={participant}
                  revision={revision}
                  isLocal={participant === room.localParticipant}
                  label={nameLabels.get(fullName) ?? fullName}
                />
              );
            })}
          </div>
        )}

        {phase === "live" && room !== null && !room.canPlaybackAudio && (
          <div className="border-t border-amber-500/40 bg-amber-500/10 px-4 py-2">
            <Button
              type="button"
              size="sm"
              className="w-full gap-2"
              onClick={enableSound}
            >
              <Volume2 className="size-4" />
              Tap to hear the call
            </Button>
          </div>
        )}

        {phase === "live" && (
          <div className="flex items-center justify-center gap-2 border-t border-border/70 px-4 py-3">
            <Button
              type="button"
              variant={micOn ? "outline" : "destructive"}
              size="icon"
              className="size-11 rounded-full"
              aria-label={micOn ? "Mute your microphone" : "Unmute your microphone"}
              title={micOn ? "Mute" : "Unmute"}
              onClick={toggleMic}
            >
              {micOn ? <Mic /> : <MicOff />}
            </Button>
            <Button
              type="button"
              variant={cameraOn ? "outline" : "secondary"}
              size="icon"
              className="size-11 rounded-full"
              aria-label={cameraOn ? "Turn your camera off" : "Turn your camera on"}
              title={cameraOn ? "Camera off" : "Camera on"}
              onClick={toggleCamera}
            >
              {cameraOn ? <Video /> : <VideoOff />}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="size-11 rounded-full"
              aria-label="Leave the call"
              title="Leave the call"
              onClick={leave}
            >
              <PhoneOff />
            </Button>
            {people.length > CAMERA_LIMIT && (
              <p className="ml-1 max-w-[9rem] text-[11px] leading-tight text-muted-foreground">
                Big call — cameras start off to keep it smooth.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
