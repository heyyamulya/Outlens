// "Ask": short spoken commands, recognized by the browser's built-in speech recognition
// (Web Speech API). This file only turns the heard words into a command, so it can be
// checked with plain Node (see scripts/check-voice.mjs).

export type VoiceCommand = "describe" | "boost" | "unboost" | "actual" | "user" | "more" | "resume" | "close";

/** The command in a spoken sentence, or null. `userName` is the active user (e.g. "Maya"). */
export function parseCommand(text: string, userName: string): VoiceCommand | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim()} `;
  const name = userName.toLowerCase();
  const has = (...words: string[]) => words.some((w) => t.includes(` ${w} `) || t.includes(` ${w}`));
  if (has("unboost", "remove boost", "no boost", "without boost", "turn off boost")) return "unboost";
  if (has("boost", "enhance", "my colors", "my colours")) return "boost";
  if (has("actual", "normal", "real vision", "real colors", "original")) return "actual";
  if ((name && t.includes(` ${name}`)) || has("my vision", "my eyes", "their vision")) return "user";
  if (has("more", "detail", "tell me more", "describe more")) return "more";
  if (has("resume", "continue", "go back", "unpause", "unfreeze")) return "resume";
  if (has("close", "dismiss", "clear", "hide label")) return "close";
  if (has("what", "color", "colour", "read", "say", "describe", "name")) return "describe";
  return null;
}
