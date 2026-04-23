export type Phase = "idle" | "orient" | "iterate";

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
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "ask"; question: string }
  | { type: "hints"; items: string[] }
  | { type: "pass"; pass: Pass }
  | { type: "revision"; segments: DiffSegment[] }
  | { type: "tts_start"; mime: string }
  | { type: "tts_chunk"; chunk: string }
  | { type: "tts_end" }
  | { type: "error"; message: string };
