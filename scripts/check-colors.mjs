// Quick check of the color namer with known colors. Run: node scripts/check-colors.mjs
import { estimateColor, nameColor } from "../lib/color.ts";

const cases = [
  [[255, 0, 0], "bright red"],
  [[128, 0, 0], "dark red"],
  [[255, 182, 193], "pink"],
  [[255, 165, 0], "bright orange"],
  [[139, 69, 19], "brown"],
  [[210, 180, 140], "light brown"],
  [[255, 255, 0], "bright yellow"],
  [[0, 128, 0], "dark green"],
  [[0, 255, 0], "bright green"],
  [[0, 0, 128], "dark blue"],
  [[135, 206, 235], "light blue"],
  [[128, 0, 128], "dark purple"],
  [[75, 0, 130], "dark purple"],
  [[250, 250, 250], "white"],
  [[10, 10, 10], "black"],
  [[64, 64, 64], "dark gray"],
  [[128, 128, 128], "gray"],
  [[200, 200, 200], "light gray"],
];

let failures = 0;
for (const [[r, g, b], expected] of cases) {
  const got = nameColor({ r, g, b });
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "DIFF"} rgb(${r}, ${g}, ${b}) -> ${got}${ok ? "" : `  (expected ${expected})`}`);
}

// Shadows and glare around a navy patch should be ignored.
const navy = { r: 0, g: 0, b: 128 };
const pixels = [
  ...Array(80).fill(navy),
  ...Array(10).fill({ r: 0, g: 0, b: 0 }),
  ...Array(10).fill({ r: 255, g: 255, b: 255 }),
];
const trimmed = estimateColor(pixels);
const trimOk = trimmed?.label === "Estimated: dark blue";
if (!trimOk) failures++;
console.log(`${trimOk ? "ok  " : "DIFF"} navy with shadows and glare -> ${trimmed?.label}`);

console.log(failures ? `\n${failures} difference(s)` : "\nAll checks match.");
