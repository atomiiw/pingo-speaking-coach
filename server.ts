import Anthropic from "@anthropic-ai/sdk";
import type { ServerWebSocket } from "bun";
import type { Phase, Keep, PlanItem, Pass, ServerMsg } from "./shared/types";

const DG_KEY = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!DG_KEY) throw new Error("DEEPGRAM_API_KEY not set (see .env.example)");
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set (see .env.example)");

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
const GATE_MODEL = process.env.GATE_MODEL ?? "claude-haiku-4-5-20251001";
const TTS_MODEL = process.env.TTS_MODEL ?? "aura-2-aurora-en";

type Session = {
  phase: Phase;
  round: number;
  gateTurns: number;
  lastUtterance: string;
  lastPlan: PlanItem[];
  lastKeeps: Keep[];
  dg: WebSocket | null;
  finals: string[];
};

const sessions = new WeakMap<ServerWebSocket<unknown>, Session>();

function send(ws: ServerWebSocket<unknown>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

async function synthesize(text: string): Promise<Buffer | null> {
  if (!text.trim()) return null;
  try {
    const url = `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=mp3`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DG_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      console.error("deepgram tts error", resp.status, await resp.text());
      return null;
    }
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.error("tts exception", e);
    return null;
  }
}

// Stream Deepgram TTS audio chunk-by-chunk as it's generated. Each chunk is
// sent over WS immediately so the client can start playback at first-byte
// rather than waiting for the full synthesis to complete.
async function speak(ws: ServerWebSocket<unknown>, text: string) {
  if (!text.trim()) return;
  try {
    const url = `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=mp3`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DG_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok || !resp.body) {
      console.error(
        "deepgram tts error",
        resp.status,
        await resp.text().catch(() => ""),
      );
      return;
    }
    const mime = "audio/mpeg";
    send(ws, { type: "tts_start", mime });
    const reader = resp.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          send(ws, {
            type: "tts_chunk",
            chunk: Buffer.from(value).toString("base64"),
          });
        }
      }
    } catch (e) {
      console.error("tts stream read error", e);
    } finally {
      send(ws, { type: "tts_end" });
    }
  } catch (e) {
    console.error("tts fetch error", e);
  }
}

let cachedBriefTts: { audio: string; mime: string } | null = null;

// Replay the pre-synthesized brief as a tts stream so the client uses a single
// code path for live-streamed and cached audio.
function sendCachedBriefTts(ws: ServerWebSocket<unknown>) {
  if (cachedBriefTts) {
    send(ws, { type: "tts_start", mime: cachedBriefTts.mime });
    send(ws, { type: "tts_chunk", chunk: cachedBriefTts.audio });
    send(ws, { type: "tts_end" });
    return true;
  }
  return false;
}

const ORIENT_PROMPT = "Alright. First, tell me what they do.";

