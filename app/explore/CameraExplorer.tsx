"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { estimateColor, pixelsInCircle, type ColorEstimate } from "@/lib/color";
import { coverView, drawShape, type Shape } from "@/lib/drawOutline";
import { outlineFromMask, type Frame, type OutlineResult, type Point } from "@/lib/outline";
import { loadSegmenter, segmentAt, type Segmenter } from "@/lib/segmenter";

type Status = "idle" | "starting" | "live" | "denied" | "no-camera" | "busy" | "unsupported" | "error";

type ModelState =
  | { kind: "idle" }
  | { kind: "loading"; percent: number }
  | { kind: "ready" }
  | { kind: "fallback"; reason: string };

type Reading = { point: Point; estimate: ColorEstimate }; // point in frame pixels

// Sample circle radius as a share of the camera image's shorter side (fallback color sample).
const SAMPLE_RADIUS_FRACTION = 0.02;
// Radius of the fallback rounded shape, in screen pixels.
const SIMPLE_SHAPE_RADIUS = 56;
// A tap's outline step (not counting the once-per-frame prepare step) is "slow" above this.
const SLOW_SEGMENT_MS = 2000;
// After this many slow taps in a row (the first tap never counts), later taps use the simple shape.
const SLOW_TAPS_BEFORE_FALLBACK = 2;

const SAMPLE_SCENES_NOTE = "Sample scenes you can explore without a camera are coming in a later version.";

const MESSAGES: Record<"denied" | "no-camera" | "busy" | "unsupported" | "error", { title: string; body: string }> = {
  denied: {
    title: "Camera permission is off",
    body: `Outlens needs the camera to estimate colors. You can allow it in your browser's site settings, then tap Try again. ${SAMPLE_SCENES_NOTE}`,
  },
  "no-camera": {
    title: "No camera found",
    body: `We couldn't find a camera on this device. ${SAMPLE_SCENES_NOTE}`,
  },
  busy: {
    title: "The camera is busy",
    body: "Another app or tab may be using the camera. Close it, then tap Try again.",
  },
  unsupported: {
    title: "Camera not available here",
    body: "This browser can't open the camera on this page. Try Safari or Chrome, and check that the address starts with https.",
  },
  error: {
    title: "Something went wrong",
    body: "The camera couldn't start. Tap Try again.",
  },
};

