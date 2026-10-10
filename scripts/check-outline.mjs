// Quick check of mask-to-outline with made-up masks. Run: node scripts/check-outline.mjs
import { estimateColor } from "../lib/color.ts";
import { colorMaskAt } from "../lib/colorRegion.ts";
import { outlineFromMask } from "../lib/outline.ts";

const SIZE = 100;

/** Mask where cells for which inside(x, y) is true have confidence 0.9. */
function makeMask(inside, size = SIZE) {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inside(x, y)) data[y * size + x] = 0.9;
  return { data, width: size, height: size };
}

/** Frame painted `inner` where inside(x, y), navy elsewhere. */
function makeFrame(inside, inner) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = inside(x, y) ? inner : [0, 0, 128];
      data.set([r, g, b, 255], (y * SIZE + x) * 4);
    }
  }
  return { data, width: SIZE, height: SIZE };
}

function bounds(loop) {
  const xs = loop.map((p) => p.x);
  const ys = loop.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "DIFF"} ${name}${detail ? ` -> ${detail}` : ""}`);
}

const square = (x, y) => x >= 30 && x < 70 && y >= 30 && y < 70;
const orange = [255, 165, 0];

// 1. One square: one loop around 30..70, about 16% of the frame, orange inside.
{
  const r = outlineFromMask(makeMask(square), { x: 50, y: 50 }, makeFrame(square, orange));
  const b = r && bounds(r.loops[0]);
  check("square outline", r && r.loops.length === 1 && b.join() === "30,30,70,70", b && `bounds ${b}`);
  check("square area", r && Math.abs(r.areaFraction - 0.16) < 0.01, r && r.areaFraction.toFixed(3));
  const color = r && estimateColor(r.pixels);
  check("square color (no navy edge bleed)", color?.label === "Estimated: bright orange", color?.label);
}

// 2. Two blobs: tapping the left one outlines only the left one.
{
  const blobs = (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30) || (x >= 60 && x < 90 && y >= 60 && y < 90);
  const r = outlineFromMask(makeMask(blobs), { x: 20, y: 20 }, makeFrame(blobs, orange));
  const b = r && bounds(r.loops[0]);
  check("two blobs, left only", r && r.loops.length === 1 && b.join() === "10,10,30,30", b && `bounds ${b}`);
}

// 3. Ring: an outer edge and a hole edge.
{
  const ring = (x, y) => x >= 20 && x < 80 && y >= 20 && y < 80 && !(x >= 40 && x < 60 && y >= 40 && y < 60);
  const r = outlineFromMask(makeMask(ring), { x: 25, y: 25 }, makeFrame(ring, orange));
  check("ring has 2 loops", r?.loops.length === 2, r && `${r.loops.length} loops`);
}

// 4. Cases that should fall back (null).
{
  const frame = makeFrame(square, orange);
  check("tap on empty area -> fallback", outlineFromMask(makeMask(square), { x: 5, y: 5 }, frame) === null);
  const tiny = (x, y) => x === 50 && y === 50;
  check("tiny object -> fallback", outlineFromMask(makeMask(tiny), { x: 50, y: 50 }, frame) === null);
  check("whole frame -> fallback", outlineFromMask(makeMask(() => true), { x: 50, y: 50 }, frame) === null);
}

// 5. Mask smaller than the frame: outline still lands in frame coordinates.
{
  const half = (x, y) => x >= 15 && x < 35 && y >= 15 && y < 35;
  const r = outlineFromMask(makeMask(half, 50), { x: 50, y: 50 }, makeFrame(square, orange));
  const b = r && bounds(r.loops[0]);
  check("half-size mask scales up", b?.join() === "30,30,70,70", b && `bounds ${b}`);
}


// 6. Magic wand (colorMaskAt): outline from the picture's colors alone.
{
  const wand = (frame, tap) => outlineFromMask(colorMaskAt(frame, tap), tap, frame);

  const flat = makeFrame(square, orange);
  const r1 = wand(flat, { x: 50, y: 50 });
  const b1 = r1 && bounds(r1.loops[0]);
  check("wand: orange square on navy", r1 && r1.loops.length === 1 && b1.join() === "30,30,70,70", b1 && `bounds ${b1}`);

  // Shading: the square gets darker toward the bottom; it should still be one object.
  const shaded = makeFrame(square, orange);
  for (let y = 30; y < 70; y++) {
    const k = 1 - ((y - 30) / 40) * 0.35;
    for (let x = 30; x < 70; x++) shaded.data.set([255 * k, 165 * k, 0, 255], (y * SIZE + x) * 4);
  }
  const r2 = wand(shaded, { x: 50, y: 35 });
  const b2 = r2 && bounds(r2.loops[0]);
  check("wand: shaded square stays whole", b2?.join() === "30,30,70,70", b2 && `bounds ${b2}`);

  // Glare: a white spot inside is filled in, so there is no inner loop.
  const glare = makeFrame(square, orange);
  for (let y = 45; y < 52; y++) for (let x = 45; x < 52; x++) glare.data.set([255, 255, 255, 255], (y * SIZE + x) * 4);
  const r3 = wand(glare, { x: 35, y: 35 });
  check("wand: glare spot filled (1 loop)", r3?.loops.length === 1, r3 && `${r3.loops.length} loops`);

  // Tapping the background selects most of the picture -> fallback.
  check("wand: background tap -> fallback", wand(flat, { x: 5, y: 5 }) === null);

  // Similar but different colors side by side: orange next to red stays separate.
  const red = (x, y) => x >= 70 && x < 90 && y >= 30 && y < 70;
  const twoColor = makeFrame(square, orange);
  for (let y = 30; y < 70; y++) for (let x = 70; x < 90; x++) twoColor.data.set([200, 30, 30, 255], (y * SIZE + x) * 4);
  const r4 = wand(twoColor, { x: 50, y: 50 });
  const b4 = r4 && bounds(r4.loops[0]);
  check("wand: orange stops at red", b4?.join() === "30,30,70,70", b4 && `bounds ${b4}`);
}

console.log(failures ? `\n${failures} difference(s)` : "\nAll checks match.");
