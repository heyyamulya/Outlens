// "Magic wand" selection: starting at the tap, grow outward over neighboring pixels of
// similar color, and stop where the color clearly changes. No model, no network; runs on
// the device in a few milliseconds. Pure functions with no browser APIs, so they can be
// checked with plain Node (see scripts/check-outline.mjs).
//
// Colors are compared in CIELAB, which is built to match how different colors look to
// people. Lightness counts for less than hue, so gentle shading stays inside the object.

import type { Frame, Mask, Point } from "./outline";

const GRID_MAX_SIZE = 320; // work at this size (longer side), like outline.ts
const SEED_RADIUS = 2; // cells around the tap used to pick the starting color
const MAX_DIFF_FROM_START = 20; // how far from the tapped color the region may drift
const MAX_DIFF_TO_NEIGHBOR = 9; // a jump bigger than this between neighbors is an edge
const LIGHTNESS_WEIGHT_COLORFUL = 0.35; // shading matters less on colorful surfaces
const LIGHTNESS_WEIGHT_NEUTRAL = 1; // on white/gray/black, lightness is the color
const NEUTRAL_CHROMA = 12; // below this, the tapped color counts as white/gray/black
const SHADE_MAX_BOOST = 2; // shadow correction: scale color strength by at most this much

type Lab = { l: number; a: number; b: number };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) to CIELAB, D65 white point. */
function toLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** The frame scaled down (each cell is the average of the pixels it covers), as Lab. */
function labGrid(frame: Frame): { cells: Lab[]; width: number; height: number } {
  const scale = Math.min(1, GRID_MAX_SIZE / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const cells: Lab[] = new Array(width * height);
  for (let gy = 0; gy < height; gy++) {
    const y0 = Math.floor((gy * frame.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * frame.height) / height));
    for (let gx = 0; gx < width; gx++) {
      const x0 = Math.floor((gx * frame.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * frame.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * frame.width + x) * 4;
          r += frame.data[i];
          g += frame.data[i + 1];
          b += frame.data[i + 2];
          n++;
        }
      }
      cells[gy * width + gx] = toLab(r / n, g / n, b / n);
    }
  }
  return { cells, width, height };
}

function median(values: number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A yes/no mask (1 = selected) of the same-colored area around `tap` (frame pixels).
 * Small holes inside the area (glare, a logo) are filled in. The mask may be smaller than
 * the frame; outlineFromMask scales it back.
 */
export function colorMaskAt(frame: Frame, tap: Point): Mask {
  const { cells, width, height } = labGrid(frame);
  const cx = Math.min(width - 1, Math.max(0, Math.floor((tap.x / frame.width) * width)));
  const cy = Math.min(height - 1, Math.max(0, Math.floor((tap.y / frame.height) * height)));

  // Starting color: the median of a small patch around the tap, so one odd pixel can't decide it.
  const patch: Lab[] = [];
  for (let y = cy - SEED_RADIUS; y <= cy + SEED_RADIUS; y++) {
    for (let x = cx - SEED_RADIUS; x <= cx + SEED_RADIUS; x++) {
      if (x >= 0 && y >= 0 && x < width && y < height) patch.push(cells[y * width + x]);
    }
  }
  const start: Lab = {
    l: median(patch.map((c) => c.l)),
    a: median(patch.map((c) => c.a)),
    b: median(patch.map((c) => c.b)),
  };
  const neutral = Math.hypot(start.a, start.b) < NEUTRAL_CHROMA;
  const lightnessWeight = neutral ? LIGHTNESS_WEIGHT_NEUTRAL : LIGHTNESS_WEIGHT_COLORFUL;
  const diff = (p: Lab, q: Lab) => Math.hypot((p.l - q.l) * lightnessWeight, p.a - q.a, p.b - q.b);
  // In shadow, a colorful surface loses lightness and color strength together. Before
  // comparing with the tapped color, scale its color strength back up by the lightness
  // ratio (within limits, so very dark noise isn't blown up).
  const diffFromStart = (c: Lab) => {
    if (neutral) return diff(c, start);
    const k = Math.min(SHADE_MAX_BOOST, Math.max(1 / SHADE_MAX_BOOST, start.l / Math.max(1, c.l)));
    return diff({ l: c.l, a: c.a * k, b: c.b * k }, start);
  };

  // Grow from the tap.
  const selected = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const seed = cy * width + cx;
  selected[seed] = 1;
  stack[top++] = seed;
  const tryAdd = (from: number, to: number) => {
    if (selected[to]) return;
    const c = cells[to];
    if (diffFromStart(c) > MAX_DIFF_FROM_START || diff(c, cells[from]) > MAX_DIFF_TO_NEIGHBOR) return;
    selected[to] = 1;
    stack[top++] = to;
  };
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) tryAdd(i, i - 1);
    if (x < width - 1) tryAdd(i, i + 1);
    if (i >= width) tryAdd(i, i - width);
    if (i < width * (height - 1)) tryAdd(i, i + width);
  }

  // Fill holes: anything not selected that can't reach the picture's border is inside.
  const outside = new Uint8Array(width * height);
  top = 0;
  const markOutside = (i: number) => {
    if (!selected[i] && !outside[i]) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    markOutside(x);
    markOutside((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    markOutside(y * width);
    markOutside(y * width + width - 1);
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) markOutside(i - 1);
    if (x < width - 1) markOutside(i + 1);
    if (i >= width) markOutside(i - width);
    if (i < width * (height - 1)) markOutside(i + width);
  }

  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = outside[i] ? 0 : 1;
  return { data, width, height };
}
