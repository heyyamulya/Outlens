// Turns a segmentation confidence mask into an outline and the pixels inside it.
// Pure functions with no browser APIs, so they can be checked with plain Node
// (see scripts/check-outline.mjs).

import type { RGB } from "./color";

export type Point = { x: number; y: number };
export type Mask = { data: Float32Array; width: number; height: number }; // confidence 0–1 per pixel
export type Frame = { data: Uint8ClampedArray; width: number; height: number }; // RGBA

type Grid = { data: Uint8Array; width: number; height: number }; // 1 = object

export type OutlineResult = {
  loops: Point[][]; // closed outlines, in frame pixel coordinates
  pixels: RGB[]; // frame pixels inside the outline, for color estimation
  areaFraction: number; // share of the frame covered by the object
};

const CONFIDENCE_THRESHOLD = 0.5;
const GRID_MAX_SIZE = 320; // work at this size (longer side) for speed
const SEED_SEARCH_RADIUS = 3; // grid pixels to look around if the tap lands just outside the mask
const MIN_AREA_FRACTION = 0.002; // smaller than this is probably noise
const MAX_AREA_FRACTION = 0.6; // larger than this is probably the background
const MIN_LOOP_AREA = 12; // grid pixels; smaller loops are specks
const SIMPLIFY_TOLERANCE = 0.8; // grid pixels
const MAX_COLOR_SAMPLES = 20000;

/** Confidence mask to a yes/no grid, scaled down so the longer side is at most GRID_MAX_SIZE. */
function toGrid(mask: Mask): Grid {
  const scale = Math.min(1, GRID_MAX_SIZE / Math.max(mask.width, mask.height));
  const width = Math.max(1, Math.round(mask.width * scale));
  const height = Math.max(1, Math.round(mask.height * scale));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const my = Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width));
      data[y * width + x] = mask.data[my * mask.width + mx] >= CONFIDENCE_THRESHOLD ? 1 : 0;
    }
  }
  return { data, width, height };
}

/** Index of an object cell at or near (x, y), or null if there is none close by. */
function findSeed(grid: Grid, x: number, y: number): number | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  for (let r = 0; r <= SEED_SEARCH_RADIUS; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) continue;
        if (grid.data[py * grid.width + px]) return py * grid.width + px;
      }
    }
  }
  return null;
}

/** The connected patch of object cells that contains the seed. */
function floodFill(grid: Grid, seed: number): { component: Grid; count: number } {
  const { width, height } = grid;
  const out = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  let count = 0;
  const visit = (j: number) => {
    if (grid.data[j] && !out[j]) {
      out[j] = 1;
      stack[top++] = j;
    }
  };
  visit(seed);
  while (top > 0) {
    const i = stack[--top];
    count++;
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  }
  return { component: { data: out, width, height }, count };
}

/** Shrinks the object by one cell so edge pixels (often mixed with background) are left out. */
function erode(grid: Grid): Grid {
  const { data, width, height } = grid;
  const out = new Uint8Array(data.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (data[i] && data[i - 1] && data[i + 1] && data[i - width] && data[i + width]) out[i] = 1;
    }
  }
  return { data: out, width, height };
}

