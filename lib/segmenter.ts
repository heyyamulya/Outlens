// Loads MediaPipe's Interactive Segmenter in the browser and runs it on a still frame.
// Inference runs on the device and frames are never uploaded. MediaPipe does send
// usage metrics (not images) to Google; see its privacy notice.

import type { BrushMode, InteractiveSegmenter } from "@mediapipe/tasks-vision";
import type { Mask, Point } from "./outline";

// Pinned to the installed package version, and to the model's versioned (/1/) path.
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task";

// In 1.0.1, BrushMode exists only in vision.d.ts; the JS bundle does not export it, so
// vision.BrushMode is undefined at runtime. segment() maps the number through
// {0:0, 1:1, 2:2, 3:3}, and 1 is POSITIVE in the .d.ts enum.
const POSITIVE_STROKE = 1 as BrushMode;

// Give up (the app then uses the simple shape) if the download stalls or setup hangs.
const DOWNLOAD_STALL_MS = 20000;
const SETUP_TIMEOUT_MS = 60000;

export type Segmenter = InteractiveSegmenter;

let loading: Promise<Segmenter> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Downloads the model with progress (0–1), since it is about 30 MB. Aborts if it stalls. */
async function downloadModel(onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  };
  try {
    const response = await fetch(MODEL_URL, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`);
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStallTimer();
      chunks.push(value);
      received += value.length;
      if (total) onProgress(Math.min(1, received / total));
    }
    const model = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      model.set(chunk, offset);
      offset += chunk.length;
    }
    return model;
  } finally {
    clearTimeout(stallTimer);
  }
}

/** Loads once and shares the result; a failed load can be tried again. */
export function loadSegmenter(onProgress: (fraction: number) => void): Promise<Segmenter> {
  if (!loading) {
    loading = (async () => {
      const [vision, model] = await Promise.all([import("@mediapipe/tasks-vision"), downloadModel(onProgress)]);
      return withTimeout(
        (async () => {
          const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
          // On a laptop, CPU took about 12 s per tap, so try the graphics chip (GPU) first.
          // If the GPU can't start here, use the CPU as before.
          try {
            const segmenter = await vision.InteractiveSegmenter.createFromOptions(fileset, {
              baseOptions: { modelAssetBuffer: model, delegate: "GPU" },
            });
            console.info("Outline engine: GPU");
            return segmenter;
          } catch (err) {
            console.warn("Outline engine: GPU unavailable, using CPU", err);
            const segmenter = await vision.InteractiveSegmenter.createFromOptions(fileset, {
              baseOptions: { modelAssetBuffer: model, delegate: "CPU" },
            });
            console.info("Outline engine: CPU");
            return segmenter;
          }
        })(),
        SETUP_TIMEOUT_MS,
        "Outline engine setup timed out",
      );
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * Confidence mask for the object at `point` (frame pixel coordinates).
 * setImage runs the heavy step once per frame; segment is the light per-tap step.
 * Both block the page while they run. Returns how long each step took, in ms
 * (prepareMs is 0 when the frame was already set).
 */
export function segmentAt(
  segmenter: Segmenter,
  frame: HTMLCanvasElement,
  point: Point,
  newImage: boolean,
): { mask: Mask; prepareMs: number; tapMs: number } {
  const started = performance.now();
  if (newImage) segmenter.setImage(frame);
  const prepared = performance.now();
  const mask = segmenter.segment([
    {
      brushMode: POSITIVE_STROKE,
      point: [{ x: point.x / frame.width, y: point.y / frame.height }],
      isCompleted: true,
    },
  ]);
  try {
    const result = { data: mask.getAsFloat32Array().slice(), width: mask.width, height: mask.height };
    return { mask: result, prepareMs: prepared - started, tapMs: performance.now() - prepared };
  } finally {
    mask.close();
  }
}
