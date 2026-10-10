"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { estimateColor, pixelsInCircle, type ColorEstimate } from "@/lib/color";
import { circlePoints, elbowLine, outerLoop, placeCallout, type Box } from "@/lib/callout";
import { coverView, drawCalloutLine, drawShape, type Shape } from "@/lib/drawOutline";
import { outlineFromMask, type Frame, type OutlineResult, type Point } from "@/lib/outline";
// Outlines come from the "magic wand" (colorMaskAt). The MediaPipe segmenter in
// lib/segmenter.ts is switched off: in 1.0.1 its GPU mode returned empty masks and its
// CPU mode took about 12 s per tap on a laptop.
import { colorMaskAt } from "@/lib/colorRegion";
import { colorPhrase, prepareSpeech, speak } from "@/lib/speak";
import { cropAround, describeCrop, type ObjectInfo } from "@/lib/crop";
import { CVD_LABELS, SIMULATION, applyMatrix, enhancementMatrix, multiply, svgMatrixValues, type CvdType } from "@/lib/cvd";
import { DEFAULT_USERS_JSON, activeUser, addUser, parseUsers, saveUsers, subscribeUsers, usersSnapshot, type UsersState } from "@/lib/profile";

type Status = "idle" | "starting" | "live" | "denied" | "no-camera" | "busy" | "unsupported" | "error";

type Reading = {
  point: Point; // frame pixels
  estimate: ColorEstimate;
  identifying?: boolean; // waiting for Gemini to name the object
  object?: ObjectInfo | null; // Gemini's name and description, when it answered
  loadingMore?: boolean; // waiting for "More detail"
  more?: string | null; // the longer description, when asked for
};

// Sample circle radius as a share of the camera image's shorter side (fallback color sample).
const SAMPLE_RADIUS_FRACTION = 0.02;
// Radius of the fallback rounded shape, in screen pixels.
const SIMPLE_SHAPE_RADIUS = 56;

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

/** Waits until the browser has painted, so "Outlining…" shows before the outline work blocks the page. */
function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function chipText(working: boolean, note: string | null): string | null {
  if (working) return "Outlining…";
  if (note) return `Simple shape: ${note}`;
  return null;
}

const TYPE_HINTS: Record<CvdType, string> = {
  deutan: "Most common. Red, green, brown and orange can look alike.",
  protan: "Reds look darker; red and green are easy to mix up.",
  tritan: "Blue and green, or yellow and pink, can look alike.",
};

/** Who is using Outlens: pick a user, or add one (name + type). Saved only on this device. */
function UserPanel({ state, onChange, onClose }: { state: UsersState; onChange: (s: UsersState) => void; onClose?: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CvdType>("deutan");
  const btn =
    "min-h-12 rounded-xl border-2 px-4 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]";
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3 text-left">
      <h2 className="text-center text-2xl font-semibold">Who&apos;s looking?</h2>
      <p className="text-center text-white/80">Outlens shows the world through this person&apos;s eyes, then helps with the colors they mix up.</p>
      {state.users.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => {
            onChange({ ...state, activeId: u.id });
            onClose?.();
          }}
          aria-pressed={u.id === state.activeId}
          className={`${btn} ${u.id === state.activeId ? "border-[#F5B841] bg-white/10" : "border-white/25 bg-white/5 hover:bg-white/10"}`}
        >
          <span className="block font-semibold">
            <span aria-hidden>👤 </span>
            {u.name}
          </span>
          <span className="block text-white/80">{CVD_LABELS[u.type].long}</span>
        </button>
      ))}
      {adding ? (
        <form
          className="flex flex-col gap-3 rounded-xl border-2 border-white/25 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            onChange(addUser(state, name, type));
            setAdding(false);
            setName("");
            onClose?.();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-semibold">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              required
              className="min-h-12 rounded-lg bg-white px-3 text-[#0E1624]"
            />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-semibold">Color vision</legend>
            {(Object.keys(TYPE_HINTS) as CvdType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={`${btn} ${type === t ? "border-[#F5B841] bg-white/10" : "border-white/20"}`}
              >
                <span className="block font-semibold">{CVD_LABELS[t].long}</span>
                <span className="block text-base text-white/75">{TYPE_HINTS[t]}</span>
              </button>
            ))}
          </fieldset>
          <button type="submit" className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624]">
            Save user
          </button>
          <button type="button" onClick={() => setAdding(false)} className="min-h-12 text-[#4DA3FF] underline underline-offset-4">
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={`${btn} border-dashed border-white/40`}>
          + Add a user
        </button>
      )}
      <p className="text-center text-base text-white/70">Saved only on this device. Not a diagnosis; for that, see an eye doctor.</p>
      {onClose && (
        <button type="button" onClick={onClose} className="mx-auto min-h-12 px-4 text-[#4DA3FF] underline underline-offset-4">
          Close
        </button>
      )}
    </div>
  );
}

