export type Phase = "idle" | "orient" | "iterate";

/**
 * UI-facing stage. The client renders one thing per stage. Transitions are
 * driven by explicit `stage` messages from the server.
 *
 *   idle     — before any interaction (HoldHint)
 *   brief    — Pingo asked "tell me what they do", user is about to describe target
 *   orient   — 4 fill-in-the-blank stems shown, user is about to practice out loud
 *   cloze    — polished paragraph with blanks shown, user re-delivers
 *   revision — cleaned-up diff shown, user reads the clean version back
 *   done     — final delivery complete, celebration
 */
export type Stage =
  | "idle"
  | "brief"
  | "orient"
  | "cloze"
  | "revision"
  | "done";

export type Keep = {
  start: number;
  end: number;
  label: string;
  gist: string;
};

export type PlanItem = {
  ref: string;
  note: string;
};

export type Pass = {
  round: number;
  utterance: string;
  keeps: Keep[];
  plan: PlanItem[];
  done: boolean;
};

export type DiffSegment = {
  type: "keep" | "delete" | "insert";
  text: string;
};

export type ClientMsg =
  | { type: "hello" }
  | { type: "start_turn" }
  | { type: "end_turn" };

export type ServerMsg =
  | { type: "ready" }
  | { type: "phase"; phase: Phase }
  | { type: "stage"; stage: Stage }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "ask"; question: string }
  | { type: "hints"; items: string[] }
  | { type: "pass"; pass: Pass }
  | { type: "revision"; segments: DiffSegment[]; original: string }
  | { type: "tts_start"; mime: string }
  | { type: "tts_chunk"; chunk: string }
  | { type: "tts_end" }
  | { type: "error"; message: string };