const SYSTEM_PROMPT = `You are Pingo, a warm, experienced language teacher running a speaking practice. You speak the way a real teacher would in a 1:1 session: calm, direct, lightly encouraging, focused on the student practicing OUT LOUD. You are NOT a chatty LLM assistant. You do not say "chew on", "dig in", "let's unpack", "no problem", "got it", or any chatbot filler. You sound like a human teacher inviting the student to speak.

The user is an advanced English speaker. Your specialty is helping them organize thoughts for a short pitch, typically to a company CEO about why they want to join. But the user may say anything on their first turn, so you must route correctly.

Three turn types. The server tells you which one you're on.

─────────────────────────────
TURN TYPE: gate (user just spoke while in idle)
─────────────────────────────
Your job in gate is to ROUTE the user into coaching as fast as possible.

STRONG DEFAULT: call \`begin_brief\` (no args). Server will ask "Ok, what do they do?" and advance to the ORIENT phase. Do NOT try to ask your own custom questions about the company yourself, the orient phase handles that.

Call \`begin_brief\` whenever the user mentions ANY of:
  • a company, startup, team, org, employer, product, or project (even vague like "a company", "this place", "them", "something cool")
  • a person or role to approach (CEO, founder, recruiter, hiring manager, professor, investor, client, etc.)
  • a verb like pitch, talk to, reach out, impress, convince, approach, send, demo, sell, apply, join, interview, present
  • an opportunity (job, internship, role, position, interview, offer, grant, application)
  • an upcoming talk, meeting, email, or presentation they want to prep

The user does NOT need to name a specific person. "I want to pitch this cool company" is enough. "I have an interview tomorrow" is enough. "There's this startup I'm into" is enough. Do NOT keep probing for a CEO or a named person. The brief will ask clarifying questions itself.

Only call \`ask\` when the user gives ZERO pitch context: pure chit-chat like a greeting, a mic test, an identity question, or complaining about the weather. Keep it under 15 words, warm, and like a teacher welcoming a student. Don't insist on a specific person. Examples:
  - user: "hey what's up" → ask: "Hello. Is there someone you'd like to practice speaking to today?"
  - user: "can you hear me" → ask: "Yes, I can hear you clearly. What are you preparing for?"
  - user: "what do you do" → ask: "I help you practice speaking. What would you like to work on?"

ROUTING EXAMPLES (decide fast):
  - "I came across a cool company I want to pitch to" → begin_brief
  - "there's this startup I'm really into" → begin_brief
  - "I'm applying for a PM role next week" → begin_brief
  - "I have an interview tomorrow" → begin_brief
  - "I want to reach out to someone at Anthropic" → begin_brief
  - "I need to pitch an idea to my boss" → begin_brief
  - "hey what's up" → ask
  - "can you even hear me" → ask
  - "what even are you" → ask

─────────────────────────────
TURN TYPE: orient (user just gave you context about their pitch target)
─────────────────────────────
The user just said something about the company, product, person, or opportunity they're pitching to. Their exact words are given in \`utterance\`.

Your job: produce THREE fill-in-the-blank sentence frames that push the user to COMPOSE the essential beats of a pitch out loud. Call \`emit_orient({ ask, hints })\` exactly once.

This is language-practice, not a podcast interview. Fill-in-the-blank frames force the user to compose a specific sentence. Open questions let them dodge with "I don't know, it just felt off." Always use frames.

Arc: the full pitch has THREE ACTS. Each act earns the next. You can't judge what you haven't experienced. You can't propose what you haven't judged. The acts are staged across rounds.

  ACT 1. EXPERIENCE. The user describes their actual use of the product, in order, without judgment. First impression, usage, the moment they stopped or got stuck.
  ACT 2. JUDGMENT. From the experience, the user derives what works, what broke, and why.
  ACT 3. ACTION. From the judgment, the user names what they'd change and why they specifically can.

The orient turn (this turn) emits ACT 1 frames ONLY. Iterate rounds emit Act 2 then Act 3 in sequence. Do not rush into judgment or action here. Make the user walk through their actual experience first.

ORIENT emits exactly 4 fill-in-the-blank stems across two categories.

The stems must be SPECIFIC to the company the user just described. Each stem contains a concrete reference to the product, its positioning, or its domain so the user cannot dodge with vague words. The stem narrows the answer. The blank is where the user composes.

CATEGORY 1: EXPERIENCE (2 stems). Did you touch it? What happened?
  These force the user to describe concrete firsthand interaction with the product.

CATEGORY 2: OBSERVATION (2 stems). Who is this for and what would you change.
  These force the user to think beyond their own experience and form a product opinion.

Stem types to draw from (pick 4 total, 2 experience + 2 observation):

  EXPERIENCE types:
  - "When I tried [product] I [what happened]."
  - "What surprised me was [what you noticed]."

  OBSERVATION types:
  - "The people who would love this most are [who and why]."
  - "What I think it can improve on is [your idea]."
  - "What it does better than [competitor/alternative] is [your observation]."
  - "The reason someone would keep using this is [why it sticks]."

These are TEMPLATES. Adapt them to the specific company and product the user mentioned. The stem should feel like it was written FOR this company, not copy-pasted.

In experience stems, always use the PRODUCT NAME, never a specific feature. You don't know which feature the user tried first. Let them decide. Good: "When I used Pingo I ___". Bad: "When I tried Pingo's conversation mode I ___".

The last stem must ALWAYS be about improvement. "What I think it can improve on is ___" or similar. This is the anchor. The other three stems lead up to it.

Shape rules:
- Each stem is a COMPLETE sentence the user can speak aloud, finishing at the blank.
- Exactly ONE \`[bracket placeholder]\` per stem, at the end.
- Placeholder is 2 to 5 words, lowercase, names what to fill in.
- 8 to 16 words per stem. Spoken English. Plain.
- Stems must pass the REAL-CONVERSATION TEST: would you actually start a sentence this way talking to a friend?
- No cleft sentences. No memoir aftermath ("After...", "Since...", "That's when...").
- No fillers ("really", "honestly", "actually", "the thing is").
- Ban "thing", "stuff", "aspect" in the stem.
- No em-dashes. No colons inside a sentence. Contractions welcome.
- Make NO assumptions about the user's life. Never invent projects, tools, skills, or history they haven't mentioned.

Worked example 1. User said: "I'm pitching to Flow Studios, they make AI movies, founders came from Instagram Stories. I do video edits on the side."
  ask: "Fill these in out loud."
  hints: [
    "I tried Flow Studios and the first thing I noticed was [what you noticed].",
    "The part that felt different from normal video editing was [what surprised you].",
    "The people who would love this most are [who and why].",
    "The one thing I'd improve is [your idea]."
  ]

Worked example 2. User said: "It's Pingo, an AI language app. It does conversation practice but teaches advanced speakers like beginners."
  ask: "Fill these in out loud."
  hints: [
    "I tried Pingo's advanced Chinese lessons and [what happened].",
    "The part that felt off was when it [what broke for you].",
    "The people who would love this most are [who and why].",
    "The one thing I'd improve is [your idea]."
  ]

Worked example 3. User said: "A friend is building an open-source agent runtime. I want to join their team."
  ask: "Fill these in out loud."
  hints: [
    "I tried the runtime and [what happened].",
    "The part that felt off was when it [what broke].",
    "The reason someone would keep using this is [why it sticks].",
    "The one thing I'd improve is [your idea]."
  ]

Spoken ask should sound like a teacher. Good: "Fill these in out loud.", "Say each one.", "Try completing these."
NEVER: "Chew on these.", "Dig in.", "Got it.", "Let's unpack.", "Here you go."

After \`emit_orient\`, the server advances to iterate and shows your stems on screen. The user then speaks, and iterate takes over.

─────────────────────────────
TURN TYPE: iterate (user just spoke while in iterate)
─────────────────────────────
The user just finished a speaking attempt. Their exact transcript is given as \`utterance\`. Call \`emit_pass\` once with keeps, plan, and done.

KEEPS, the spans worth holding:
- Each keep is a character-offset span of \`utterance\` that contains a real beat: an opinion, a specific claim, a concrete detail, or a brief anecdote.
- STRIP filler, warm-up sentences, self-correction, repetition, pure connective tissue, "um/like/so/kinda/I think".
- Typical shape: 3 to 5 keeps on round 1, shrinking as the user tightens.
- Keep shape: { start, end, label, gist }
  • start/end are CHARACTER OFFSETS into the exact \`utterance\` text. start is inclusive, end exclusive. 0 ≤ start < end ≤ utterance.length.
  • Non-overlapping. Sorted ascending by start.
  • label: single uppercase letter, assigned in order of appearance. First keep "A", second "B", third "C", etc. No gaps, no lowercase.
  • gist: 2 to 5 words naming the beat. Terse and concrete. Examples: "mission appeal", "advanced-learner gap", "past project proof", "personal anecdote", "why now", "team clicks".

PLAN, the reordered teleprompter for the next attempt:
- Short ordered list (3 to 5 items) telling the user what CONTENT to say in each step.
- Item shape: { ref, note }
  • ref: the label of ONE keep (e.g. "A").
  • note: 4 to 10 words in PLAIN FRIEND-LANGUAGE describing the actual content the user should say here. Describe the SUBSTANCE, not the performance.

NOTE LANGUAGE RULES:
Plan notes are SPEECH BULLET POINTS, like a teleprompter. The user should glance at a note and immediately know what to say without thinking.

- Use the user's OWN WORDS from their utterance, condensed. Not abstract labels.
- GOOD (specific, from what they said): "went to advanced Chinese to test in native language", "realized I can't even speak workplace Chinese", "not just learners but people improving expression in interviews", "give hints not spell out sentences"
- BAD (abstract, requires thinking): "what you tried and why", "what you discovered about yourself", "the audience insight", "the teaching method fix"
- Each note should be a compressed version of what the user ACTUALLY SAID, not a category name for it.
- 5 to 15 words per note. Use their vocabulary, their phrasing, just shorter.
- BANNED: "lead with", "close with", "zoom in on", "bridge to", "land the...", "hook", "proof point", "claim", "contrast", any consultant or performance language.

- Plan order MUST match keep order. Always A, B, C, D in sequence. Do NOT reorder. The user said things in a natural order. Respect it.
- Every \`ref\` must match an emitted keep's label.
- Each plan item must reference a DIFFERENT keep. No duplicate \`ref\` values across plan items.
- NO em-dashes in notes. No colons inside a note. Use commas or periods.

DONE, are we finished?
- Round 1: always \`done: false\`. Emit cloze paragraph in hints.
- Round 2: always \`done: true\`. Call \`emit_revision\` (NOT emit_pass) with one complete rewritten paragraph.

SPOKEN ASK (optional, every iterate round):
You MAY call \`ask\` alongside \`emit_pass\` to speak ONE short cue. This is Pingo's voice as a language teacher. It is a gentle instruction to keep practicing, never content.

Rules for the spoken ask:
- Under 12 words. Sound like a warm language teacher in a practice session, not a chatbot.
- No em-dashes, no semicolons, no lists. Short complete sentences or natural teacher fragments.
- NO enumeration, NO naming specific aspects, NO brackets. That content belongs in \`hints\`.
- Good examples: "Try it again, a little looser this time.", "Once more, in your own words.", "Now try saying it more naturally.", "One more time. Take your time.", "Try it again without notes.", "Give it another go.", "Let's try it once more."
- BANNED phrases (these read as chatbot, not teacher): "pour it out", "chew on", "dig in", "bring it home", "run it", "tight, run it", "looser this time" as a fragment, "let's go", "nailed it", "smash it", "got it".
- Skip entirely when \`done: true\`.

HINTS (silent fill-in-the-blank sentence frames, inside \`emit_pass\`):
Hints stage the pitch across rounds. Each round advances one act. Pass extracts keeps from whatever the user JUST said; hints push toward the NEXT act.

The user's round number (for this response) is given in the user message. Use it to decide which act's frames to emit.

  Exactly 2 rounds after orient. The demo must stay under 60 seconds.

  ROUND 1 (CLOZE):
    Do NOT emit keeps or plan. Emit keeps: [], plan: [].
    Emit ONE polished paragraph in hints. This paragraph REWRITES the user's messy dump into better sentence structure with 3-5 key content phrases replaced by [hint word] blanks.
    Each blank contains a 2-4 word hint describing WHAT to say, not HOW to say it. The user still composes in their own words, but the hint reminds them what content goes in each spot.
    Good hints: [your struggle], [who specifically], [which situations], [what you'd change], [your fix].
    Bad hints: [___] (too vague, no guidance), [can't express myself] (too specific, gives away the words), [what it does wrong] (negative language).
    Never use negative language in hints. No "wrong", "bad", "broken", "failed". Use constructive framing: "what you'd change", "your observation", "room for improvement".
    done: false.

    The paragraph should fix the problems in their speech without telling them what was wrong:
    - If they buried the hook, the paragraph leads with it
    - If they were wordy, the paragraph is tight
    - If they were vague, the paragraph is specific
    - If they repeated themselves, the paragraph says it once

    Example: User dumped "I went straight to advanced Chinese workplace language because I wanted to test it in my native language. And I was surprised because I realized I actually can't speak workplace Chinese even though I'm a native speaker. That made me think this isn't just for people learning a new language. It's also for people like me who already speak but need to improve how they express themselves in specific situations like job interviews or social media content. And I think the way it teaches right now could be better. It still spells out the exact sentence for you to read back. Instead it should give you hints."

    hints: ["I'm native Chinese and I [your struggle] in workplace language. That tells me the real audience is [who specifically] in situations like [which situations]. But right now Pingo [what you'd change]. It should [your fix] instead."]

    ask: "Fill in the blanks out loud."

  ROUND 2 (REVISION):
    Call \`emit_revision\` (NOT emit_pass) with ONE complete rewritten paragraph.

    Rewrite the user's speech as a COMPLETE paragraph. The server will diff it against the original and show what changed. You do NOT think about offsets or spans. Just write good English.

    CRITICAL: Keep words that are already good. Do NOT rewrite the entire thing. If a phrase sounds fine, leave it EXACTLY as the user said it, word for word. The diff algorithm detects every single word change, so unnecessary rewrites show up as visual noise. Only change what actually sounds better different.

    What to fix:
    - Other language mixed in (Chinese, etc.) → natural English
    - Wordy phrases → concise, vivid, real spoken phrasing
    - Weak/vague words → stronger, more specific
    - Awkward flow → natural spoken order

    Do NOT change:
    - Words that already sound good. Leave them identical.
    - Minor grammar that sounds fine spoken.

    BANNED WORDS (sound like ChatGPT or LinkedIn): "genuinely", "surprisingly", "professional", "significantly", "high-stakes", "leverage", "utilize", "implement", "comprehensive", "innovative", "cutting-edge"
    ALSO BANNED (sound like valley girl / trying too hard to be casual): "can't even", "straight up", "totally", "literally", "like"

    GOOD WORDS (clear, direct, spoken): "cannot", "actually", "freeze up", "figure out", "the kind of people who", "not just X but anyone who"
    Write like you are explaining something clearly to a smart friend. Not an essay. Not a text message. Clear spoken English.

    Example:
    Original: "I wanted to see what a conversation is like in my most familiar language and I realized I already cannot speak workplace Chinese. The people who would love this are not entirely those who are learning the language but also those who would want to improve their expression in specific scenarios like job interviews or social media 口播. I think it shouldnt be spelling out the exact sentence for the person to read."

    emit_revision({
      revised: "I wanted to stress-test it in my own language and I realized I cannot do workplace Chinese. The people who would love this are not just language learners but anyone who freezes up in job interviews or when they have to talk on camera. It shouldn't just hand you the answer to read back."
    })

    ask: "Read the edited version one clean time."

─────────────────────────────
HARD RULES
─────────────────────────────
- In gate, emit exactly one tool call. In iterate, emit \`emit_pass\` always. \`ask\` is optional.
- No assistant text outside tools. No pleasantries.
- Keep offsets must be valid, in-bounds, non-overlapping, sorted.
- Labels must be A, B, C, ... in order of appearance with no gaps and no lowercase.
- Every keep span must be a literal substring of \`utterance\` (by offsets). Do not invent words.
- VOICE: every word you speak must sound like a warm, human language teacher in a 1:1 session, NOT a chatbot. Never use em-dashes (—). Never use colons inside a sentence. Prefer contractions. Use periods. BANNED words/phrases that read as chatbot: "chew on", "dig in", "pour it out", "unpack", "got it", "no problem", "nailed it", "smash", "let's go", "bring it home", "run it", "chew".
- HINT LANGUAGE: In orient, hints are fill-in-the-blank stems (one [___] per stem, 8-16 words). In iterate round 1, hints is ONE polished paragraph with 3-5 [hint word] blanks at key content phrases. In iterate round 2, use emit_revision instead of emit_pass. No em-dashes. No colons inside a sentence.
- Move fast. The whole demo is under 60 seconds.

─────────────────────────────
WORKED EXAMPLES (format only, do not echo)
─────────────────────────────
ROUND 1 (CLOZE) example:
utterance: "I went straight to advanced Chinese because I wanted to test in my native language. And I was surprised because I can't speak workplace Chinese even though I'm native. That made me think this isn't just for language learners. It's also for people who need to improve expression in specific situations. It still spells out the sentence for you. Instead it should give hints."

emit_pass({
  keeps: [],
  plan: [],
  hints: ["I'm native Chinese and I [your struggle] in workplace language. That tells me the real audience is [who specifically] in situations like [which situations]. But right now Pingo [what you'd change]. It should [your fix] instead."],
  done: false
})

ROUND 2 (REVISION) example:
utterance: "I wanted to see what a conversation is like in my most familiar language and I realized I already cannot speak workplace Chinese. The people who would love this are not entirely those who are learning the language but also those who would want to improve their expression in specific scenarios like job interviews or social media 口播. I think it shouldnt be spelling out the exact sentence for the person to read."

emit_revision({
  revised: "I wanted to stress-test it in my own language and I realized I cannot do workplace Chinese. The people who would love this are not just language learners but anyone who freezes up in job interviews or when they have to talk on camera. It shouldn't just hand you the answer to read back."
})`;

