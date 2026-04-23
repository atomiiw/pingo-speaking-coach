# Pingo Demo

Push-to-talk coaching agent — under 60 seconds, two phases, iterate until tight.

## Concept

A <1min screen recording of me talking to a coaching agent that helps prepare what to say to Pingo's CEO about why I want to join. The demo shows what Pingo should do for advanced learners: teach them to organize and express their thoughts, not just repeat correct sentences.

## The Problem with Pingo Right Now

Pingo teaches advanced speakers like beginners. It gives you the correct sentence and asks you to read it back. Advanced speakers don't need to see the right answer — they need to practice composing it themselves. The real challenge is not vocabulary but organizing thoughts, choosing the right structure, cutting redundancy, and circling back to the main point.

## Opening Line

"Hey Pingo, I saw this cool company today and really want to join them. What should I say to their CEO?"

## Flow

Three rounds total. Each round = one push-to-talk. Under 60 seconds.

### Round 0 — Orient

Agent shows 4 fill-in-the-blank stems on screen (2 experience + 2 observation). Says: "Fill these in out loud."

Stem types:
- Experience: "When I tried [product] I ___", "What surprised me was ___"
- Observation: "The people who would love this most are ___", "What I think it can improve on is ___"

User holds the button, dumps all four in one messy take.

### Round 1 — Cloze

Agent rewrites the user's messy dump into a polished paragraph with 3-5 blanks [___] at key content phrases. The structure teaches better phrasing. The blanks force the user to compose from memory.

Example:
"I'm native Chinese and I [___] in workplace language. That tells me the real audience is [___] in situations like [___]. But right now Pingo [___]. It should [___] instead."

User fills in the blanks speaking out loud.

### Round 2 — Inline Edit

Agent takes the user's Round 1 speech and edits it like Grammarly. The UI shows the user's transcript with:
- ~~strikethrough~~ on words/phrases being replaced
- **inline replacement** text next to each strikethrough

Fixes: wrong tense/grammar, long wordy phrases → concise replacements, filler words → deleted, vague language → precise words. 3-8 edits max, most of the text stays untouched.

User reads the edited version clean as final delivery.

## What This Shows the CEO

Messy dump → cloze with polished structure → clean final delivery in under a minute. The agent teaches structure by example (rewriting your speech better) and forces composing (blanks), instead of handing you sentences to read.

---

## Stack

- **STT** — Deepgram Nova-3 streaming (`linear16`, 16 kHz, interim results)
- **Agent** — Claude Sonnet 4.6 with tool use (one structured turn per user utterance)
- **TTS** — ElevenLabs Flash v2.5 (spoken on every `ask`)
- **Audio capture** — Web Audio `AudioWorklet` → PCM16 over WebSocket
- **Backend** — Bun + WebSockets, one file
- **Frontend** — Vite + React + Tailwind

## Setup

1. Node 20+ and [Bun](https://bun.sh) installed.
2. Get keys:
   - Deepgram: https://console.deepgram.com (free $200 credit on signup)
   - Anthropic: https://console.anthropic.com
   - ElevenLabs: https://elevenlabs.io (free tier ~10k chars/mo). Grab any voice ID from https://elevenlabs.io/app/voice-lab — the default `EXAVITQu4vr4xnSDxMaL` is "Bella".
3. Configure env:
   ```sh
   cp .env.example .env
   # fill DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, optionally ELEVENLABS_VOICE_ID
   ```
   If `ELEVENLABS_API_KEY` is omitted the demo still runs — agent replies just won't have voice.
4. Install:
   ```sh
   bun install
   ```

## Run

```sh
bun run dev
```

Opens Vite on http://localhost:5173. Bun backend runs on :8787 and is proxied via `/ws`.

Hold the button (or **spacebar**) to talk. Release to send the turn.

## Data Flow

```
browser mic → AudioWorklet (PCM16 @ 16kHz) → WS → Bun
Bun → Deepgram (streaming, interim + final)
Bun → Claude (per-turn, tool call = ask | advance | emit_pass)
Bun → browser (phase, transcript, ask, pass { keeps, plan, done })
```

## Tuning

- Change the LLM via `MODEL` env (default `claude-sonnet-4-6`). Opus 4.7 = `claude-opus-4-7`.
- System prompt + tool schemas are in `server.ts` — edit there.
- If your browser won't honor `sampleRate: 16000` on `AudioContext`, a warning shows in the UI; add resampling in `public/pcm-worklet.js` or pass actual rate to Deepgram.

## Files

- `server.ts` — Bun WS server, Deepgram proxy, Claude agent loop
- `src/App.tsx` — UI, push-to-talk, highlight renderer
- `public/pcm-worklet.js` — float32 → int16 encoder
- `shared/types.ts` — client ↔ server message types
