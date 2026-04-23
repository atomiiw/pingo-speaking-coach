import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const OUT = "tests/screenshots";
mkdirSync(OUT, { recursive: true });

// Fixture messages per stage — each array is replayed to the client as if it
// came from the real server, then a screenshot is taken of the settled UI.
const FIXTURES = {
  idle: [{ type: "ready" }],

  brief: [
    { type: "ready" },
    { type: "stage", stage: "brief" },
    { type: "hints", items: [] },
    { type: "ask", question: "Alright. First, tell me what they do." },
  ],

  orient: [
    { type: "ready" },
    { type: "stage", stage: "orient" },
    {
      type: "hints",
      items: [
        "When I tried Pingo, I [what happened].",
        "What surprised me was [what you noticed].",
        "The people who would love this most are [who and why].",
        "What I think it can improve on is [your idea].",
      ],
    },
  ],

  cloze: [
    { type: "ready" },
    { type: "stage", stage: "cloze" },
    {
      type: "hints",
      items: [
        "I'm native Chinese and I [___] in workplace language.",
        "The real audience is [___] in situations like [___].",
        "But right now Pingo [___].",
        "It should [___] instead.",
      ],
    },
    {
      type: "pass",
      pass: { round: 1, utterance: "", keeps: [], plan: [], done: false },
    },
  ],

  // Shared revision payload — three screenshots reuse the same content but
  // capture different moments in the flow.
  ...(() => {
    const REVISION_PAYLOAD = [
      { type: "ready" },
      { type: "stage", stage: "revision" },
      {
        type: "revision",
        original:
          "I'm native Chinese and I can't express myself in workplace settings. That tells me the real audience is native speakers preparing for job interviews and social media content.",
        segments: [
          { type: "keep", text: "I'm native Chinese and I " },
          { type: "delete", text: "can't" },
          { type: "insert", text: "struggle to" },
          { type: "keep", text: " express myself in workplace " },
          { type: "delete", text: "settings" },
          { type: "insert", text: "conversations" },
          { type: "keep", text: ". " },
          { type: "delete", text: "That tells me the" },
          { type: "insert", text: "The" },
          { type: "keep", text: " real audience is " },
          { type: "delete", text: "native speakers" },
          { type: "insert", text: "advanced learners" },
          { type: "keep", text: " preparing for job interviews" },
          { type: "delete", text: " and social media content" },
          { type: "keep", text: "." },
        ],
      },
      { type: "hints", items: [] },
      {
        type: "pass",
        pass: { round: 2, utterance: "...", keeps: [], plan: [], done: false },
      },
    ];

    return {
      // Page 1: Pingo speaking "I cleaned it up a bit. Read this version back."
      // subtitle only, no MIDDLE content yet (gated by `ask`).
      "revision-speak": [
        ...REVISION_PAYLOAD,
        {
          type: "ask",
          question: "I cleaned it up a bit. Read this version back to me.",
        },
      ],

      // Page 2 (start): TTS has ended, ask cleared by client's onEnd handler.
      // MIDDLE shows the diff. TOP is EMPTY — waiting for Atom to tap.
      "revision-wait": [...REVISION_PAYLOAD],

      // Page 2 (reading): Atom has started reading the clean version aloud.
      // Her live transcription appears at TOP; the diff stays in MIDDLE so
      // she can read from it while speaking.
      "revision-read": [
        ...REVISION_PAYLOAD,
        {
          type: "final",
          text: "I'm native Chinese and I struggle to express myself in workplace conversations. The real audience is advanced learners preparing for job interviews.",
        },
      ],
    };
  })(),

  // done-speak (page 1): Pingo says "Alright. Now deliver it clean."
  // Subtitle up, no middle content yet.
  "done-speak": [
    { type: "ready" },
    { type: "stage", stage: "done" },
    {
      type: "hints",
      items: [
        "native Chinese · workplace conversations",
        "advanced learners · job interviews",
        "compose with hints, don't hand the answer",
      ],
    },
    {
      type: "pass",
      pass: { round: 3, utterance: "", keeps: [], plan: [], done: true },
    },
    { type: "ask", question: "Alright. Now deliver it clean." },
  ],

  // done-memory (page 2): Pingo finished speaking, Atom is delivering the
  // speech from memory. TOP: Atom's live transcription. MIDDLE: memory hints.
  "done-memory": [
    { type: "ready" },
    { type: "stage", stage: "done" },
    {
      type: "hints",
      items: [
        "native Chinese · workplace conversations",
        "advanced learners · job interviews",
        "compose with hints, don't hand the answer",
      ],
    },
    {
      type: "pass",
      pass: { round: 3, utterance: "", keeps: [], plan: [], done: true },
    },
    {
      type: "final",
      text: "I'm native Chinese and I struggle to express myself in workplace conversations. The real audience is advanced learners preparing for job interviews.",
    },
  ],
};

const browser = await chromium.launch({ headless: true });
const paths = [];
for (const [name, msgs] of Object.entries(FIXTURES)) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  await page.routeWebSocket("**/ws", (ws) => {
    for (const m of msgs) {
      ws.send(JSON.stringify(m));
    }
  });

  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  // Give fonts + any fade-in animations time to settle.
  await page.waitForTimeout(1200);

  const out = join(OUT, `${name}.png`);
  await page.screenshot({ path: out, fullPage: false });
  paths.push({ name, out });
  console.log(`✓ ${name} → ${out}`);

  await ctx.close();
}

await browser.close();
console.log("\ndone");
console.log(paths.map((p) => p.out).join("\n"));