function statusForError(err: unknown): Status {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  if (name === "SecurityError" || name === "TypeError") return "unsupported";
  return "error";
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Copies the current video frame into `canvas` (kept in memory, never saved or sent). */
function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Frame | null {
  const { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return null;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, width, height };
}

// The frame fills the screen with object-fit: cover, so it is scaled up and cropped.
// Convert a screen point to the matching pixel in the frame.
function toFramePoint(rect: DOMRect, frame: Frame, clientX: number, clientY: number): Point | null {
  const view = coverView(rect.width, rect.height, frame.width, frame.height);
  const x = (clientX - rect.left - view.offsetX) / view.scale;
  const y = (clientY - rect.top - view.offsetY) / view.scale;
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  return { x, y };
}

/** Fallback color: a small circle around the point, as in Stage 1. */
function sampleCircle(
  source: HTMLCanvasElement,
  { x, y }: Point,
  canvasRef: { current: HTMLCanvasElement | null },
): ColorEstimate | null {
  const { width: fw, height: fh } = source;
  const radius = Math.max(4, Math.round(Math.min(fw, fh) * SAMPLE_RADIUS_FRACTION));
  const left = Math.max(0, Math.floor(x - radius));
  const top = Math.max(0, Math.floor(y - radius));
  const width = Math.min(fw, Math.ceil(x + radius)) - left;
  const height = Math.min(fh, Math.ceil(y + radius)) - top;
  if (width <= 0 || height <= 0) return null;

  const canvas = (canvasRef.current ??= document.createElement("canvas"));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, left, top, width, height, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  return estimateColor(pixelsInCircle(data, width, height, x - left, y - top, radius));
}

/** Waits until the browser has painted, so "Outlining…" shows before the segmenter blocks the page. */
function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function chipText(model: ModelState, working: boolean, note: string | null): string | null {
  if (working) return "Outlining…";
  if (model.kind === "loading") return model.percent < 100 ? `Loading outline… ${model.percent}%` : "Preparing outline…";
  if (model.kind === "fallback") return `Outline: simple shape (${model.reason})`;
  if (note) return `Simple shape: ${note}`;
  if (model.kind === "ready") return "Outline ready";
  return null;
}

export default function CameraExplorer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const segmenterRef = useRef<Segmenter | null>(null);
  const loadStartedRef = useRef(false);
  const frameRef = useRef<Frame | null>(null);
  const imageSetRef = useRef(false);
  const workingRef = useRef(false);
  const tapCountRef = useRef(0); // outline taps so far (the first one includes engine warm-up)
  const slowTapsRef = useRef(0); // slow taps in a row

  const [status, setStatus] = useState<Status>("idle");
  const [model, setModel] = useState<ModelState>({ kind: "idle" });
  const [frozen, setFrozen] = useState(false);
  const [working, setWorking] = useState(false);
  const [shape, setShape] = useState<Shape | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Attach the stream once the video is visible (iPhone only autoplays visible video).
  useEffect(() => {
    const video = videoRef.current;
    if (status !== "live" || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    video.play().catch(() => {}); // autoplay normally starts it; this is a backup
  }, [status]);

  // Turn the camera off when leaving the page.
  useEffect(() => () => stopStream(streamRef.current), []);

  // Draw the outline and place the ring and label, in step with the cropped frame.
  // Runs again on resize or rotation.
  useLayoutEffect(() => {
    const place = () => {
      const stage = stageRef.current;
      const overlay = overlayRef.current;
      const frame = frameRef.current;
      if (!stage || !overlay) return;
      const { width, height } = stage.getBoundingClientRect();
      const view = frame ? coverView(width, height, frame.width, frame.height) : null;
      drawShape(overlay, shape, view, width, height);

      const ring = ringRef.current;
      const label = labelRef.current;
      if (!view || !reading || !ring || !label) return;
      const x = view.offsetX + reading.point.x * view.scale;
      const y = view.offsetY + reading.point.y * view.scale;
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;

      const margin = 16;
      const gap = 28;
      const { offsetWidth: w, offsetHeight: h } = label;
      const left = Math.max(margin, Math.min(x - w / 2, width - w - margin));
      const above = y - gap - h;
      const top = above >= margin ? above : Math.min(y + gap, height - h - margin);
      label.style.left = `${left}px`;
      label.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shape, reading]);

  function startModelLoad() {
    if (loadStartedRef.current) return;
    loadStartedRef.current = true;
    setModel({ kind: "loading", percent: 0 });
    loadSegmenter((fraction) => {
      const percent = Math.floor(fraction * 100);
      setModel((m) => (m.kind === "loading" && m.percent !== percent ? { kind: "loading", percent } : m));
    })
      .then((segmenter) => {
        segmenterRef.current = segmenter;
        setModel({ kind: "ready" });
      })
      .catch((err) => {
        console.error(err);
        setModel({ kind: "fallback", reason: "model unavailable" });
      });
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    setStatus("starting");
    try {
      // "environment" (rear camera) is a preference, so devices without one still work.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      stopStream(streamRef.current);
      streamRef.current = stream;
      setStatus("live");
      startModelLoad();
    } catch (err) {
      setStatus(statusForError(err));
    }
  }

  async function handleTap(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || workingRef.current) return;
    const video = videoRef.current;
    const frameCanvas = frameCanvasRef.current;
    if (!video || !frameCanvas) return;

    // First tap freezes the video on this frame, so the outline always lines up.
    // Later taps (until resume) select another object on the same frame.
    let frame = frameRef.current;
    if (!frame) {
      frame = captureFrame(video, frameCanvas);
      if (!frame) return;
      frameRef.current = frame;
      imageSetRef.current = false;
      setFrozen(true);
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const point = toFramePoint(rect, frame, event.clientX, event.clientY);
    if (!point) return;

    workingRef.current = true;
    setWorking(true);
    setNote(null);
    try {
      await nextPaint();

      let result: OutlineResult | null = null;
      const segmenter = segmenterRef.current;
      if (segmenter) {
        try {
          const { mask, prepareMs, tapMs } = segmentAt(segmenter, frameCanvas, point, !imageSetRef.current);
          imageSetRef.current = true;
          console.info(
            `Outline took ${Math.round(prepareMs + tapMs)} ms (prepare ${Math.round(prepareMs)}, tap ${Math.round(tapMs)})`,
          );
          result = outlineFromMask(mask, point, frame);
          if (!result) setNote("no clear object at that spot");
          // Judge speed by the per-tap step only, skip the very first tap (engine warm-up),
          // and give up only after two slow taps in a row.
          const isFirstTap = tapCountRef.current === 0;
          tapCountRef.current += 1;
          if (!isFirstTap && tapMs > SLOW_SEGMENT_MS) slowTapsRef.current += 1;
          else slowTapsRef.current = 0;
          if (slowTapsRef.current >= SLOW_TAPS_BEFORE_FALLBACK) {
            segmenterRef.current = null;
            setModel({ kind: "fallback", reason: "too slow on this device" });
          }
        } catch (err) {
          console.error(err);
          segmenterRef.current = null;
          setModel({ kind: "fallback", reason: "outline failed" });
        }
      }

      const outlineEstimate = result ? estimateColor(result.pixels) : null;
      if (result && outlineEstimate) {
        setShape({ kind: "outline", loops: result.loops });
        setReading({ point, estimate: outlineEstimate });
      } else {
        const view = coverView(rect.width, rect.height, frame.width, frame.height);
        setShape({ kind: "simple", center: point, radius: SIMPLE_SHAPE_RADIUS / view.scale });
        const estimate = sampleCircle(frameCanvas, point, sampleCanvasRef);
        setReading(estimate ? { point, estimate } : null);
      }
    } catch (err) {
      // Anything unexpected: say so in the chip and still show the simple shape for this tap.
      console.error(err);
      segmenterRef.current = null;
      setModel({ kind: "fallback", reason: "outline failed" });
      const view = coverView(rect.width, rect.height, frame.width, frame.height);
      setShape({ kind: "simple", center: point, radius: SIMPLE_SHAPE_RADIUS / view.scale });
    } finally {
      // Always release the tap, so the chip never sticks on "Outlining…" and later taps work.
      workingRef.current = false;
      setWorking(false);
    }
  }

  function resume() {
    frameRef.current = null;
    imageSetRef.current = false;
    const frameCanvas = frameCanvasRef.current;
    if (frameCanvas) {
      // Clears the frozen image from memory.
      frameCanvas.width = 0;
      frameCanvas.height = 0;
    }
    setShape(null);
    setReading(null);
    setNote(null);
    setFrozen(false);
  }

  const live = status === "live";
  const message = status in MESSAGES ? MESSAGES[status as keyof typeof MESSAGES] : null;
  const chip = chipText(model, working, note);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0E1624] text-lg text-white">
      <div
        ref={stageRef}
        className={`absolute inset-0 touch-manipulation ${live ? "" : "hidden"}`}
        onPointerUp={live ? handleTap : undefined}
      >
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
          autoPlay
          aria-label="Live camera. Tap anything to outline it and estimate its color."
        />
        {/* The frozen frame, drawn the same way as the video so taps and outline line up. */}
        <canvas
          ref={frameCanvasRef}
          aria-hidden
          className={`absolute inset-0 h-full w-full object-cover ${frozen ? "" : "hidden"}`}
        />
      </div>

      {live && (
        <>
          <canvas ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />

          {reading && (
            <>
              <div
                ref={ringRef}
                aria-hidden
                className="pointer-events-none fixed h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[#F5B841] shadow-[0_0_0_2px_rgba(14,22,36,0.85)]"
              />
              <div
                ref={labelRef}
                role="status"
                className="pointer-events-none fixed left-0 top-0 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-xl border border-[#F5B841] bg-[#0E1624]/95 px-4 py-3 font-semibold shadow-lg"
              >
                {/* Swatch shows sampled camera content; the text carries the full meaning. */}
                <span
                  aria-hidden
                  className="h-5 w-5 shrink-0 rounded-sm border border-white ring-1 ring-black"
                  style={{ backgroundColor: `rgb(${reading.estimate.rgb.r} ${reading.estimate.rgb.g} ${reading.estimate.rgb.b})` }}
                />
                <span>{reading.estimate.label}</span>
              </div>
            </>
          )}

          <Link
            href="/"
            className="absolute left-4 top-4 flex min-h-12 items-center rounded-xl bg-[#0E1624]/90 px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
          >
            ← Home
          </Link>

          {chip && (
            <p
              role="status"
              className="pointer-events-none absolute right-4 top-4 max-w-[calc(100vw-9rem)] rounded-xl border border-[#4DA3FF] bg-[#0E1624]/90 px-4 py-3 text-right"
            >
              {chip}
            </p>
          )}

          {frozen ? (
            <div className="absolute inset-x-4 bottom-6 flex flex-col items-center gap-3">
              <p className="pointer-events-none w-fit rounded-xl bg-[#0E1624]/90 px-4 py-2 text-center">
                Tap another spot to check it.
              </p>
              <button
                type="button"
                onClick={resume}
                className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
              >
                Tap to resume
              </button>
            </div>
          ) : (
            <p className="pointer-events-none absolute inset-x-4 bottom-6 mx-auto w-fit rounded-xl bg-[#0E1624]/90 px-4 py-3 text-center">
              Tap anything to outline it and estimate its color.
            </p>
          )}
        </>
      )}

      {!live && (
        <main className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
          <h1 className="text-3xl font-semibold">{message?.title ?? "Explore colors"}</h1>
          <p className="max-w-md leading-relaxed text-white/85">
            {status === "starting"
              ? "Waiting for camera permission… Look for the prompt near the address bar."
              : (message?.body ??
                "Point your camera at something and tap it to see its outline and an estimated color name. Nothing is saved or uploaded.")}
          </p>
          {status !== "starting" && (
            <button
              type="button"
              onClick={startCamera}
              className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              {status === "idle" ? "Start camera" : "Try again"}
            </button>
          )}
          <Link href="/" className="flex min-h-12 items-center text-[#4DA3FF] underline underline-offset-4">
            Back to home
          </Link>
        </main>
      )}
    </div>
  );
}
