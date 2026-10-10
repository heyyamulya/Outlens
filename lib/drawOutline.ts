// Draws the selection on the overlay canvas: a dark halo, a blue line, and a thin
// white strip just inside the edge, so it shows on both bright and dark scenes.

import type { Point } from "./outline";

export type Shape =
  | { kind: "outline"; loops: Point[][] } // frame pixel coordinates
  | { kind: "simple"; center: Point; radius: number }; // fallback rounded shape, frame pixels

export type View = { scale: number; offsetX: number; offsetY: number };

const HALO = "rgba(14, 22, 36, 0.8)"; // navy
const LINE = "#4DA3FF"; // blue
const INNER = "#FFFFFF";

/** How a frame maps into a box with object-fit: cover (scaled up, centered, cropped). */
export function coverView(boxWidth: number, boxHeight: number, frameWidth: number, frameHeight: number): View {
  const scale = Math.max(boxWidth / frameWidth, boxHeight / frameHeight);
  return {
    scale,
    offsetX: (boxWidth - frameWidth * scale) / 2,
    offsetY: (boxHeight - frameHeight * scale) / 2,
  };
}

function shapePath(shape: Shape, view: View): Path2D {
  const toScreen = (p: Point) => ({ x: view.offsetX + p.x * view.scale, y: view.offsetY + p.y * view.scale });
  const path = new Path2D();
  if (shape.kind === "simple") {
    const c = toScreen(shape.center);
    path.arc(c.x, c.y, shape.radius * view.scale, 0, Math.PI * 2);
    return path;
  }
  // Smooth closed curves through the midpoints of each side.
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  for (const loop of shape.loops) {
    const pts = loop.map(toScreen);
    if (pts.length < 3) continue;
    const start = mid(pts[pts.length - 1], pts[0]);
    path.moveTo(start.x, start.y);
    for (let i = 0; i < pts.length; i++) {
      const end = mid(pts[i], pts[(i + 1) % pts.length]);
      path.quadraticCurveTo(pts[i].x, pts[i].y, end.x, end.y);
    }
    path.closePath();
  }
  return path;
}

/** Clears the overlay (width × height CSS pixels) and draws the shape, sharp on high-density screens. */
export function drawShape(
  canvas: HTMLCanvasElement,
  shape: Shape | null,
  view: View | null,
  width: number,
  height: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!shape || !view) return;

  const path = shapePath(shape, view);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.strokeStyle = HALO;
  ctx.lineWidth = 12;
  ctx.stroke(path);

  // White strip just inside the edge: a wider stroke clipped to the inside of the shape.
  ctx.save();
  ctx.clip(path, "evenodd");
  ctx.strokeStyle = INNER;
  ctx.lineWidth = 7;
  ctx.stroke(path);
  ctx.restore();

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 4;
  ctx.stroke(path);
}
