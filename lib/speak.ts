// Reads a phrase aloud. ElevenLabs (through our /api/speak route) when its audio is ready,
// otherwise the browser's built-in voice (Web Speech API, in browsers since 2018).
//
// Phones only allow sound to start right inside a tap. So the audio is fetched ahead of
// time (prepare, when a label appears) and played instantly on Listen. If it isn't ready
// yet, the browser voice speaks right away instead, inside the same tap.

const ready = new Map<string, string>(); // phrase -> object URL of its audio
const pending = new Set<string>();
let current: HTMLAudioElement | null = null;

/** Starts fetching ElevenLabs audio for a phrase, once. Failures are fine: speech falls back. */
export function prepareSpeech(phrase: string) {
  if (ready.has(phrase) || pending.has(phrase)) return;
  pending.add(phrase);
  fetch("/api/speak", {
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

/** Call from a tap. Returns false if this browser can't speak at all. */
export function speak(phrase: string): boolean {
  stopAll();
  const url = ready.get(phrase);
  if (url) {
    const audio = new Audio(url);
    current = audio;
    audio.play().catch(() => browserSpeak(phrase));
    return true;
  }
  prepareSpeech(phrase); // so the next Listen can use ElevenLabs
  return browserSpeak(phrase);
}

/** The phrase for a color estimate, e.g. "Estimated color: dark blue." */
export function colorPhrase(colorName: string): string {
  return `Estimated color: ${colorName.toLowerCase()}.`;
}
