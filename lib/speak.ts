// Reads a phrase aloud. ElevenLabs (through our /api/speak route) when its audio is ready,
// otherwise the browser's built-in voice (Web Speech API, in browsers since 2018).
//
// Phones only allow sound to start right inside a tap. So the audio is fetched ahead of
// time (prepare, when a label appears) and played instantly on Listen. If it isn't ready
// yet, the browser voice speaks right away instead, inside the same tap.

const ready = new Map<string, string>(); // phrase -> object URL of its audio
const pending = new Map<string, Promise<void>>();
let current: HTMLAudioElement | null = null;
// One audio element, unlocked during a tap, so later replies (after voice commands) may play.
let shared: HTMLAudioElement | null = null;
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

/**
 * Call inside a tap (e.g. the 🎤 button). Phones only allow sound to start in a tap; this
 * starts a silent sound and a silent utterance so replies a few seconds later can be heard.
 */
export function unlockAudio() {
  try {
    shared ??= new Audio();
    shared.src = SILENT_WAV;
    shared.play().catch(() => {});
  } catch {
    // ignore
  }
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    // ignore
  }
}

/** Starts fetching ElevenLabs audio for a phrase, once. Failures are fine: speech falls back. */
export function prepareSpeech(phrase: string): Promise<void> {
  if (ready.has(phrase)) return Promise.resolve();
  const existing = pending.get(phrase);
  if (existing) return existing;
  const job = fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: phrase }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Voice route returned ${res.status}`);
      ready.set(phrase, URL.createObjectURL(await res.blob()));
    })
    .catch((err) => console.info("ElevenLabs voice not available, using browser voice.", err))
    .finally(() => pending.delete(phrase));
  pending.set(phrase, job);
  return job;
}

function playUrl(url: string, phrase: string) {
  const audio = shared ?? new Audio();
  current = audio;
  audio.src = url;
  audio.play().catch(() => browserSpeak(phrase));
}

/**
 * For replies that come after a voice command (not right inside a tap): waits briefly for
 * ElevenLabs audio, then plays it on the unlocked element; otherwise uses the browser voice.
 * Phrases the voice route doesn't allow go straight to the browser voice.
 */
export async function speakReply(phrase: string, waitMs = 3000) {
  stopAll();
  if (!ready.has(phrase) && /^(?:[A-Z][a-z -]{0,29}\. )?Estimated color: [a-z][a-z -]{0,40}\.$/.test(phrase)) {
    await Promise.race([prepareSpeech(phrase), new Promise((r) => setTimeout(r, waitMs))]);
  }
  const url = ready.get(phrase);
  if (url) playUrl(url, phrase);
  else browserSpeak(phrase);
}

function stopAll() {
  current?.pause();
  current = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function browserSpeak(phrase: string): boolean {
  if (!("speechSynthesis" in window)) return false;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(phrase));
  return true;
}

/**
 * Call from a tap. Plays the first phrase whose ElevenLabs audio is ready (list the best
 * phrase first). If none is ready, the browser voice says the first phrase right away.
 * Returns false if this browser can't speak at all.
 */
export function speak(phrases: string[]): boolean {
  if (phrases.length === 0) return false;
  stopAll();
  for (const phrase of phrases) {
    const url = ready.get(phrase);
    if (!url) continue;
    playUrl(url, phrase);
    return true;
  }
  phrases.forEach((p) => prepareSpeech(p)); // so the next Listen can use ElevenLabs
  return browserSpeak(phrases[0]);
}

/**
 * The phrase for a color estimate, with the object's name when known.
 * e.g. "Estimated color: dark blue." or "Paper plate. Estimated color: white."
 */
export function colorPhrase(colorName: string, objectName?: string | null): string {
  const color = `Estimated color: ${colorName.toLowerCase()}.`;
  if (!objectName) return color;
  const name = objectName.toLowerCase();
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}. ${color}`;
}
