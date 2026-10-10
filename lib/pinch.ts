// Pinch to select (prototype): tracks one hand on the device with MediaPipe Hand Landmarker
// and reports a pinch (thumb tip meets index fingertip) as a "tap". Images stay on the device;
// MediaPipe sends usage/performance numbers (not images) to Google.
//
// Checked: the installed @mediapipe/tasks-vision 1.0.1 types (HandLandmarker.createFromOptions,
// runningMode "VIDEO", numHands, detectForVideo(frame, timestamp), result.landmarks) and the
// model URL from Google's Hand Landmarker guide. Landmark numbers follow MediaPipe's hand model:
// 0 wrist, 4 thumb tip, 8 index fingertip, 9 middle-finger base.

import type { HandLandmarker } from "@mediapipe/tasks-vision";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

// Pinch when thumb and index tips are closer than this share of the hand's size; let go
// above the second number (the gap stops flicker).
const PINCH_ON = 0.3;
const PINCH_OFF = 0.45;

let loading: Promise<HandLandmarker> | null = null;

export function loadHands(): Promise<HandLandmarker> {
  if (!loading) {
    loading = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      // CPU: the GPU path gave empty results for the segmenter in this version.
      return vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

export type HandState = {
  point: { x: number; y: number } | null; // between thumb and index tips, 0–1 of the frame
  closeness: number; // 0 = wide open, 1 = pinched
  pinched: boolean;
};

/** Reads one video frame. `wasPinched` gives the hysteresis. */
export function readHand(hands: HandLandmarker, video: HTMLVideoElement, wasPinched: boolean): HandState {
  const result = hands.detectForVideo(video, performance.now());
  const lm = result.landmarks?.[0];
  if (!lm || lm.length < 10) return { point: null, closeness: 0, pinched: false };
  const d = (a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  const size = d(0, 9) || 1e-6;
  const ratio = d(4, 8) / size;
  const pinched = wasPinched ? ratio < PINCH_OFF : ratio < PINCH_ON;
  const closeness = Math.max(0, Math.min(1, (PINCH_OFF + 0.2 - ratio) / (PINCH_OFF + 0.2 - PINCH_ON)));
  return { point: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }, closeness, pinched };
}
