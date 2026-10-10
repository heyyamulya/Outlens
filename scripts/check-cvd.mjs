// Quick check of color-vision simulation and enhancement. Run: node scripts/check-cvd.mjs
import { SIMULATION, applyMatrix, enhancementMatrix } from "../lib/cvd.ts";

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "DIFF"} ${name}${detail ? ` -> ${detail}` : ""}`);
}
const px = (r, g, b) => new Uint8ClampedArray([r, g, b, 255]);
const run = (rgb, m) => {
  const d = px(...rgb);
  applyMatrix(d, m);
  return [d[0], d[1], d[2]];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const red = [200, 40, 40];
const green = [60, 140, 40];

// 1. Rows of each simulation matrix add up to about 1, so white stays white.
for (const [type, m] of Object.entries(SIMULATION)) {
  const w = run([255, 255, 255], m);
  check(`${type}: white stays white`, w.every((v) => v >= 250), w.join(","));
}

// 2. For deutan viewers, red and green look much more alike than they really are.
const real = dist(red, green);
const simDeutan = dist(run(red, SIMULATION.deutan), run(green, SIMULATION.deutan));
check("deutan: red and green look closer", simDeutan < real * 0.6, `${real.toFixed(0)} -> ${simDeutan.toFixed(0)}`);

// 3. After enhancement, a deutan viewer sees red and green further apart than before.
for (const type of ["deutan", "protan"]) {
  const e = enhancementMatrix(type);
  const before = dist(run(red, SIMULATION[type]), run(green, SIMULATION[type]));
  const after = dist(run(run(red, e), SIMULATION[type]), run(run(green, e), SIMULATION[type]));
  check(`${type}: enhancement separates red and green`, after > before * 1.2, `${before.toFixed(0)} -> ${after.toFixed(0)}`);
}

// 4. Tritan: blue vs. green, enhanced, are further apart for a tritan viewer.
{
  const blue = [40, 90, 200];
  const teal = [40, 160, 140];
  const e = enhancementMatrix("tritan");
  const before = dist(run(blue, SIMULATION.tritan), run(teal, SIMULATION.tritan));
  const after = dist(run(run(blue, e), SIMULATION.tritan), run(run(teal, e), SIMULATION.tritan));
  check("tritan: enhancement separates blue and teal", after > before, `${before.toFixed(0)} -> ${after.toFixed(0)}`);
}

// 5. Grays are left alone by enhancement.
{
  const g = run([128, 128, 128], enhancementMatrix("deutan"));
  check("gray unchanged by enhancement", g.every((v) => Math.abs(v - 128) <= 2), g.join(","));
}

console.log(failures ? `\n${failures} difference(s)` : "\nAll checks match.");
