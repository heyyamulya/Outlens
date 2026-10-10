// Turns a short phrase into speech with ElevenLabs. The API key stays on the server
// (ELEVENLABS_API_KEY in Vercel's environment variables) and never reaches the browser.
// Checked against ElevenLabs' docs: POST /v1/text-to-speech/:voice_id with header
// "xi-api-key" and JSON { text }; model and output format use the defaults
// (eleven_multilingual_v2, mp3_44100_128).

// Example voice from ElevenLabs' docs; set ELEVENLABS_VOICE_ID to use another.
const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

// Only phrases the app itself makes, so nobody can use this route to spend the credits
// on other text. Examples: "Estimated color: dark blue." and
// "Paper plate. Estimated color: white." (the name comes from Gemini, letters only).
const ALLOWED = /^(?:[A-Z][a-z -]{0,29}\. )?Estimated color: [a-z][a-z -]{0,40}\.$/;

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice is not set up" }, { status: 503 });

  let text: unknown;
  try {
    ({ text } = await request.json());
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof text !== "string" || !ALLOWED.test(text)) {
    return Response.json({ error: "Phrase not allowed" }, { status: 400 });
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!upstream.ok || !upstream.body) {
    // Log the status only; the response body could echo request details.
    console.error(`ElevenLabs request failed (${upstream.status})`);
    return Response.json({ error: "Voice service failed" }, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg" },
  });
}