/** Closed loops along the borders between object and non-object cells (outer edges and holes). */
function traceLoops(grid: Grid): Point[][] {
  const { data, width, height } = grid;
  const stride = width + 1; // corners per row
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] === 1;

  // Directed cell-side edges, going clockwise around object cells.
  const next = new Map<number, number[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const from = y1 * stride + x1;
    const list = next.get(from);
    if (list) list.push(y2 * stride + x2);
    else next.set(from, [y2 * stride + x2]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  // Follow edges end to start until each loop closes.
  const loops: Point[][] = [];
  for (const [start, list] of next) {
    while (list.length > 0) {
      const loop: Point[] = [];
      let v = start;
      do {
        loop.push({ x: v % stride, y: Math.floor(v / stride) });
        const out = next.get(v);
        if (!out || out.length === 0) break;
        v = out.pop()!;
      } while (v !== start);
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

function loopArea(loop: Point[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker: drops points that stay within `tolerance` of a straight line. */
function simplifyOpen(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  let index = -1;
  let maxDistance = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], first, last);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [first, last];
  const left = simplifyOpen(points.slice(0, index + 1), tolerance);
  const right = simplifyOpen(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/** Simplifies a closed loop by splitting it at the point farthest from its start. */
function simplifyClosed(points: Point[], tolerance: number): Point[] {
  if (points.length < 8) return points;
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  const a = simplifyOpen(points.slice(0, far + 1), tolerance);
  const b = simplifyOpen([...points.slice(far), points[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Frame pixels under the object, spread evenly and capped at MAX_COLOR_SAMPLES. */
function insidePixels(grid: Grid, frame: Frame): RGB[] {
  const eroded = erode(grid);
  const source = eroded.data.includes(1) ? eroded : grid;
  let count = 0;
  for (const cell of source.data) count += cell;
  const step = Math.max(1, Math.ceil(count / MAX_COLOR_SAMPLES));
  const pixels: RGB[] = [];
  let k = 0;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (!source.data[y * source.width + x] || k++ % step) continue;
      const fx = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / source.width));
      const fy = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / source.height));
      const i = (fy * frame.width + fx) * 4;
      pixels.push({ r: frame.data[i], g: frame.data[i + 1], b: frame.data[i + 2] });
    }
  }
  return pixels;
}

/**
 * Outline and inside pixels for the object under `tap` (frame coordinates).
 * Returns null when there is no clear object there, so the caller can fall back.
 * `onReject` (optional) is told why, with a few numbers about the mask, for debugging.
 */
export function outlineFromMask(
  mask: Mask,
  tap: Point,
  frame: Frame,
  onReject?: (why: string) => void,
): OutlineResult | null {
  const grid = toGrid(mask);
  const toGridX = grid.width / frame.width;
  const toGridY = grid.height / frame.height;
  const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
  const describe = () => {
    let max = 0;
    let above = 0;
    for (const v of mask.data) {
      if (v > max) max = v;
      if (v >= CONFIDENCE_THRESHOLD) above++;
    }
    const mx = Math.min(mask.width - 1, Math.floor((tap.x / frame.width) * mask.width));
    const my = Math.min(mask.height - 1, Math.floor((tap.y / frame.height) * mask.height));
    return (
      `mask ${mask.width}x${mask.height}, frame ${frame.width}x${frame.height}, ` +
      `confidence at tap ${mask.data[my * mask.width + mx].toFixed(2)}, max ${max.toFixed(2)}, ` +
      `mask covers ${pct(above / mask.data.length)} of picture`
    );
  };

  const seed = findSeed(grid, tap.x * toGridX, tap.y * toGridY);
  if (seed === null) {
    onReject?.(`nothing found at tap (${describe()})`);
    return null;
  }

  const { component, count } = floodFill(grid, seed);
  const areaFraction = count / (grid.width * grid.height);
  if (areaFraction < MIN_AREA_FRACTION || areaFraction > MAX_AREA_FRACTION) {
    const which = areaFraction < MIN_AREA_FRACTION ? "too small" : "too big";
    onReject?.(`${which}: object is ${pct(areaFraction)} of picture (${describe()})`);
    return null;
  }

  const loops = traceLoops(component)
    .filter((loop) => loopArea(loop) >= MIN_LOOP_AREA)
    .map((loop) => simplifyClosed(loop, SIMPLIFY_TOLERANCE).map((p) => ({ x: p.x / toGridX, y: p.y / toGridY })));
  if (loops.length === 0) {
    onReject?.(`no usable edge (${describe()})`);
    return null;
  }

  return { loops, pixels: insidePixels(component, frame), areaFraction };
}