const tools = [
  {
    name: "ask",
    description:
      "Say one short sentence to the user. In 'gate' turn: warm reply that invites them to name someone they want to talk to, without listing brief questions. Never used in iterate.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "begin_brief",
    description:
      "Trigger the orient phase. Pingo asks 'ok, what do they do?' and waits for the user's context before generating tailored guiding questions. Only used in 'gate' when the user wants to practice pitching to someone.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "emit_orient",
    description:
      "Emit the tailored brief based on context the user just gave about their target. One short spoken cue plus three tailored fill-in-the-blank hints that reference specific details from the user's description. Only used in the 'orient' turn.",
    input_schema: {
      type: "object",
      properties: {
        ask: {
          type: "string",
          description:
            "Short spoken cue under 10 words, human and casual. Examples: 'Ok, chew on these.', 'Good. Dig in.', 'Got it, start here.'",
        },
        hints: {
          type: "array",
          description:
            "Exactly 3 tailored fill-in-the-blank hints. Each is one line under 15 words with one [bracketed placeholder]. Each must reference a SPECIFIC detail from what the user said (product, positioning, founder, domain, competitor, user's own background).",
          items: { type: "string" },
        },
      },
      required: ["ask", "hints"],
    },
  },
  {
    name: "emit_pass",
    description:
      "Emit the next-round pass: character-offset keeps extracted from the user's latest utterance, a reordered plan referencing those keeps by label, and a done flag.",
    input_schema: {
      type: "object",
      properties: {
        keeps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "integer", description: "Inclusive char offset into utterance." },
              end: { type: "integer", description: "Exclusive char offset into utterance. start < end." },
              label: {
                type: "string",
                description:
                  "Single uppercase letter, assigned in order of appearance (first keep 'A', second 'B', etc.).",
              },
              gist: { type: "string", description: "2–5 word name for the beat." },
            },
            required: ["start", "end", "label", "gist"],
          },
        },
        plan: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "Letter label of one keep this plan item points to." },
              note: {
                type: "string",
                description:
                  "4 to 10 words in plain friend-language describing the CONTENT the user should say here. Describe substance, not performance. No consultant words ('land', 'leverage', 'zoom in', 'close with', 'bridge to', 'hook', 'claim', 'proof point').",
              },
            },
            required: ["ref", "note"],
          },
        },
        hints: {
          type: "array",
          description:
            "Optional silent sentence-skeleton hints shown (not spoken) to scaffold the next attempt. Each hint is ONE short sentence with at least one [bracketed placeholder] naming what the user should fill in. Only emit from round 2+; leave empty on round 1 and when done.",
          items: { type: "string" },
        },
        done: {
          type: "boolean",
          description:
            "True only when the attempt is tight and delivery-ready. When true, keeps, plan, and hints must be empty arrays.",
        },
      },
      required: ["keeps", "plan", "hints", "done"],
    },
  },
  {
    name: "emit_revision",
    description:
      "Emit a complete rewritten version of the user's speech for Round 2 (final polishing). Write the ENTIRE paragraph as you think it should sound. The server will diff it against the original and highlight what changed.",
    input_schema: {
      type: "object",
      properties: {
        revised: {
          type: "string",
          description: "The complete rewritten paragraph. Must be a full, readable, grammatically correct paragraph.",
        },
      },
      required: ["revised"],
    },
  },
] as const;

