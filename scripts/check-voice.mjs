// Quick check of spoken-command parsing. Run: node scripts/check-voice.mjs
import { parseCommand } from "../lib/voiceCommand.ts";

let failures = 0;
const cases = [
  ["What is this?", "describe"],
  ["what color is it", "describe"],
  ["Boost", "boost"],
  ["boost the colors", "boost"],
  ["remove boost", "unboost"],
  ["Switch to actual vision", "actual"],
  ["normal view", "actual"],
  ["Show Maya's vision", "user"],
  ["more detail please", "more"],
  ["resume", "resume"],
  ["close", "close"],
  ["banana", null],
];
for (const [text, want] of cases) {
  const got = parseCommand(text, "Maya");
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "DIFF"} "${text}" -> ${got}`);
}
console.log(failures ? `\n${failures} difference(s)` : "\nAll checks match.");
