// Quick check of callout placement with made-up shapes. Run: node scripts/check-callout.mjs
import { circlePoints, placeCallout } from "../lib/callout.ts";

const SCREEN = { screenWidth: 390, screenHeight: 844 }; // a phone, in CSS pixels
const LABEL = { labelWidth: 300, labelHeight: 64 };
const TOP_BAR = { left: 16, top: 16, right: 374, bottom: 72 }; // Home button and chip
const BOTTOM_BAR = { left: 16, top: 700, right: 374, bottom: 820 }; // hint and Resume button
const avoid = [TOP_BAR, BOTTOM_BAR];

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "DIFF"} ${name}${detail ? ` -> ${detail}` : ""}`);
}
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const onScreen = (b) => b.left >= 0 && b.top >= 0 && b.right <= SCREEN.screenWidth && b.bottom <= SCREEN.screenHeight;
const fmt = (b) => `label ${[b.left, b.top, b.right, b.bottom].map(Math.round)}`;

// 1. Small object in the middle: label is clear of the object and the controls.
{
  const edge = circlePoints({ x: 195, y: 420 }, 60);
  const obj = { left: 135, top: 360, right: 255, bottom: 480 };
  const p = placeCallout({ edge, ...LABEL, ...SCREEN, avoid });
  check("middle: on screen", p && onScreen(p.label), p && fmt(p.label));
  check("middle: does not cover object", p && !overlaps(p.label, obj));
  check("middle: does not cover controls", p && !avoid.some((a) => overlaps(p.label, a)));
}

// 2. Object near the top: the label goes below it.
{
  const edge = circlePoints({ x: 195, y: 160 }, 60);
  const p = placeCallout({ edge, ...LABEL, ...SCREEN, avoid });
  check("near top: label below object", p && p.label.top >= 220, p && fmt(p.label));
  check("near top: does not cover controls", p && !avoid.some((a) => overlaps(p.label, a)));
}

// 3. Dot is on the edge and the line ends on the label's border.
{
  const edge = circlePoints({ x: 195, y: 420 }, 60);
  const p = placeCallout({ edge, ...LABEL, ...SCREEN, avoid });
  const r = p && Math.hypot(p.dot.x - 195, p.dot.y - 420);
  check("dot on the edge", p && Math.abs(r - 60) < 0.5, p && `distance from center ${r.toFixed(1)}`);
  const e = p?.lineEnd;
  const onBorder =
    e && (Math.abs(e.x - p.label.left) < 0.5 || Math.abs(e.x - p.label.right) < 0.5 ||
      Math.abs(e.y - p.label.top) < 0.5 || Math.abs(e.y - p.label.bottom) < 0.5);
  check("line ends on label border", onBorder, e && `(${Math.round(e.x)}, ${Math.round(e.y)})`);
}

// 4. Object that fills most of the screen: label still on screen and clear of controls.
{
  const edge = circlePoints({ x: 195, y: 400 }, 300);
  const p = placeCallout({ edge, ...LABEL, ...SCREEN, avoid });
  check("huge object: on screen", p && onScreen(p.label), p && fmt(p.label));
  check("huge object: does not cover controls", p && !avoid.some((a) => overlaps(p.label, a)));
}

// 5. Object at the right edge: label stays on screen.
{
  const edge = circlePoints({ x: 370, y: 420 }, 50);
  const p = placeCallout({ edge, ...LABEL, ...SCREEN, avoid });
  check("right edge: on screen", p && onScreen(p.label), p && fmt(p.label));
}

console.log(failures ? `\n${failures} difference(s)` : "\nAll checks match.");