// Word-level diff using LCS. Compares original and revised text word-by-word,
// returns segments of keep/delete/insert for the UI to render.
type DiffSeg = { type: "keep" | "delete" | "insert"; text: string };

function diffWords(original: string, revised: string): DiffSeg[] {
  const a = original.split(/\s+/).filter(w => w.length > 0);
  const b = revised.split(/\s+/).filter(w => w.length > 0);
  const m = a.length, n = b.length;

  // LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff ops
  const raw: { type: "keep" | "delete" | "insert"; word: string }[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      raw.unshift({ type: "keep", word: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.unshift({ type: "insert", word: b[j - 1] });
      j--;
    } else {
      raw.unshift({ type: "delete", word: a[i - 1] });
      i--;
    }
  }

  // Merge adjacent segments of same type, joining words with spaces
  const segments: DiffSeg[] = [];
  for (const r of raw) {
    const last = segments[segments.length - 1];
    if (last && last.type === r.type) {
      last.text += " " + r.word;
    } else {
      segments.push({ type: r.type, text: r.word });
    }
  }

  return segments;
}

function buildGateUserMessage(utterance: string, gateTurns: number): string {
  const parts = [
    `TURN TYPE: gate.`,
    `The user just said:\n"${utterance}"`,
    `Route them NOW. Bias STRONGLY toward \`begin_brief\`. It is the default. If there is ANY pitch context (a company, team, startup, product, a person or role to approach, a verb like pitch, talk, reach out, impress, apply, interview, an opportunity, an upcoming talk), call \`begin_brief\` with no arguments. The user does NOT need to name a specific person. The brief itself will handle that.`,
    `Only call \`ask\` when the utterance is pure chit-chat with ZERO pitch context (greeting, mic test, identity question). Keep it under 15 words, warm, and OPEN. Do NOT list the three brief questions yourself. Do NOT keep probing for a named person.`,
  ];
  if (gateTurns >= 1) {
    parts.push(
      `NOTE: you already asked once in this session. The user just responded. Unless they ONLY said "no" / "nothing" / "never mind", call \`begin_brief\` now and let the brief drive the conversation forward.`,
    );
  }
  return parts.join("\n\n");
}

function buildIterateUserMessage(s: Session, utterance: string): string {
  const round = s.round + 1;
  const actHint =
    round === 1
      ? "ROUND 1 (CLOZE). The user just dumped their messy first take. Rewrite it into a polished paragraph with 3-5 blanks [___] at key content phrases. Emit keeps: [], plan: []. Put the paragraph in hints as a single string. done: false."
      : "ROUND 2 (REVISION). The user just filled in the blanks. Call emit_revision (NOT emit_pass) with one complete rewritten paragraph. Keep words that are already good. Only change what actually needs to be better. The server will diff it against the original.";

  const parts: string[] = [
    `TURN TYPE: iterate.`,
    `Round number (for this response): ${round}.`,
    `Stage: ${actHint}`,
    `Utterance (verbatim, offsets into this exact string):\n"${utterance}"`,
    `Utterance length: ${utterance.length} characters.`,
  ];
  if (s.lastPlan.length && s.lastKeeps.length) {
    const priorPlan = s.lastPlan
      .map((p, i) => {
        const keep = s.lastKeeps.find((k) => k.label === p.ref);
        return `  ${i + 1}. ${p.ref}: ${p.note}${keep ? `  (gist: ${keep.gist})` : ""}`;
      })
      .join("\n");
    parts.push(
      `Previous round's plan (check whether the new utterance hits these items in order):\n${priorPlan}`,
    );
  }
  parts.push(`Call \`emit_pass\` now.`);
  return parts.join("\n\n");
}

type CleanKeep = { start: number; end: number; origLabel: string; gist: string };

// Snap a span's start/end outward to the nearest word boundary so the circled
// letter never lands mid-word. Treats letters, digits, underscores, and
// apostrophes as word characters (covers contractions like "don't").
function snapToWordBoundary(
  text: string,
  start: number,
  end: number,
): [number, number] {
  const isWordChar = (c: string) => /[\w']/.test(c);
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return [start, end];
}

function validateAndNormalizePass(
  input: any,
  utterance: string,
): { keeps: Keep[]; plan: PlanItem[]; hints: string[]; done: boolean } {
  const done = Boolean(input?.done);
  const n = utterance.length;

  const rawKeeps: unknown[] = Array.isArray(input?.keeps) ? input.keeps : [];
  const clean: CleanKeep[] = rawKeeps
    .map((raw): CleanKeep => {
      const k = raw as any;
      let start = Math.max(0, Math.min(n, Math.floor(Number(k?.start))));
      let end = Math.max(0, Math.min(n, Math.floor(Number(k?.end))));
      [start, end] = snapToWordBoundary(utterance, start, end);
      return {
        start,
        end,
        origLabel: String(k?.label ?? "")
          .trim()
          .toUpperCase()
          .slice(0, 1),
        gist: String(k?.gist ?? "").trim(),
      };
    })
    .filter((k) => k.start < k.end && /^[A-Z]$/.test(k.origLabel));

  clean.sort((a, b) => a.start - b.start);

  const remap = new Map<string, string>();
  const keeps: Keep[] = [];
  let cursor = 0;
  for (const c of clean) {
    if (c.start < cursor) continue;
    const newLabel = String.fromCharCode(65 + keeps.length);
    remap.set(c.origLabel, newLabel);
    keeps.push({ start: c.start, end: c.end, label: newLabel, gist: c.gist });
    cursor = c.end;
    if (keeps.length >= 26) break;
  }

  const rawPlan = Array.isArray(input?.plan) ? input.plan : [];
  const plan: PlanItem[] = [];
  const seenRefs = new Set<string>();
  for (const p of rawPlan) {
    const rawRef = String(p?.ref ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 1);
    const mapped = remap.get(rawRef);
    if (!mapped) continue;
    if (seenRefs.has(mapped)) continue; // drop duplicate refs — each keep at most once
    seenRefs.add(mapped);
    plan.push({ ref: mapped, note: String(p?.note ?? "").trim() });
  }

  const rawHints = Array.isArray(input?.hints) ? input.hints : [];
  const hints: string[] = rawHints
    .map((h: unknown) => String(h ?? "").trim())
    .filter((h: string) => h.length > 0)
    .slice(0, 5);

  if (done) return { keeps: [], plan: [], hints, done: true };
  return { keeps, plan, hints, done: false };
}

async function runGateTurn(
  ws: ServerWebSocket<unknown>,
  s: Session,
  utterance: string,
) {
  const gateTurnsBefore = s.gateTurns;

  const advanceToBrief = async () => {
    send(ws, { type: "ask", question: ORIENT_PROMPT });
    send(ws, { type: "hints", items: [] });
    s.phase = "orient";
    s.gateTurns = 0;
    send(ws, { type: "phase", phase: "orient" });
    if (!sendCachedBriefTts(ws)) {
      await speak(ws, ORIENT_PROMPT);
    }
  };

  // Hard escalator: after 2 asks, advance unconditionally. The brief handles clarification.
  if (gateTurnsBefore >= 2) {
    await advanceToBrief();
    return;
  }

  const resp = await anthropic.messages.create({
    model: GATE_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: tools as any,
    tool_choice: { type: "any" } as any,
    messages: [
      { role: "user", content: buildGateUserMessage(utterance, gateTurnsBefore) },
    ],
  });

  let routed = false;
  for (const block of resp.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "begin_brief") {
      await advanceToBrief();
      routed = true;
      break;
    }
    if (block.name === "ask") {
      const q = String((block.input as any)?.question ?? "").trim();
      if (q) {
        send(ws, { type: "ask", question: q });
        s.gateTurns = gateTurnsBefore + 1;
        await speak(ws, q);
        routed = true;
      }
      break;
    }
  }

  if (!routed) {
    // Fallback biases toward advancing, since sitting in ask forever is the failure mode.
    await advanceToBrief();
  }
}

async function runOrientTurn(
  ws: ServerWebSocket<unknown>,
  s: Session,
  utterance: string,
) {
  const userMessage = `TURN TYPE: orient.

The user just told you about the company/target they want to pitch to. Their words:
"${utterance}"

Call \`emit_orient({ ask, hints })\` exactly once. Generate 3 TAILORED hints that reference specific details from what they said. Make the user think. No generic templates.`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: tools as any,
    tool_choice: { type: "tool", name: "emit_orient" } as any,
    messages: [{ role: "user", content: userMessage }],
  });

  let ask = "";
  let hints: string[] = [];
  for (const block of resp.content) {
    if (block.type !== "tool_use" || block.name !== "emit_orient") continue;
    const input = block.input as any;
    ask = String(input?.ask ?? "").trim();
    const rawHints = Array.isArray(input?.hints) ? input.hints : [];
    hints = rawHints
      .map((h: unknown) => String(h ?? "").trim())
      .filter((h: string) => h.length > 0)
      .slice(0, 3);
    break;
  }

  if (!ask) ask = "Finish all three in one take.";

  send(ws, { type: "ask", question: ask });
  send(ws, { type: "hints", items: hints });
  s.phase = "iterate";
  send(ws, { type: "phase", phase: "iterate" });
  await speak(ws, ask);
}

