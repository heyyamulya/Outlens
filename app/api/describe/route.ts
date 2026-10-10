// Names the object in a small crop and describes its visible colors, using Gemini.
// The app sends a crop only when someone taps, and only the area around the selected
// object, never the whole camera view. Nothing is stored here. What Google may do with it
// depends on the Gemini API tier (free tier: may be used to improve Google's products;
// paid tier: not). The key stays on the server (GEMINI_API_KEY).
//
// Checked against Google's Gemini API reference: POST
// /v1beta/models/{model}:generateContent with header "x-goog-api-key"; "contents[].parts"
// holds a text part and an image part ({ inline_data: { mime_type, data } });
// generationConfig.response_mime_type "application/json" and response_schema ask for JSON;
// the answer text is in candidates[].content.parts[].text. (We first tried the newer
// Interactions API, but it did not answer within 15 s for a small image.)

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Fast, simple model: per Google's thinking docs its default thinking level is "minimal"
// (gemini-3.8-flash defaults to "medium", which took over 15 s here). Free tier per the
// pricing page. Set GEMINI_MODEL in Vercel to try another model.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_IMAGE_CHARS = 400_000; // about 300 KB of JPEG; our crops are much smaller
const TIMEOUT_MS = 15000; // Gemini can take several seconds on an image

// Let this route run long enough on Vercel for the request (and one retry).
export const maxDuration = 40;
const RATE_LIMIT = 20; // requests per minute per visitor (best effort, per server instance)

const PROMPT = `You help people with color-vision deficiency. The image is a small crop around one object someone tapped in their camera view.
Reply with JSON only:
- "name": what the main object is, in 1 to 3 plain lowercase words (for example "mug", "paper plate", "running shoe"). If unsure, use a general word like "object".
- "description": one short sentence (at most 12 words) about the colors you can see on it, for example "Mostly dark blue with a white stripe near the top."
Rules: colors are estimates, so use words like "looks" or "appears". Never say whether food is ripe, fresh, spoiled or safe to eat. No health or medical statements. No brand names. No guesses about people.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    description: { type: "STRING" },
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
  const candidates = (data as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { text?: unknown; thought?: boolean };
      if (typeof p?.text === "string" && !p.thought) return p.text;
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

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const imagePart = { inline_data: { mime_type: "image/jpeg", data: image } };
  // First try: ask for JSON that matches our schema. If Google rejects that request
  // format (400), try once more with a plain request and read the JSON from the text.
  const attempts: Record<string, unknown>[] = [
    {
      contents: [{ parts: [{ text: PROMPT }, imagePart] }],
      generationConfig: { response_mime_type: "application/json", response_schema: SCHEMA },
    },
    {
      contents: [{ parts: [{ text: `${PROMPT}\nAnswer with only the JSON object, no other text.` }, imagePart] }],
    },
  ];
  const endpoint = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;

  const started = Date.now();
  for (const [index, body] of attempts.entries()) {
    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      const why =
        e?.name === "TimeoutError"
          ? `timed out after ${TIMEOUT_MS / 1000} s`
          : `could not connect: ${e?.name ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
      console.error(`Gemini request ${why.trim()} (attempt ${index + 1})`);
      return Response.json({ error: "Naming service unavailable" }, { status: 502 });
    }

    if (!upstream.ok) {
      // Google's error message says what it objected to; it never contains our key.
      let message = "";
      try {
        const err = (await upstream.json()) as { error?: { message?: string } };
        message = (err?.error?.message ?? "").slice(0, 300);
      } catch {
        // no readable error body
      }
      console.error(`Gemini request failed (${upstream.status}, attempt ${index + 1}): ${message}`);
      if (upstream.status === 400 && index < attempts.length - 1) continue;
      return Response.json({ error: "Naming service failed" }, { status: 502 });
    }

    try {
      const text = findText(await upstream.json());
      if (!text) throw new Error("no text in reply");
      // Accept plain JSON, or JSON wrapped in ```json fences.
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      const reply = JSON.parse(json) as { name?: unknown; description?: unknown };
      const name = cleanName(reply.name);
      if (!name) throw new Error("no usable name");
      console.info(`Gemini (${model}) named "${name}" in ${Date.now() - started} ms`);
      return Response.json({ name, description: cleanDescription(reply.description) });
    } catch (err) {
      console.error("Gemini reply could not be used:", err instanceof Error ? err.message : err);
      return Response.json({ error: "Naming service gave no answer" }, { status: 502 });
    }
  }
  return Response.json({ error: "Naming service failed" }, { status: 502 });
}
