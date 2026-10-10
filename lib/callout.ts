// Where to put the callout: a label box in free space next to the selected object, a dot on
// the object's edge, and a line between them. Pure functions with no browser APIs, so they
// can be checked with plain Node (see scripts/check-callout.mjs). All values are screen pixels.

import type { Point } from "./outline";

export type Box = { left: number; top: number; right: number; bottom: number };

export type CalloutInput = {
  edge: Point[]; // the object's outer edge
  labelWidth: number;
  labelHeight: number;
  screenWidth: number;
  screenHeight: number;
  avoid: Box[]; // on-screen controls the label must not cover
};

export type CalloutPlacement = {
  label: Box;
  dot: Point; // on the object's edge, nearest the label
  lineEnd: Point; // on the label's border, nearest the dot
};

const MARGIN = 16; // keep this far from the screen edges and from controls
const GAP = 32; // space between the object and the label, so the line is visible
const OBJECT_OVERLAP_COST = 3; // covering the object is bad...
const CONTROL_OVERLAP_COST = 10; // ...covering a button is worse
const DISTANCE_COST = 0.05; // among equally clear spots, prefer the closer one

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function boundsOf(points: Point[]): Box {
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
  return { left, top, right, bottom };
}

/** Picks the label spot that covers the object and the controls the least. */
export function placeCallout(input: CalloutInput): CalloutPlacement | null {
  const { edge, labelWidth: w, labelHeight: h, screenWidth, screenHeight, avoid } = input;
  if (edge.length === 0) return null;
  const obj = boundsOf(edge);
  const cx = (obj.left + obj.right) / 2;
  const cy = (obj.top + obj.bottom) / 2;

  // Candidate top-left corners, in order of preference.
  const candidates: Point[] = [
    { x: cx - w / 2, y: obj.top - GAP - h }, // above
    { x: cx - w / 2, y: obj.bottom + GAP }, // below
    { x: obj.right + GAP, y: cy - h / 2 }, // right
    { x: obj.left - GAP - w, y: cy - h / 2 }, // left
    { x: obj.right + GAP, y: obj.top - GAP - h }, // corners
    { x: obj.left - GAP - w, y: obj.top - GAP - h },
    { x: obj.right + GAP, y: obj.bottom + GAP },
    { x: obj.left - GAP - w, y: obj.bottom + GAP },
  ];
  // Also try the free bands between the controls, for objects that fill most of the screen.
  for (const fy of [0.2, 0.35, 0.5, 0.65, 0.8]) candidates.push({ x: screenWidth / 2 - w / 2, y: screenHeight * fy - h / 2 });

  let best: Box | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    // Keep it on screen.
    const left = Math.max(MARGIN, Math.min(c.x, screenWidth - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(c.y, screenHeight - h - MARGIN));
    const box = { left, top, right: left + w, bottom: top + h };
    let cost = overlap(box, obj) * OBJECT_OVERLAP_COST;
    for (const a of avoid) {
      const padded = { left: a.left - MARGIN, top: a.top - MARGIN, right: a.right + MARGIN, bottom: a.bottom + MARGIN };
      cost += overlap(box, padded) * CONTROL_OVERLAP_COST;
    }
    cost += Math.hypot(left + w / 2 - cx, top + h / 2 - cy) * DISTANCE_COST;
    if (cost < bestCost) {
      bestCost = cost;
      best = box;
    }
  }
  if (!best) return null;

  // Dot: the edge point nearest the label's center.
  const lx = (best.left + best.right) / 2;
  const ly = (best.top + best.bottom) / 2;
  let dot = edge[0];
  let dotDistance = Infinity;
  for (const p of edge) {
    const d = Math.hypot(p.x - lx, p.y - ly);
    if (d < dotDistance) {
      dotDistance = d;
      dot = p;
    }
  }
  // Line end: the point on the label's border nearest the dot.
  const lineEnd = {
    x: Math.max(best.left, Math.min(dot.x, best.right)),
    y: Math.max(best.top, Math.min(dot.y, best.bottom)),
  };
  return { label: best, dot, lineEnd };
}

/** The outer edge of a set of loops: the loop that encloses the most area. */
export function outerLoop(loops: Point[][]): Point[] {
  let best: Point[] = [];
  let bestArea = -1;
  for (const loop of loops) {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      sum += a.x * b.y - b.x * a.y;
    }
    const area = Math.abs(sum) / 2;
    if (area > bestArea) {
      bestArea = area;
      best = loop;
    }
  }
  return best;
}

/** Points around a circle (the simple fallback shape). */
export function circlePoints(center: Point, radius: number, count = 48): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    return { x: center.x + Math.cos(t) * radius, y: center.y + Math.sin(t) * radius };
  });
}