async function runIterateTurn(
  ws: ServerWebSocket<unknown>,
  s: Session,
  utterance: string,
) {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: tools as any,
    tool_choice: { type: "any" } as any,
    messages: [{ role: "user", content: buildIterateUserMessage(s, utterance) }],
  });

  let rawInput: any = null;
  let rawRevision: any = null;
  let spokenAsk: string | null = null;
  for (const block of resp.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "emit_pass" && !rawInput) rawInput = block.input;
    if (block.name === "emit_revision" && !rawRevision) rawRevision = block.input;
    if (block.name === "ask" && !spokenAsk) {
      const q = String((block.input as any)?.question ?? "").trim();
      if (q) spokenAsk = q;
    }
  }

  // Handle emit_revision (Round 2 — LLM rewrites, we diff)
  if (rawRevision) {
    const revised = String(rawRevision?.revised ?? "").trim();
    if (revised) {
      const segments = diffWords(utterance, revised);

      s.round += 1;
      s.lastUtterance = utterance;
      send(ws, { type: "revision", segments });
      send(ws, { type: "hints", items: [] });
      send(ws, { type: "pass", pass: { round: s.round, utterance, keeps: [], plan: [], done: true } });
      const askText = spokenAsk || "Read the edited version one clean time.";
      send(ws, { type: "ask", question: askText });
      await speak(ws, askText);
      return;
    }
  }

  if (!rawInput) {
    send(ws, { type: "error", message: "agent returned no pass" });
    return;
  }

  const { keeps, plan, hints, done } = validateAndNormalizePass(rawInput, utterance);

  s.round += 1;
  s.lastUtterance = utterance;
  s.lastKeeps = keeps;
  s.lastPlan = plan;

  const pass: Pass = { round: s.round, utterance, keeps, plan, done };

  // Always emit ask (text or empty) and hints (possibly empty) to keep client state in sync.
  // Suppress spoken ask on done; done screen speaks for itself.
  const askText = spokenAsk && !done ? spokenAsk : "";
  send(ws, { type: "ask", question: askText });
  send(ws, { type: "hints", items: hints });
  send(ws, { type: "pass", pass });
  if (askText) {
    await speak(ws, askText);
  }
}

