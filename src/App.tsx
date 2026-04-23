import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Keep, Pass, DiffSegment, ServerMsg, Stage } from "../shared/types";

const circled = (label: string) => {
  const code = label.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return label;
  return String.fromCodePoint(0x24d0 + (code - 65));
};

export default function App() {
  const [ready, setReady] = useState(false);
  // ★ THE single source of truth for which phase the user is in. Server
  // explicitly sends `stage` messages at every transition. Every phase-scoped
  // state (ask/hints/pass/revision) is kept in sync around this.
  const [stage, setStage] = useState<Stage>("idle");
  const [ask, setAsk] = useState<string | null>(null);
  const [pass, setPass] = useState<Pass | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [revision, setRevision] = useState<{ segments: DiffSegment[]; original: string } | null>(null);
  const [interim, setInterim] = useState("");
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [awaiting, setAwaiting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recordingRef = useRef(false);
  // Mirror hints into a ref so the TTS onEnd callback (which is created inside
  // the "tts" msg handler with a stale closure) can read the CURRENT hints.
  const hintsRef = useRef<string[]>([]);
  useEffect(() => {
    hintsRef.current = hints;
  }, [hints]);
  // Same treatment for revision so onEnd can tell when to clear the ask.
  const revisionRef = useRef<{ segments: DiffSegment[]; original: string } | null>(null);
  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);
  const audioRef = useRef<{
    ctx: AudioContext;
    node: AudioWorkletNode;
    src: MediaStreamAudioSourceNode;
    stream: MediaStream;
    mute: GainNode;
  } | null>(null);
  // Persisted across turns so subsequent taps skip the AudioContext +
  // worklet-module load (saves ~100-300ms on repeat recordings).
  const persistentCtxRef = useRef<AudioContext | null>(null);
  const persistentMuteRef = useRef<GainNode | null>(null);
  const persistentStreamRef = useRef<MediaStream | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsStreamRef = useRef<TtsStreamState | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          setReady(true);
          ws.send(JSON.stringify({ type: "hello" }));
          break;
        case "phase":
          break;
        case "stage":
          // Entering a new phase — wipe any lingering user-speech state so
          // transcription starts EMPTY for each phase's "you speak" moment.
          setStage(msg.stage);
          setInterim("");
          setAwaiting(false);
          break;
        case "ask":
          // Hold onto the user's transcription + Thinking dots until TTS
          // actually starts playing — don't clear interim/awaiting here.
          setAsk(msg.question || null);
          break;
        case "hints":
          setHints(msg.items);
          break;
        case "pass":
          // pass has no TTS — clear immediately so the plan takes focus.
          setPass(msg.pass);
          setInterim("");
          setAwaiting(false);
          break;
        case "revision":
          setRevision({ segments: msg.segments, original: msg.original });
          setInterim("");
          setAwaiting(false);
          break;
        case "interim":
        case "final":
          setInterim(msg.text);
          break;
        case "tts_start":
          startTtsStream(
            msg.mime,
            ttsAudioRef,
            ttsStreamRef,
            (v) => {
              setSpeaking(v);
              if (v) {
                // First audio frame playing — take down the user's text
                // + thinking dots.
                setAwaiting(false);
                setInterim("");
              }
            },
            () => {
              // Clear the ask when there's a follow-up view to reveal
              // (hints, or a revision diff). Otherwise keep the subtitle
              // up until the user taps.
              if (hintsRef.current.length > 0 || revisionRef.current) {
                setAsk(null);
              }
            },
          );
          break;
        case "tts_chunk":
          appendTtsChunk(msg.chunk, ttsStreamRef);
          break;
        case "tts_end":
          endTtsStream(ttsStreamRef);
          break;
        case "error":
          console.error("[server error]", msg.message);
          setAwaiting(false);
          break;
      }
    };
    ws.onerror = (e) => {
      console.error("[ws] error", e);
    };
    ws.onclose = () => {
      setReady(false);
    };

    return () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    };
  }, []);

  const teardownAudio = () => {
    const a = audioRef.current;
    if (!a) return;
    // Disconnect the per-turn graph but KEEP the AudioContext + worklet-module
    // + mute node + media stream alive for the next tap. This avoids paying
    // ~100-300ms of getUserMedia + audioWorklet.addModule on every recording.
    try { a.node.disconnect(); } catch {}
    try { a.src.disconnect(); } catch {}
    audioRef.current = null;
  };

  const startTalk = useCallback(async () => {
    if (!ready || recordingRef.current) return;
    setInterim("");
    setAsk(null);
    setAwaiting(false);
    // Deliberately DON'T clear `revision` here — during the read-back phase
    // the user is reading FROM the cleaned-up version, so it must stay
    // visible in MIDDLE while they record. It'll get replaced when the
    // server sends a new revision or cleared explicitly when the session
    // moves past that phase.
    if (ttsAudioRef.current) {
      try { ttsAudioRef.current.pause(); } catch {}
    }
    // Force-tear down any in-flight TTS stream so the user's tap starts clean.
    endTtsStream(ttsStreamRef, true);
    try {
      // Reuse or create the MediaStream. Browsers cache permission, so the
      // second call is effectively instant; but keeping the same stream saves
      // another renegotiation round-trip.
      let stream = persistentStreamRef.current;
      if (!stream || !stream.active || !stream.getTracks().some((t) => t.readyState === "live")) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
        });
        persistentStreamRef.current = stream;
      }

      // Reuse or create the AudioContext + load the worklet module exactly once.
      let ctx = persistentCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext({ sampleRate: 16000 });
        if (Math.abs(ctx.sampleRate - 16000) > 1) {
          console.warn(`[audio] sample rate ${ctx.sampleRate}, expected 16000 — STT may degrade`);
        }
        await ctx.audioWorklet.addModule("/pcm-worklet.js");
        persistentCtxRef.current = ctx;
        const mute = ctx.createGain();
        mute.gain.value = 0;
        mute.connect(ctx.destination);
        persistentMuteRef.current = mute;
      } else if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch {}
      }
      const mute = persistentMuteRef.current!;

      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-encoder");
      node.port.onmessage = (e) => {
        if (!recordingRef.current) return;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };
      src.connect(node);
      node.connect(mute);
      audioRef.current = { ctx, node, src, stream, mute };
    } catch (e: any) {
      console.error("[mic error]", e);
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "start_turn" }));
    recordingRef.current = true;
    setRecording(true);
  }, [ready]);

  const stopTalk = useCallback(() => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setAwaiting(true);
    teardownAudio();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end_turn" }));
    }
  }, []);

  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTyping()) return;
      e.preventDefault();
      if (recordingRef.current) stopTalk();
      else void startTalk();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [startTalk, stopTalk]);

  const firstTurn = !ask && !pass && hints.length === 0;
  // Never show the HoldHint between "user finished speaking" and "Pingo replied"
  // — i.e. during awaiting, or while Pingo is speaking.
  const showHoldHint =
    firstTurn && !recording && !speaking && !awaiting;

  // MIDDLE rendering is now dispatched strictly by `stage`. Each stage owns
  // what shows below the button. `ask` is still allowed to suppress MIDDLE
  // while Pingo is actively speaking so the subtitle holds the screen.
  //
  //   stage       MIDDLE content
  //   ─────       ──────────────
  //   idle        (nothing)
  //   brief       (nothing — waiting for user to describe their target)
  //   orient      <Hints> — 4 fill-in-the-blank stems
  //   cloze       <Hints> — polished paragraph with blanks
  //   revision    <RevisionView> — clean diff to read back
  //   done        <DonePanel> — "deliver it clean." + memory hints below
  const showHints = !ask && hints.length > 0;
  const hasMiddle =
    stage === "orient" ||
    stage === "cloze" ||
    stage === "revision" ||
    stage === "done";

  // Layout:
  //   - hasMiddle  → 50/50 split between TOP (Atom speech) and MIDDLE (hints).
  //     Neither side can starve the other. Overflow in either zone scrolls
  //     inside its own ScrollArea.
  //   - no MIDDLE  → TOP fills (idle / brief / pingo speaking alone).
  const gridRows = hasMiddle
    ? "grid-rows-[1fr_1fr_auto]"        // 50/50
    : "grid-rows-[1fr_auto_auto]";      // TOP fills when alone
  const topGrows = !hasMiddle;

  return (
    <div className={`h-screen grid ${gridRows} relative`}>
      {/* TOP — ephemeral content: transcript | subtitle | first-turn hint */}
      <section className={`min-h-0 overflow-hidden px-8 md:px-12 ${topGrows ? "pt-4 md:pt-5 pb-0" : "pt-3 md:pt-4 pb-0"}`}>
        {showHoldHint ? (
          <HoldHint />
        ) : (
          <ScrollArea
            anchor={recording ? "bottom" : "center"}
            scrollKey={
              recording
                ? `rec:${interim.length}`
                : awaiting
                  ? `await:${interim.length}`
                  : ask
                    ? `ask:${ask}`
                    : "empty"
            }
            className="h-full"
          >
            <div className="w-full max-w-7xl mx-auto">
              {recording ? (
                // Live transcription while user is speaking this phase.
                <Subtitle speaker="you" text={interim} live />
              ) : ask ? (
                // Pingo is speaking (or paused between TTS and user tap).
                <Subtitle speaker="pingo" text={ask} />
              ) : interim ? (
                // User just finished (or is between awaiting and settle) —
                // show their utterance. `interim` is cleared by the stage
                // handler whenever a new phase begins, so this never ghosts
                // text from a previous phase into the current one.
                <Subtitle speaker="you" text={interim} />
              ) : null}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* MIDDLE — persistent: hints / cloze / revision / pass panel */}
      <section className="min-h-0 overflow-hidden px-8 md:px-12 pt-0 pb-2 md:pb-3">
        {hasMiddle && !ask && (
          <ScrollArea
            anchor="top"
            scrollKey={`mid:${stage}:${hints.join("|")}:${pass?.round ?? 0}`}
            className="h-full"
          >
            <div className="w-full max-w-7xl mx-auto space-y-10 md:space-y-14">
              {/* ── Stage: orient ── 4 fill-in-the-blank stems */}
              {stage === "orient" && hints.length > 0 && <Hints items={hints} />}

              {/* ── Stage: cloze ── polished paragraph with blanks */}
              {stage === "cloze" && hints.length > 0 && <Hints items={hints} />}

              {/* ── Stage: revision ── clean-up diff to read back */}
              {stage === "revision" && revision && (
                <RevisionView segments={revision.segments} />
              )}

              {/* ── Stage: done ── memory hints only.
                 "Alright. Now deliver it clean." is Pingo's spoken intro —
                 it shows as the Pingo subtitle in TOP during TTS. After TTS
                 ends, TOP goes empty (or Atom's live transcription starts)
                 and MIDDLE shows the memory hints, same shape as orient/cloze. */}
              {stage === "done" && hints.length > 0 && <Hints items={hints} />}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* BOTTOM — push-to-talk button anchored to the bottom edge */}
      <section className="flex justify-center pt-2 pb-6 md:pb-8 shrink-0">
        <TalkButton
          recording={recording}
          speaking={speaking}
          thinking={awaiting}
          disabled={!ready}
          onStart={startTalk}
          onStop={stopTalk}
        />
      </section>
    </div>
  );
}

/* ── ScrollArea ──────────────────────────────────────────────── */

function ScrollArea({
  anchor,
  scrollKey,
  className = "",
  children,
}: {
  anchor: "top" | "center" | "bottom";
  scrollKey: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Reset scroll position whenever the content identity (scrollKey) changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (anchor === "bottom") el.scrollTop = el.scrollHeight;
    else if (anchor === "center")
      el.scrollTop = Math.max(0, (el.scrollHeight - el.clientHeight) / 2);
    else el.scrollTop = 0;
  }, [scrollKey, anchor]);

  // For bottom-anchored content (live transcription) keep pinning to the bottom
  // as content grows, using ResizeObserver on the inner content.
  useLayoutEffect(() => {
    if (anchor !== "bottom") return;
    const el = ref.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [anchor]);

  return (
    <div ref={ref} className={`scroll-fade overflow-y-auto ${className}`}>
      {/*
        Tight inner py (8px) pairs with the smaller fade mask (8px in
        index.css) so the gap between stacked ScrollAreas stays minimal
        while content still clears the fade zone.
      */}
      <div
        className={[
          "min-h-full flex flex-col py-4",
          anchor === "bottom"
            ? "justify-end"
            : anchor === "center"
              ? "justify-center"
              : "justify-start",
        ].join(" ")}
      >
        {children}
      </div>
    </div>
  );
}

/* ── TOP (ephemeral) ─────────────────────────────────────────── */

function SpeakerLabel({
  speaker,
  className = "",
}: {
  speaker: "pingo" | "you";
  className?: string;
}) {
  const color = speaker === "pingo" ? "text-pingo-600" : "text-cream-500";
  const label = speaker === "pingo" ? "Pingo" : "Atom";
  return (
    <div
      className={[
        "font-mono text-[14px] md:text-[16px] tracking-[0.24em] mb-3 md:mb-4 select-none font-semibold",
        color,
        className,
      ].join(" ")}
    >
      {label}
    </div>
  );
}

function Subtitle({
  speaker,
  text,
  live = false,
}: {
  speaker: "pingo" | "you";
  text: string;
  live?: boolean;
}) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const isPingo = speaker === "pingo";

  const align = isPingo ? "text-center" : "text-left";
  const bodyCls = isPingo
    ? "text-cream-900 font-sans text-[28px] md:text-[44px] leading-[1.25] font-bold tracking-[-0.018em]"
    : "text-cream-900 font-sans text-[24px] md:text-[36px] leading-[1.35] font-medium tracking-[-0.01em]";
  const stack = "space-y-4 md:space-y-6";

  return (
    <div key={`${speaker}-${text}`} className={`animate-fade-in ${align}`}>
      <SpeakerLabel speaker={speaker} />
      {lines.length === 0 ? (
        <p className={`${bodyCls} text-cream-400 italic font-normal`}>
          listening…
          {live && <Caret />}
        </p>
      ) : (
        <div className={stack}>
          {lines.map((l, i) => (
            <p key={i} className={bodyCls}>
              {l}
              {live && i === lines.length - 1 && <Caret />}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function HoldHint() {
  return (
    <div className="h-full flex items-center justify-center">
      <span className="text-pingo-600 font-mono text-[22px] md:text-[26px] tracking-[0.22em] uppercase select-none font-semibold animate-shine">
        tap to speak
      </span>
    </div>
  );
}

function Hints({ items }: { items: string[] }) {
  return (
    <ul className="stagger space-y-4 md:space-y-6 text-left">
      {items.map((h, i) => (
        <li
          key={i}
          className="font-sans text-[22px] md:text-[28px] leading-[1.75] font-medium text-cream-900 tracking-[-0.005em]"
        >
          {renderWithPlaceholders(h)}
        </li>
      ))}
    </ul>
  );
}

function renderWithPlaceholders(text: string): ReactNode[] {
  const parts = text.split(/(\[[^\]]+\])/g);
  return parts.map((part, i) => {
    if (/^\[[^\]]+\]$/.test(part)) {
      return (
        <span
          key={i}
          className="inline italic font-normal text-sun-700 bg-sun-100 rounded px-[6px] mx-[2px]"
        >
          {part.slice(1, -1)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function Thinking() {
  return (
    <div className="text-center animate-fade-in">
      <SpeakerLabel speaker="pingo" />
      <div className="flex items-center justify-center gap-3 md:gap-4 h-[52px] md:h-[64px]">
        <ThinkDot />
        <ThinkDot delay={160} />
        <ThinkDot delay={320} />
      </div>
    </div>
  );
}

function ThinkDot({ delay = 0 }: { delay?: number }) {
  return (
    <span
      className="inline-block w-[8px] h-[8px] md:w-[10px] md:h-[10px] rounded-full bg-pingo-500 animate-think-dot"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

function Transcript({ utterance, keeps }: { utterance: string; keeps: Keep[] }) {
  const sorted = [...keeps].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((k, i) => {
    if (cursor < k.start) {
      parts.push(
        <span key={`t${i}`} className="text-cream-500">
          {utterance.slice(cursor, k.start)}
        </span>,
      );
    }
    parts.push(
      <Highlight
        key={`k${i}`}
        keep={k}
        text={utterance.slice(k.start, k.end)}
        delayMs={i * 70}
      />,
    );
    cursor = k.end;
  });
  if (cursor < utterance.length) {
    parts.push(
      <span key="tail" className="text-cream-500">
        {utterance.slice(cursor)}
      </span>,
    );
  }
  return (
    <p className="text-[22px] md:text-[26px] leading-[1.72] font-sans tracking-[0] text-cream-900">
      {parts}
    </p>
  );
}

function Highlight({
  keep,
  text,
  delayMs,
}: {
  keep: Keep;
  text: string;
  delayMs: number;
}) {
  return (
    <span
      className="highlight-sweep highlight-sweep-animate text-cream-900"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <span className="text-sun-700 font-bold mr-[3px] select-none">
        {circled(keep.label)}
      </span>
      {text}
    </span>
  );
}

function RevisionView({ segments }: { segments: DiffSegment[] }) {
  return (
    <div className="animate-fade-in">
      <SpeakerLabel speaker="pingo" />
      <p className="text-[22px] md:text-[26px] leading-[1.72] font-sans tracking-[-0.005em]">
        {segments.map((seg, i) => {
          if (seg.type === "keep") {
            return <span key={i} className="text-cream-900">{seg.text} </span>;
          }
          if (seg.type === "delete") {
            return (
              <span key={i} className="line-through text-cream-500 decoration-coral-400/60 decoration-[3px]">
                {seg.text}{" "}
              </span>
            );
          }
          if (seg.type === "insert") {
            return (
              <span key={i} className="text-grass-700 font-semibold bg-grass-100 rounded-md px-1.5 mx-1 py-px inline-decoration-clone">
                {seg.text}
              </span>
            );
          }
          return null;
        })}
      </p>
    </div>
  );
}

/* ── MIDDLE ──────────────────────────────────────────────────── */

function TalkButton({
  recording,
  speaking,
  thinking = false,
  disabled,
  onStart,
  onStop,
}: {
  recording: boolean;
  speaking: boolean;
  thinking?: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const handleToggle = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (recording) onStop();
    else onStart();
  };
  const idleClasses =
    "bg-white text-cream-800 border-2 border-cream-300 shadow-[0_2px_4px_rgba(0,0,0,0.04),0_12px_36px_-12px_rgba(0,0,0,0.18)] hover:bg-cream-50 hover:border-pingo-300 hover:text-pingo-700 active:scale-[0.96]";
  const recordingClasses =
    "bg-coral-500 text-white border-2 border-coral-600 shadow-[0_24px_64px_-16px_rgba(254,110,113,0.6),0_4px_12px_rgba(254,110,113,0.3)] scale-[1.06]";
  const speakingClasses =
    "bg-white text-pingo-600 border-2 border-pingo-400 shadow-[0_4px_12px_rgba(40,77,255,0.14),0_20px_54px_-16px_rgba(40,77,255,0.4)]";
  const thinkingClasses =
    "bg-white text-pingo-500 border-2 border-pingo-200 shadow-[0_4px_12px_rgba(40,77,255,0.08),0_16px_40px_-16px_rgba(40,77,255,0.3)] cursor-wait";
  const disabledClasses =
    "bg-cream-100 text-cream-400 border-2 border-cream-200 cursor-not-allowed";

  // Disable the button while Pingo is thinking so users don't cut off their own
  // pending turn. Visually it stays on-screen with the thinking animation.
  const effectivelyDisabled = disabled || thinking;

  return (
    <button
      type="button"
      disabled={effectivelyDisabled}
      onClick={handleToggle}
      aria-label={
        recording
          ? "tap to stop"
          : thinking
            ? "pingo is thinking"
            : "tap to speak"
      }
      className={[
        "group relative select-none",
        "h-[128px] w-[128px] md:h-[144px] md:w-[144px] rounded-full",
        "font-sans font-bold text-[13px] md:text-[14px] tracking-[0.2em] uppercase",
        "transition-[transform,box-shadow,background-color,border-color,color] duration-200 ease-out-quart",
        "outline-none focus-visible:ring-4 focus-visible:ring-pingo-500 focus-visible:ring-offset-4",
        disabled
          ? disabledClasses
          : recording
            ? recordingClasses
            : thinking
              ? thinkingClasses
              : speaking
                ? speakingClasses
                : idleClasses,
      ].join(" ")}
    >
      <span className="absolute inset-0 flex items-center justify-center">
        {recording ? (
          <span className="flex items-center gap-2">
            <span className="inline-block w-[7px] h-[7px] rounded-full bg-cream-50" />
            <span>rec</span>
          </span>
        ) : thinking ? (
          <ThinkingDots />
        ) : speaking ? (
          <SoundWave />
        ) : (
          <span>tap</span>
        )}
      </span>
    </button>
  );
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-[6px]">
      <span className="w-[7px] h-[7px] md:w-[8px] md:h-[8px] rounded-full bg-pingo-500 animate-think-dot" />
      <span
        className="w-[7px] h-[7px] md:w-[8px] md:h-[8px] rounded-full bg-pingo-500 animate-think-dot"
        style={{ animationDelay: "160ms" }}
      />
      <span
        className="w-[7px] h-[7px] md:w-[8px] md:h-[8px] rounded-full bg-pingo-500 animate-think-dot"
        style={{ animationDelay: "320ms" }}
      />
    </span>
  );
}

function SoundWave() {
  return (
    <span className="flex items-center gap-[3px] h-4">
      <span className="w-[3px] h-full bg-pingo-500 rounded-full origin-center animate-wave" />
      <span
        className="w-[3px] h-full bg-pingo-500 rounded-full origin-center animate-wave"
        style={{ animationDelay: "150ms" }}
      />
      <span
        className="w-[3px] h-full bg-pingo-500 rounded-full origin-center animate-wave"
        style={{ animationDelay: "300ms" }}
      />
    </span>
  );
}

/* ── BOTTOM (persistent pass panel) ──────────────────────────── */

function PassPanel({ pass }: { pass: Pass }) {
  return (
    <div key={`pass-${pass.round}`} className="animate-fade-in space-y-10 md:space-y-14">
      <ol className="stagger space-y-10 md:space-y-14">
        {pass.plan.map((p, i) => {
          const keep = pass.keeps.find((k) => k.label === p.ref);
          const quote = keep
            ? pass.utterance.slice(keep.start, keep.end).trim()
            : "";
          return (
            <li key={i} className="space-y-4 md:space-y-5">
              {quote && (
                <p className="font-sans text-[18px] md:text-[22px] leading-[1.6] text-cream-600 italic">
                  <span className="highlight-sweep text-cream-900 not-italic">
                    {quote}
                  </span>
                </p>
              )}
              <p className="font-sans text-[22px] md:text-[30px] leading-[1.65] font-medium text-cream-900 tracking-[-0.005em]">
                {renderWithPlaceholders(p.note)}
              </p>
            </li>
          );
        })}
      </ol>
      {pass.utterance.length > 0 && pass.keeps.length > 0 && (
        <div className="pt-8 md:pt-10 border-t border-cream-200">
          <Transcript utterance={pass.utterance} keeps={pass.keeps} />
        </div>
      )}
    </div>
  );
}


/* ── shared ──────────────────────────────────────────────────── */

function Caret() {
  return (
    <span className="inline-block w-[2px] md:w-[3px] h-[1em] bg-pingo-500 ml-[5px] align-[-0.15em] animate-caret-blink" />
  );
}

/* ── TTS (streaming via MediaSource) ─────────────────────────── */

type TtsStreamState = {
  audio: HTMLAudioElement;
  ms: MediaSource;
  sb: SourceBuffer | null;
  queue: Uint8Array[];
  ended: boolean;
  objectUrl: string;
  setSpeaking: (v: boolean) => void;
  onEnd?: () => void;
};

function pumpQueue(state: TtsStreamState) {
  if (!state.sb || state.sb.updating) return;
  if (state.queue.length > 0) {
    const chunk = state.queue.shift()!;
    try {
      state.sb.appendBuffer(chunk as unknown as ArrayBuffer);
    } catch (e) {
      console.error("[tts] appendBuffer failed", e);
    }
    return;
  }
  if (state.ended && state.ms.readyState === "open") {
    try {
      state.ms.endOfStream();
    } catch {}
  }
}

function startTtsStream(
  mime: string,
  ref: { current: HTMLAudioElement | null },
  stateRef: { current: TtsStreamState | null },
  setSpeaking: (v: boolean) => void,
  onEnd?: () => void,
) {
  // Stop any in-flight stream first.
  endTtsStream(stateRef, /* force */ true);
  if (ref.current) {
    try { ref.current.pause(); } catch {}
  }

  const audio = new Audio();
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  audio.src = objectUrl;
  ref.current = audio;

  const state: TtsStreamState = {
    audio,
    ms,
    sb: null,
    queue: [],
    ended: false,
    objectUrl,
    setSpeaking,
    onEnd,
  };
  stateRef.current = state;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    setSpeaking(false);
    try { URL.revokeObjectURL(objectUrl); } catch {}
    onEnd?.();
    if (stateRef.current === state) stateRef.current = null;
  };
  audio.onplay = () => setSpeaking(true);
  audio.onended = finish;
  audio.onerror = finish;

  ms.addEventListener(
    "sourceopen",
    () => {
      try {
        const sb = ms.addSourceBuffer(mime);
        sb.mode = "sequence";
        state.sb = sb;
        sb.addEventListener("updateend", () => pumpQueue(state));
        pumpQueue(state);
        // TTS follows a user tap, so autoplay should be permitted.
        audio.play().catch((e) => {
          console.error("[tts] play rejected", e);
          finish();
        });
      } catch (e) {
        console.error("[tts] sourceopen failed", e);
        finish();
      }
    },
    { once: true },
  );
}

function appendTtsChunk(
  b64: string,
  stateRef: { current: TtsStreamState | null },
) {
  const state = stateRef.current;
  if (!state) return;
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  state.queue.push(buf);
  pumpQueue(state);
}

function endTtsStream(
  stateRef: { current: TtsStreamState | null },
  force = false,
) {
  const state = stateRef.current;
  if (!state) return;
  state.ended = true;
  if (force) {
    try { state.audio.pause(); } catch {}
    try { URL.revokeObjectURL(state.objectUrl); } catch {}
    try {
      if (state.ms.readyState === "open") state.ms.endOfStream();
    } catch {}
    stateRef.current = null;
    return;
  }
  pumpQueue(state);
}
