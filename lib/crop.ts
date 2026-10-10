// Makes the small picture sent to Gemini: only the area around the selected object, from
// the frozen frame, scaled down to at most CROP_MAX_SIZE pixels. It lives in memory only
// and is never saved.

import type { Point } from "./outline";

const CROP_MAX_SIZE = 384;
const PADDING = 0.15; // extra space around the object, as a share of its size
const JPEG_QUALITY = 0.8;

let canvas: HTMLCanvasElement | null = null;

/** Base64 JPEG (no "data:" prefix) of the area around `points` (frame pixels), or null. */
export function cropAround(frame: HTMLCanvasElement, points: Point[]): string | null {
  if (points.length === 0 || !frame.width || !frame.height) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  const padX = (right - left) * PADDING + 8;
  const padY = (bottom - top) * PADDING + 8;
  left = Math.max(0, Math.floor(left - padX));
  top = Math.max(0, Math.floor(top - padY));
  right = Math.min(frame.width, Math.ceil(right + padX));
  bottom = Math.min(frame.height, Math.ceil(bottom + padY));
  const width = right - left;
  const height = bottom - top;
  if (width < 8 || height < 8) return null;

  const scale = Math.min(1, CROP_MAX_SIZE / Math.max(width, height));
  canvas ??= document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(frame, left, top, width, height, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  canvas.width = 0; // clear it from memory
  canvas.height = 0;
  return url.slice(url.indexOf(",") + 1);
}

export type ObjectInfo = { name: string; description: string | null };

/** Asks our /api/describe route to name the object (detail: a longer description). Null on failure. */
export async function describeCrop(image: string, detail = false, timeoutMs = 20000): Promise<ObjectInfo | null> {
  try {
    const res = await fetch("/api/describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, detail }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Describe route returned ${res.status}`);
    const info = (await res.json()) as ObjectInfo;
    return typeof info?.name === "string" ? info : null;
  } catch (err) {
    console.info("Object naming not available:", err);
    return null;
  }
}
