// Color estimation for a tapped spot. Pure functions with no browser APIs,
// so they can be checked with plain Node (see scripts/check-colors.mjs).

export type RGB = { r: number; g: number; b: number }; // 0–255 each

export type ColorEstimate = {
  rgb: RGB;
  name: string; // e.g. "dark blue"
  label: string; // e.g. "Estimated: dark blue"
};

type HSL = { h: number; s: number; l: number; chroma: number }; // h 0–360, rest 0–1

// Share of pixels dropped at each end (darkest and lightest) to ignore shadows and glare.
const TRIM_FRACTION = 0.1;

/** Pixels from an RGBA buffer that fall inside a circle. */
export function pixelsInCircle(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
): RGB[] {
  const radiusSq = radius * radius;
  const pixels: RGB[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      if (dx * dx + dy * dy > radiusSq) continue;
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue; // transparent means outside the video
      pixels.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  return pixels;
}

function luminance({ r, g, b }: RGB): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Drops the darkest and lightest pixels, then takes the per-channel median of the rest. */
export function representativeColor(pixels: RGB[]): RGB | null {
  if (pixels.length === 0) return null;
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  const trim = Math.floor(sorted.length * TRIM_FRACTION);
  const kept = sorted.slice(trim, sorted.length - trim);
  return {
    r: Math.round(median(kept.map((p) => p.r))),
    g: Math.round(median(kept.map((p) => p.g))),
    b: Math.round(median(kept.map((p) => p.b))),
  };
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const chroma = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (chroma > 0) {
    if (max === rn) h = ((gn - bn) / chroma) % 6;
    else if (max === gn) h = (bn - rn) / chroma + 2;
    else h = (rn - gn) / chroma + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * l - 1));
  return { h, s, l, chroma };
}

function hueName(h: number): string {
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 65) return "yellow";
  if (h < 175) return "green";
  if (h < 255) return "blue";
  if (h < 295) return "purple";
  return "pink";
}

function modifier(s: number, l: number): string {
  if (l < 0.3) return "dark ";
  if (l > 0.72) return "light ";
  if (s > 0.75) return "bright ";
  return "";
}

/** Friendly name for a color. Thresholds are first guesses, to be tuned with real cameras. */
export function nameColor(rgb: RGB): string {
  const { h, s, l, chroma } = rgbToHsl(rgb);

  // Neutrals first. Chroma (distance from gray) is steadier than HSL saturation,
  // which jumps around for very dark and very light colors.
  if (l < 0.1) return "black";
  if (chroma < 0.08) {
    if (l > 0.85) return "white";
    if (l < 0.2) return "black";
    if (l < 0.4) return "dark gray";
    if (l > 0.7) return "light gray";
    return "gray";
  }

  const hue = hueName(h);

  // Brown is dark or muted orange (and the orange end of yellow).
  if (hue === "orange" || (hue === "yellow" && h < 50)) {
    if (l < 0.2) return "dark brown";
    if (l < 0.42) return "brown";
    if (s < 0.45 && l < 0.8) return "light brown";
  }
  if (hue === "red") {
    if (s < 0.5 && l < 0.45) return "brown";
    if (l > 0.7) return l > 0.88 ? "light pink" : "pink";
  }
  // Very dark pink/magenta reads as purple.
  if (hue === "pink" && l < 0.3) return "dark purple";

  return `${modifier(s, l)}${hue}`;
}

/** Full estimate for the sampled pixels, or null if there were none. */
export function estimateColor(pixels: RGB[]): ColorEstimate | null {
  const rgb = representativeColor(pixels);
  if (!rgb) return null;
  const name = nameColor(rgb);
  return { rgb, name, label: `Estimated: ${name}` };
}