export default function CameraExplorer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const homeRef = useRef<HTMLDivElement>(null); // top-left tools: Home, user, view
  const chipRef = useRef<HTMLParagraphElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null); // frozen: hint and Resume button
  const hintRef = useRef<HTMLParagraphElement>(null); // live: hint only
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const workingRef = useRef(false);
  const tapIdRef = useRef(0); // so a late Gemini answer can't land on a newer selection
  const enhancedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastCropRef = useRef<string | null>(null); // this tap's crop, reused for "More detail"

  const [status, setStatus] = useState<Status>("idle");
  const [frozen, setFrozen] = useState(false);
  const [working, setWorking] = useState(false);
  const [shape, setShape] = useState<Shape | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Users live in this browser only (two demo users until someone changes them).
  const usersState = parseUsers(useSyncExternalStore(subscribeUsers, usersSnapshot, () => DEFAULT_USERS_JSON));
  const user = activeUser(usersState);
  const [usersOpen, setUsersOpen] = useState(false);
  // "user": the camera shows the world through the active user's eyes (a simulation).
  const [viewMode, setViewMode] = useState<"user" | "normal">("user");
  const simulate: CvdType | null = viewMode === "user" ? user.type : null;
  const [enhanced, setEnhanced] = useState(false); // selected object shown in the user's colors

  function changeUsers(next: UsersState) {
    saveUsers(next);
    setEnhanced(false);
  }

  /** Asks Gemini for a longer description of the same crop (only when the user taps it). */
  function moreDetail() {
    const image = lastCropRef.current;
    if (!image || !reading) return;
    const tapId = tapIdRef.current;
    setReading((r) => (r ? { ...r, loadingMore: true } : r));
    describeCrop(image, true).then((info) => {
      if (tapIdRef.current !== tapId) return;
      setReading((r) =>
        r ? { ...r, loadingMore: false, more: info?.description ?? "No more detail is available right now." } : r,
      );
    });
  }

  /**
   * Recolors the frozen frame for the user's type and shows it inside the outline. In the
   * user's view it is also passed through their simulation, so viewers see what it looks
   * like to them.
   */
  function toggleEnhanced() {
    if (enhanced) {
      setEnhanced(false);
      return;
    }
    const source = frameCanvasRef.current;
    if (!source || !source.width) return;
    const canvas = (enhancedCanvasRef.current ??= document.createElement("canvas"));
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const enhance = enhancementMatrix(user.type);
    applyMatrix(image.data, simulate ? multiply(SIMULATION[simulate], enhance) : enhance);
    ctx.putImageData(image, 0, 0);
    setEnhanced(true);
  }

  // Attach the stream once the video is visible (iPhone only autoplays visible video).
  useEffect(() => {
    const video = videoRef.current;
    if (status !== "live" || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    video.play().catch(() => {}); // autoplay normally starts it; this is a backup
  }, [status]);

  // When a label appears, get its spoken version ready so Listen can play it instantly.
  useEffect(() => {
    if (!reading) return;
    prepareSpeech(colorPhrase(reading.estimate.name)); // ready right away
    if (reading.object) prepareSpeech(colorPhrase(reading.estimate.name, reading.object.name));
  }, [reading]);

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
      drawShape(overlay, shape, view, width, height, enhanced ? enhancedCanvasRef.current : null);

      const ring = ringRef.current;
      const label = labelRef.current;
      if (!view || !reading || !shape || !ring || !label) return;

      // The object's outer edge on screen.
      const toScreen = (p: Point) => ({ x: view.offsetX + p.x * view.scale, y: view.offsetY + p.y * view.scale });
      const edge =
        shape.kind === "outline"
          ? outerLoop(shape.loops).map(toScreen)
          : circlePoints(toScreen(shape.center), shape.radius * view.scale);

      // Controls the label must not cover.
      const avoid: Box[] = [];
      for (const el of [homeRef.current, chipRef.current, bottomRef.current, hintRef.current]) {
        if (!el) continue;
        const r = el.getBoundingClientRect();
        avoid.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }

      const placement = placeCallout({
        edge,
        labelWidth: label.offsetWidth,
        labelHeight: label.offsetHeight,
        screenWidth: width,
        screenHeight: height,
        avoid,
      });
      if (!placement) return;
      label.style.left = `${placement.label.left}px`;
      label.style.top = `${placement.label.top}px`;
      // The dot marks where you tapped; the line bends into the side of the label.
      const dot = toScreen(reading.point);
      ring.style.left = `${dot.x}px`;
      ring.style.top = `${dot.y}px`;
      drawCalloutLine(overlay, elbowLine(dot, placement.label));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [shape, reading, note, working, enhanced, simulate]);

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
      try {
        const started = performance.now();
        const mask = colorMaskAt(frame, point);
        result = outlineFromMask(mask, point, frame, (why) => console.info(`No outline: ${why}`));
        console.info(`Outline took ${Math.round(performance.now() - started)} ms`);
        if (!result) setNote("no clear edge around that spot");
      } catch (err) {
        console.error(err);
        setNote("outline failed");
      }

      const outlineEstimate = result ? estimateColor(result.pixels) : null;
      let estimate: ColorEstimate | null;
      let around: Point[]; // the selected area, for the crop sent to Gemini
      if (result && outlineEstimate) {
        setShape({ kind: "outline", loops: result.loops });
        estimate = outlineEstimate;
        around = outerLoop(result.loops);
      } else {
        const view = coverView(rect.width, rect.height, frame.width, frame.height);
        const radius = SIMPLE_SHAPE_RADIUS / view.scale;
        setShape({ kind: "simple", center: point, radius });
        estimate = sampleCircle(frameCanvas, point, sampleCanvasRef);
        around = circlePoints(point, radius);
      }

      setEnhanced(false);
      // Name the object with Gemini: only a small crop around the selection, only now.
      const tapId = ++tapIdRef.current;
      const image = estimate ? cropAround(frameCanvas, around) : null;
      lastCropRef.current = image;
      setReading(estimate ? { point, estimate, identifying: !!image } : null);
      if (image) {
        describeCrop(image).then((object) => {
          if (tapIdRef.current !== tapId) return; // a newer tap or close happened meanwhile
          setReading((r) => (r ? { ...r, identifying: false, object } : r));
        });
      }
    } catch (err) {
      // Anything unexpected: say so in the chip and still show the simple shape for this tap.
      console.error(err);
      setNote("outline failed");
      const view = coverView(rect.width, rect.height, frame.width, frame.height);
      setShape({ kind: "simple", center: point, radius: SIMPLE_SHAPE_RADIUS / view.scale });
    } finally {
      // Always release the tap, so the chip never sticks on "Outlining…" and later taps work.
      workingRef.current = false;
      setWorking(false);
    }
  }

  /** Close button: removes the outline and label; the picture stays frozen for another tap. */
  function clearSelection() {
    tapIdRef.current++;
    setEnhanced(false);
    setShape(null);
    setReading(null);
    setNote(null);
  }

  function resume() {
    tapIdRef.current++;
    setEnhanced(false);
    frameRef.current = null;
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
  const chip = chipText(working, note);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0E1624] text-lg text-white">
      {/* "See as" simulations, applied to the camera view only (not to labels or buttons). */}
      <svg aria-hidden width="0" height="0" className="absolute">
        <defs>
          {(Object.keys(SIMULATION) as CvdType[]).map((t) => (
            <filter key={t} id={`cvd-sim-${t}`} colorInterpolationFilters="linearRGB">
              <feColorMatrix type="matrix" values={svgMatrixValues(SIMULATION[t])} />
            </filter>
          ))}
        </defs>
      </svg>
      <div
        ref={stageRef}
        className={`absolute inset-0 touch-manipulation ${live ? "" : "hidden"}`}
        style={simulate ? { filter: `url(#cvd-sim-${simulate})` } : undefined}
        onPointerUp={live ? handleTap : undefined}
      >
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          playsInline
          muted
          autoPlay
          aria-label="Live camera. Tap a solid object to outline it and estimate its color."
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
                className="pointer-events-none fixed h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgba(14,22,36,0.7),inset_0_0_0_1.5px_rgba(14,22,36,0.5)]"
              />
              <div
                ref={labelRef}
                className="fixed left-0 top-0 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-[28px] border-2 border-[#4DA3FF] bg-white py-0.5 pl-3 pr-0.5 text-[#0E1624] shadow-[0_4px_16px_rgba(14,22,36,0.35)]"
              >
                {/* Swatch shows sampled camera content; the text carries the full meaning. */}
                <span
                  aria-hidden
                  className="h-7 w-7 shrink-0 rounded-full ring-1 ring-[#0E1624]/30"
                  style={{ backgroundColor: `rgb(${reading.estimate.rgb.r} ${reading.estimate.rgb.g} ${reading.estimate.rgb.b})` }}
                />
                <span role="status" className="flex min-w-0 flex-col py-1.5 leading-snug">
                  {reading.object && <span className="font-semibold capitalize">{reading.object.name}</span>}
                  <span className="font-medium">{reading.estimate.label}</span>
                  {reading.identifying && <span className="text-[#0E1624]/60">Identifying…</span>}
                  {reading.object?.description && (
                    <span className="text-[#0E1624]/70">{reading.object.description}</span>
                  )}
                  {reading.more && <span className="mt-1 max-w-[18rem] text-[#0E1624]/80">{reading.more}</span>}
                  {reading.loadingMore && <span className="text-[#0E1624]/60">Getting more detail…</span>}
                  {reading.object && !reading.more && !reading.loadingMore && (
                    <button
                      type="button"
                      onClick={moreDetail}
                      className="-ml-1 min-h-12 self-start rounded-full px-1 text-left font-semibold text-[#1F6FD1] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                    >
                      More detail
                    </button>
                  )}
                  {!reading.identifying && (
                    <button
                      type="button"
                      onClick={toggleEnhanced}
                      aria-pressed={enhanced}
                      className="-ml-1 mt-1 min-h-12 self-start rounded-full px-1 text-left font-semibold text-[#1F6FD1] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                    >
                      {enhanced ? "Show original colors" : `Show in ${user.name}'s colors`}
                      {enhanced && <span className="block text-base font-normal text-[#0E1624]/60">Enhanced (approximate)</span>}
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    speak([colorPhrase(reading.estimate.name, reading.object?.name), colorPhrase(reading.estimate.name)])
                  }
                  aria-label="Listen"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[#0E1624]/75 hover:bg-[#0E1624]/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                >
                  <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
                    <path d="M16.5 8.5a5 5 0 0 1 0 7" />
                    <path d="M19 6a8.5 8.5 0 0 1 0 12" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  aria-label="Close label"
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-[#0E1624]/55 hover:bg-[#0E1624]/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                >
                  <span aria-hidden>✕</span>
                </button>
              </div>
            </>
          )}

          <div ref={homeRef} className="absolute left-4 top-4 flex max-w-[13rem] flex-col items-start gap-2">
            <Link
              href="/"
              className="flex min-h-12 items-center rounded-xl bg-[#0E1624]/90 px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              ← Home
            </Link>
            <p className="rounded-xl bg-[#0E1624]/80 px-3 py-1 text-base text-white/85">Glasses view · phone preview</p>
            <button
              type="button"
              onClick={() => setUsersOpen(true)}
              className="min-h-12 rounded-xl border-2 border-[#F5B841] bg-[#0E1624]/95 px-4 text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              <span aria-hidden>👤 </span>
              {user.name} ▾<span className="block text-base font-normal text-white/80">{CVD_LABELS[user.type].short}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode((m) => (m === "user" ? "normal" : "user"));
                setEnhanced(false);
              }}
              aria-pressed={viewMode === "user"}
              className="min-h-12 rounded-xl bg-[#0E1624]/90 px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              <span aria-hidden>👁 </span>
              {viewMode === "user" ? `${user.name}'s eyes` : "Normal view"}
              <span className="block text-base text-[#F5B841]">{viewMode === "user" ? "Simulation · tap for normal" : `Tap for ${user.name}'s eyes`}</span>
            </button>
          </div>

          {usersOpen && (
            <div className="absolute inset-0 z-20 overflow-y-auto bg-[#0E1624]/97 px-4 py-8">
              <UserPanel state={usersState} onChange={changeUsers} onClose={() => setUsersOpen(false)} />
            </div>
          )}

          {chip && (
            <p
              ref={chipRef}
              role="status"
              className="pointer-events-none absolute right-4 top-4 max-w-[calc(100vw-15rem)] rounded-xl border border-[#4DA3FF] bg-[#0E1624]/90 px-4 py-3 text-right"
            >
              {chip}
            </p>
          )}

          {frozen ? (
            <div ref={bottomRef} className="absolute inset-x-4 bottom-6 flex flex-col items-center gap-3">
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
            <p
              ref={hintRef}
              className="pointer-events-none absolute inset-x-4 bottom-6 mx-auto w-fit rounded-xl bg-[#0E1624]/90 px-4 py-3 text-center">
              Tap a solid object. Works best on single-color things, not glass, water, or thin parts.
            </p>
          )}
        </>
      )}

      {!live && usersOpen && (
        <main className="flex h-full flex-col items-center overflow-y-auto px-4 py-8">
          <UserPanel state={usersState} onChange={changeUsers} onClose={() => setUsersOpen(false)} />
        </main>
      )}

      {!live && !usersOpen && (
        <main className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
          <h1 className="text-3xl font-semibold">{message?.title ?? "Explore colors"}</h1>
          <p className="max-w-md leading-relaxed text-white/85">
            {status === "starting"
              ? "Waiting for camera permission… Look for the prompt near the address bar."
              : (message?.body ??
                "Point your camera at something and tap it to see its outline, an estimated color, and its name. Nothing is saved. Only a small crop of what you tap is sent, to name it.")}
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
          {status !== "starting" && (
            <button
              type="button"
              onClick={() => setUsersOpen(true)}
              className="min-h-12 rounded-xl border-2 border-white/30 px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              <span aria-hidden>👤 </span>Looking as <strong>{user.name}</strong> · {CVD_LABELS[user.type].short} (change)
            </button>
          )}
          <Link href="/privacy" className="flex min-h-12 items-center text-[#4DA3FF] underline underline-offset-4">
            Privacy: what happens to your camera
          </Link>
          <Link href="/" className="flex min-h-12 items-center text-[#4DA3FF] underline underline-offset-4">
            Back to home
          </Link>
        </main>
      )}
    </div>
  );
}
