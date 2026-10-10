// Color-vision deficiency (CVD) math: simulation ("see it like…") and enhancement
// (recolor so confused colors are easier to tell apart). Pure functions, checked with
// plain Node (see scripts/check-cvd.mjs).
//
// Simulation uses the matrices from Machado, Oliveira & Fernandes (2009), "A physiologically-
// based model for simulation of color vision deficiency", severity 1.0, applied to linear RGB.
// Enhancement is "daltonization" (Fidaner et al.): take the color information a viewer would
// lose (original minus simulated) and move it into channels they can still see.
// Both are approximations: they help tell colors apart; they do not restore color vision.

export type CvdType = "protan" | "deutan" | "tritan";

export type Matrix = [number, number, number, number, number, number, number, number, number];

export const SIMULATION: Record<CvdType, Matrix> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

// Where the lost information goes. Red-green: into green and blue. Blue-yellow: into red and green.
const SHIFT: Record<CvdType, Matrix> = {
  protan: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deutan: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  tritan: [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};

export const CVD_LABELS: Record<CvdType, { short: string; long: string }> = {
  protan: { short: "Red-green (protan)", long: "Red-green: protanopia (red-weak)" },
  deutan: { short: "Red-green (deutan)", long: "Red-green: deuteranopia (green-weak)" },
  tritan: { short: "Blue-yellow (tritan)", long: "Blue-yellow: tritanopia" },
};

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array(9).fill(0) as Matrix;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** One matrix for enhancement: I + SHIFT · (I − SIMULATION). Works on linear RGB. */
export function enhancementMatrix(type: CvdType): Matrix {
  const lost = IDENTITY.map((v, i) => v - SIMULATION[type][i]) as Matrix;
  const moved = multiply(SHIFT[type], lost);
  return IDENTITY.map((v, i) => v + moved[i]) as Matrix;
}

// sRGB <-> linear, as lookup tables for speed.
const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function toSrgb(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

/** Applies a 3×3 matrix (in linear RGB) to RGBA pixels, in place. */
export function applyMatrix(data: Uint8ClampedArray, m: Matrix) {
  for (let i = 0; i < data.length; i += 4) {
    const r = TO_LINEAR[data[i]];
    const g = TO_LINEAR[data[i + 1]];
    const b = TO_LINEAR[data[i + 2]];
    data[i] = toSrgb(m[0] * r + m[1] * g + m[2] * b);
    data[i + 1] = toSrgb(m[3] * r + m[4] * g + m[5] * b);
    data[i + 2] = toSrgb(m[6] * r + m[7] * g + m[8] * b);
  }
}

/** The "values" string for an SVG <feColorMatrix type="matrix"> (works in linear RGB by default). */
export function svgMatrixValues(m: Matrix): string {
  const row = (r: number) => `${m[r * 3]} ${m[r * 3 + 1]} ${m[r * 3 + 2]} 0 0`;
  return `${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0`;
}