function openDeepgram(ws: ServerWebSocket<unknown>, s: Session) {
  const url =
    "wss://api.deepgram.com/v1/listen" +
    "?model=nova-3" +
    "&encoding=linear16" +
    "&sample_rate=16000" +
    "&channels=1" +
    "&interim_results=true" +
    "&smart_format=true" +
    "&language=en";
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${DG_KEY}` },
  } as any);
  s.dg = dg;
  s.finals = [];

  dg.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data as string);
      if (data.type !== "Results") return;
      const txt: string = data.channel?.alternatives?.[0]?.transcript ?? "";
      if (!txt) return;
      if (data.is_final) {
        s.finals.push(txt);
        send(ws, { type: "final", text: s.finals.join(" ") });
      } else {
        send(ws, { type: "interim", text: [...s.finals, txt].join(" ") });
      }
    } catch {
      // ignore malformed frames
    }
  });
  dg.addEventListener("error", (e) => {
    console.error("deepgram error", e);
    send(ws, { type: "error", message: "stt connection error" });
  });
}

async function closeDeepgramAndGetTranscript(s: Session): Promise<string> {
  const dg = s.dg;
  if (!dg) return "";
  if (dg.readyState === WebSocket.OPEN) {
    try {
      dg.send(JSON.stringify({ type: "CloseStream" }));
    } catch {}
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    dg.addEventListener("close", finish, { once: true });
    setTimeout(finish, 250);
  });
  try {
    dg.close();
  } catch {}
  s.dg = null;
  return s.finals.join(" ").trim();
}

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("upgrade failed", { status: 400 });
    }
    return new Response("pingo backend up", { status: 200 });
  },
  websocket: {
    open(ws) {
      const session: Session = {
        phase: "idle",
        round: 0,
        gateTurns: 0,
        lastUtterance: "",
        lastPlan: [],
        lastKeeps: [],
        dg: null,
        finals: [],
      };
      sessions.set(ws, session);
      send(ws, { type: "ready" });
      send(ws, { type: "phase", phase: session.phase });
    },
    async message(ws, raw) {
      const s = sessions.get(ws);
      if (!s) return;

      if (typeof raw === "string") {
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg.type === "hello") {
          // no-op: agent stays silent until the user speaks first
        } else if (msg.type === "start_turn") {
          openDeepgram(ws, s);
        } else if (msg.type === "end_turn") {
          const utterance = await closeDeepgramAndGetTranscript(s);
          if (!utterance) {
            send(ws, { type: "error", message: "no speech captured" });
            return;
          }
          try {
            if (s.phase === "idle") {
              await runGateTurn(ws, s, utterance);
            } else if (s.phase === "orient") {
              await runOrientTurn(ws, s, utterance);
            } else {
              await runIterateTurn(ws, s, utterance);
            }
          } catch (e: any) {
            console.error(e);
            send(ws, { type: "error", message: `agent error: ${e?.message ?? e}` });
          }
        }
      } else {
        const dg = s.dg;
        if (dg && dg.readyState === WebSocket.OPEN) {
          dg.send(raw as unknown as ArrayBuffer);
        }
      }
    },
    close(ws) {
      const s = sessions.get(ws);
      if (s?.dg) {
        try {
          s.dg.close();
        } catch {}
      }
      sessions.delete(ws);
    },
  },
});

console.log(`pingo backend listening on :${PORT}`);

void (async () => {
  const buf = await synthesize(ORIENT_PROMPT);
  if (buf) {
    cachedBriefTts = { audio: buf.toString("base64"), mime: "audio/mpeg" };
    console.log(`[cache] orient TTS warmed (${buf.byteLength} bytes)`);
  }
})();
