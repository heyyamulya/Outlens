// Names the object in a small crop and describes its visible colors, using Gemini.
// The app sends a crop only when someone taps, and only the area around the selected
// object, never the whole camera view. Nothing is stored here, and we ask Google not to
// store it either (store: false). The key stays on the server (GEMINI_API_KEY).
//
// Checked against Google's Gemini API docs (Interactions API): POST /v1beta/interactions
// with header "x-goog-api-key"; "input" holds a text part and an image part
// ({ type: "image", data: base64, mime_type }); "response_format" with
// mime_type "application/json" and a JSON "schema"; generation_config.thinking_level and
// max_output_tokens; the answer text is in steps[].content[] (type "text").

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.8-flash"; // the model used in Google's examples
const MAX_IMAGE_CHARS = 400_000; // about 300 KB of JPEG; our crops are much smaller
const TIMEOUT_MS = 8000;
const RATE_LIMIT = 20; // requests per minute per visitor (best effort, per server instance)

const PROMPT = `You help people with color-vision deficiency. The image is a small crop around one object someone tapped in their camera view.
Reply with JSON only:
- "name": what the main object is, in 1 to 3 plain lowercase words (for example "mug", "paper plate", "running shoe"). If unsure, use a general word like "object".
- "description": one short sentence (at most 12 words) about the colors you can see on it, for example "Mostly dark blue with a white stripe near the top."
Rules: colors are estimates, so use words like "looks" or "appears". Never say whether food is ripe, fresh, spoiled or safe to eat. No health or medical statements. No brand names. No guesses about people.`;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
  },
  required: ["name", "description"],
};

// Words that would break the app's rules (food safety, ripeness, health). If the reply
// uses them anyway, we drop the description and keep only the name.
const BLOCKED = /\b(ripe|unripe|rotten|spoil|spoiled|fresh|stale|expired|safe to eat|edible|mold|mould|health|healthy|medical|disease|allerg)/i;

const recent = new Map<string, number[]>();
function tooMany(visitor: string): boolean {
  const now = Date.now();
  const times = (recent.get(visitor) ?? []).filter((t) => now - t < 60_000);
  times.push(now);
  recent.set(visitor, times);
  if (recent.size > 1000) recent.clear(); // keep memory small
  return times.length > RATE_LIMIT;
}

function findText(data: unknown): string | null {
  const steps = (data as { steps?: unknown[] })?.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const content = (step as { content?: unknown[] })?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = part as { type?: string; text?: unknown };
        if (p?.type === "text" && typeof p.text === "string") return p.text;
      }
    }
  }
  return null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.toLowerCase().replace(/[^a-z -]/g, "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 30 || name.split(" ").length > 4) return null;
  return name;
}

function cleanDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 160 || BLOCKED.test(text)) return null;
  return text;
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Response.json({ error: "Naming is not set up" }, { status: 503 });

  const visitor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (tooMany(visitor)) return Response.json({ error: "Too many requests" }, { status: 429 });

  let image: unknown;
  try {
    ({ image } = await request.json());
  } catch {
    return Response.json({ error: "Bad request" }, { status: 400 });
  }
  if (typeof image !== "string" || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return Response.json({ error: "Bad image" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        input: [
          { type: "text", text: PROMPT },
          { type: "image", data: image, mime_type: "image/jpeg" },
        ],
        response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
        generation_config: { thinking_level: "minimal", max_output_tokens: 200 },
        store: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.error("Gemini request timed out or could not connect");
    return Response.json({ error: "Naming service unavailable" }, { status: 502 });
  }
  if (!upstream.ok) {
    console.error(`Gemini request failed (${upstream.status})`);
    return Response.json({ error: "Naming service failed" }, { status: 502 });
  }

  try {
    const text = findText(await upstream.json());
    if (!text) throw new Error("no text in reply");
    const reply = JSON.parse(text) as { name?: unknown; description?: unknown };
    const name = cleanName(reply.name);
    if (!name) throw new Error("no usable name");
    return Response.json({ name, description: cleanDescription(reply.description) });
  } catch (err) {
    console.error("Gemini reply could not be used:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Naming service gave no answer" }, { status: 502 });
  }
}
