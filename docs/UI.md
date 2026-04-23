# UI

## Three zones

Vertical grid `[1fr / auto / auto]`.

- **TOP** — ephemeral speaker content (transcript, subtitle, thinking dots).
- **MIDDLE** — persistent reference (hints, pass panel, done panel).
- **BOTTOM** — the tap-to-speak button. Control, not content.

---

## TOP zone (mutually exclusive)

Exactly one of these shows at any moment. Highest-priority wins.

1. **User subtitle, live.** While `recording`. `you` label (dimmed cream, mono), body medium weight 44px left-aligned, blinking caret at the end.
2. **User subtitle, static + thinking dots.** While `awaiting` Pingo's response. Same user subtitle frozen (no caret); below it, centered `pingo` label (sun-yellow, mono) and three bouncing amber dots.
3. **Pingo subtitle.** Whenever `ask` is set (usually during TTS). `pingo` label (sun-yellow, mono, centered), body bold 52px centered. Clears when TTS ends so hints can take over.
4. **Tap-to-speak hint.** Only on the very first turn, before any ask or pass or hints exist.

---

## MIDDLE zone (stacked, persistent)

Top-to-bottom. Multiple can render together.

1. **Hints.** 1 to 3 fill-in-the-blank sentence frames. Centered, cream-700, ~28px medium. Bracketed slots render as sun-yellow italic pills. Shown only when `ask` is null (ie. after Pingo's spoken subtitle has cleared). Replaced atomically when a new hints event arrives.
2. **Pass panel.** Renders while a `pass` exists and `pass.done` is false.
   - Plan rows: `NN  ⓧ  note` — zero-padded index (cream-500 mono), circled keep letter (sun-700, bold, large), plain-language note (cream-900 bold, 34px).
   - Annotated transcript below, separated by a hairline: user's last utterance with labeled keep spans highlighted in sun-yellow.
3. **Done panel.** Only when `pass.done`. Replaces plan + transcript with a single hero line: `deliver it clean.` Big, black weight, cream-900.

Hints and pass panel coexist when both exist. Done panel replaces both.

---

## Phase walk-through

### Gate (idle)
- TOP: tap-to-speak hint. Then user live transcript while they speak. Then Pingo chit-chat subtitle if the agent asked a chit-chat question.
- MIDDLE: empty.
- Session transitions on `begin_brief`.

### Orient entry
Server emits ask `"Alright. First, tell me what they do."` + TTS.
- TOP: Pingo subtitle, synced with TTS.
- MIDDLE: empty.
- TTS ends → ask clears, TOP empties.

### Orient answer (user describes company)
- TOP: user live transcript → freeze + thinking dots → Pingo orient ask (`"Fill these in out loud."`) while TTS plays.
- MIDDLE: empty during TTS.
- TTS ends → ask clears. MIDDLE reveals 4 fill-in-the-blank stems (2 experience + 2 observation).
- Phase advances to `iterate`.

### Round 0 — User dumps (orient stems)
- User reads 4 stems in MIDDLE, taps, dumps all four answers messy in one take.
- TOP: user live transcript. MIDDLE: stems stay visible while recording.
- Release → TOP: user subtitle static + thinking dots.
- Pingo returns: cloze paragraph in hints. No keeps, no plan.
- While TTS: TOP is Pingo subtitle (`"Fill in the blanks out loud."`).
- TTS ends → ask clears. MIDDLE reveals cloze paragraph with blanks.

### Round 1 — Cloze
- User reads cloze paragraph, taps, fills in blanks speaking.
- Release → TOP: user subtitle static + thinking dots.
- Pingo returns: `emit_edits` with inline edits to the user's speech. done: true.
- While TTS: TOP is Pingo subtitle (`"Read the edited version one clean time."`).
- TTS ends → ask clears. MIDDLE reveals the user's transcript with strikethroughs and inline replacements.

### Round 2 — Final Read
- User reads the edited transcript clean (skipping strikethroughs, reading replacements).
- Done. No more rounds.

---

## Language rules

### Pingo speaks (TTS, subtitle)
- Language-teacher voice. Under 15 words. Contractions. Human.
- Banned: em-dashes, colons inside a sentence, "chew on", "dig in", "let's go", "got it", any chatbot filler.
- Examples: `"Finish all three in one take."`, `"Try it again, a little looser this time."`, `"Once more, in your own words."`

### Hints (silent, on screen)
Three rounds, three different hint formats:

- **Orient (round 0, 4 stems).** Fill-in-the-blank stems. 2 experience + 2 observation.
  - Experience: *"When I tried [product] I ___"*, *"What surprised me was ___"*
  - Observation: *"The people who would love this most are ___"*, *"What I think it can improve on is ___"*
  - 8 to 16 words each. One `[___]` per stem. Product name in experience stems, never a specific feature.

- **Cloze (round 1, 1 paragraph).** Agent rewrites the user's messy dump into a polished paragraph with 3-5 blanks `[___]` at key content phrases. Structure teaches better phrasing. Blanks force composing from memory.
  - Example: *"I'm native Chinese and I [___] in workplace language. That tells me the real audience is [___] in situations like [___]. But right now Pingo [___]. It should [___] instead."*

- **Inline edit (round 2).** Agent returns `emit_edits` with 3-8 edits. The UI renders the user's Round 1 transcript as a live-edited document (like Grammarly):
  - Original text at edit spans: dimmed gray with red strikethrough line (`text-cream-400 line-through decoration-red-400`)
  - Replacement text: green, semibold, with light green background pill, inline right after the strikethrough (`text-emerald-600 font-semibold bg-emerald-50`)
  - Pure deletions (empty replacement): just the strikethrough, no green pill
  - Untouched text: normal cream-900
  - Edits appear with staggered animation (300ms per edit) so the user sees them applied one by one
  - The user reads the edited version out loud, skipping strikethroughs and reading green replacements
  - This is NOT a side-by-side "expression A → expression B" list. The edits live INSIDE the transcript as inline markup, like track-changes in a document.

---

## Removed from the screen

App title, round label, connection status, sample-rate warning, footer instructions, tap-to-speak hint (after the first turn), error banner (stays in console), keep gist next to plan note (redundant with annotated transcript below).

---

## Interactions

- **Tap button** (or press spacebar) → start recording. Interrupts any playing TTS.
- **Tap again** (or spacebar again) → stop recording. Sends the turn.
- No hold-to-talk. No rapid-toggle (spacebar `repeat` ignored).
- While typing in an input, spacebar does NOT toggle.
