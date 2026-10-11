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
import { createSimRenderer } from "@/lib/simGl";
import { loadHands, readHand } from "@/lib/pinch";
import { TRAFFIC_REPLY, parseCommand } from "@/lib/voiceCommand";
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
function captureFrame(video: HTMLVideoElement | HTMLCanvasElement, canvas: HTMLCanvasElement): Frame | null {
  const width = video instanceof HTMLVideoElement ? video.videoWidth : video.width;
  const height = video instanceof HTMLVideoElement ? video.videoHeight : video.height;
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

// The browser's speech recognition (Web Speech API); only the parts we use.
type Recognizer = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

// Compact action button in the label (still a 48px tap target).
const ACTION =
  "min-h-12 rounded-full bg-[#0E1624]/[0.07] px-3 font-semibold text-[#0E1624] hover:bg-[#0E1624]/[0.12] aria-pressed:bg-[#4DA3FF]/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]";

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
  const simCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null); // pinch cursor
  const cleanCanvasRef = useRef<HTMLCanvasElement | null>(null); // recent frame without a hand in it
  // The latest selectAt, so the pinch loop (set up once) always calls the current version.
  const selectAtRef = useRef<((x: number, y: number, source?: HTMLCanvasElement | null) => void) | null>(null);

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
  const [signedIn, setSignedIn] = useState(false); // demo sign-in: nothing is stored or sent
  const [email, setEmail] = useState("maya@outlens.demo");
  const [controlsHidden, setControlsHidden] = useState(false); // presenting: show only the view
  const [pinchOn, setPinchOn] = useState(false); // pinch to select (prototype), off by default
  const [pinchStatus, setPinchStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [listening, setListening] = useState(false); // "Ask" is listening for a command
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const recognizerRef = useRef<Recognizer | null>(null);
  const voiceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runCommandRef = useRef<((text: string) => void) | null>(null);
  const micRef = useRef<HTMLButtonElement>(null);
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

  // The user's-eyes view: redraw the camera through their simulation on the graphics chip.
  // Falls back to a CSS filter (laptops) if WebGL is not available.
  useEffect(() => {
    const canvas = simCanvasRef.current;
    const stage = stageRef.current;
    if (status !== "live" || !simulate || !canvas || !stage) return;
    const renderer = createSimRenderer(canvas);
    if (!renderer) {
      canvas.style.display = "none";
      stage.style.filter = `url(#cvd-sim-${simulate})`;
      return () => {
        canvas.style.display = "";
        stage.style.filter = "";
      };
    }
    const matrix = SIMULATION[simulate];
    let raf = 0;
    const loop = () => {
      const source = frameRef.current ? frameCanvasRef.current : videoRef.current;
      if (source) renderer.draw(source, matrix);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      renderer.dispose();
    };
  }, [status, simulate]);

  // Pinch to select (prototype): follow the hand, and treat a pinch like a tap at that spot.
  // While no hand is visible, keep a recent clean frame, so a pinch while live freezes the
  // scene without the hand in it.
  useEffect(() => {
    const cursor = cursorRef.current;
    if (!pinchOn || status !== "live" || !cursor) return;
    let cancelled = false;
    let raf = 0;
    let lastTime = -1;
    let lastClean = 0;
    let wasPinched = false;
    let pinchFrames = 0; // a pinch must hold for a few frames, so a passing hand doesn't select
    let fired = false;
    loadHands()
      .then((hands) => {
        if (cancelled) return;
        setPinchStatus("ready");
        const step = () => {
          const video = videoRef.current;
          const stage = stageRef.current;
          // While the picture is paused, the cursor stays where it is (no tracking).
          if (!frameRef.current && video && stage && video.readyState >= 2 && video.currentTime !== lastTime) {
            lastTime = video.currentTime;
            const hand = readHand(hands, video, wasPinched);
            const now = performance.now();
            // Only point while the fingers are coming together; an open hand points at nothing.
            if (!hand.point || hand.closeness < 0.4) {
              cursor.style.display = "none";
              if (!frameRef.current && now - lastClean > 300 && video.videoWidth) {
                const clean = (cleanCanvasRef.current ??= document.createElement("canvas"));
                clean.width = video.videoWidth;
                clean.height = video.videoHeight;
                clean.getContext("2d")?.drawImage(video, 0, 0);
                lastClean = now;
              }
            } else {
              const rect = stage.getBoundingClientRect();
              const view = coverView(rect.width, rect.height, video.videoWidth, video.videoHeight);
              const x = rect.left + view.offsetX + hand.point.x * video.videoWidth * view.scale;
              const y = rect.top + view.offsetY + hand.point.y * video.videoHeight * view.scale;
              cursor.style.display = "block";
              cursor.style.left = `${x}px`;
              cursor.style.top = `${y}px`;
              cursor.style.backgroundColor = `rgba(245, 184, 65, ${0.15 + hand.closeness * 0.6})`;
              pinchFrames = hand.pinched ? pinchFrames + 1 : 0;
              if (pinchFrames >= 3 && !fired) {
                fired = true;
                selectAtRef.current?.(x, y, frameRef.current ? null : cleanCanvasRef.current);
              }
            }
            if (!hand.pinched) {
              pinchFrames = 0;
              fired = false;
            }
            wasPinched = hand.pinched;
          }
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      })
      .catch((err) => {
        console.error("Hand tracking failed to load:", err);
        if (!cancelled) setPinchStatus("failed");
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cursor.style.display = "none";
    };
  }, [pinchOn, status]);

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
      for (const el of [homeRef.current, chipRef.current, bottomRef.current, hintRef.current, micRef.current]) {
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

  function handleTap(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    selectAt(event.clientX, event.clientY);
  }

  /**
   * Selects the object at a screen point (from a tap or a pinch). `source` is the picture to
   * freeze if not frozen yet (pinch passes a frame from just before the hand appeared).
   */
  async function selectAt(clientX: number, clientY: number, source?: HTMLCanvasElement | null) {
    if (workingRef.current) return;
    const video = videoRef.current;
    const frameCanvas = frameCanvasRef.current;
    const stage = stageRef.current;
    if (!video || !frameCanvas || !stage) return;

    // First tap freezes the video on this frame, so the outline always lines up.
    // Later taps (until resume) select another object on the same frame.
    let frame = frameRef.current;
    if (!frame) {
      frame = captureFrame(source && source.width ? source : video, frameCanvas);
      if (!frame) return;
      frameRef.current = frame;
      setFrozen(true);
    }
    const rect = stage.getBoundingClientRect();
    const point = toFramePoint(rect, frame, clientX, clientY);
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

  // Keep the pinch loop pointed at the latest selectAt.
  useEffect(() => {
    selectAtRef.current = selectAt;
  });


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

  /** Shows a short message in the chip for a few seconds. */
  function flash(message: string, ms = 3500) {
    setVoiceMsg(message);
    if (voiceTimerRef.current) clearTimeout(voiceTimerRef.current);
    voiceTimerRef.current = setTimeout(() => setVoiceMsg(null), ms);
  }

  /** Hands-free: estimate the color at the center of the view (where you're looking) and say it. */
  function describeCenter() {
    const video = videoRef.current;
    const source = frameRef.current ? frameCanvasRef.current : video;
    if (!source || !video?.videoWidth) {
      flash("The camera isn't ready yet.");
      return;
    }
    let canvas = source as HTMLCanvasElement;
    if (source instanceof HTMLVideoElement) {
      canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
    }
    const estimate = sampleCircle(canvas, { x: canvas.width / 2, y: canvas.height / 2 }, sampleCanvasRef);
    if (!estimate) {
      flash("Couldn't read a color there.");
      return;
    }
    flash(`Center of view · ${estimate.label}`, 6000);
    speak([colorPhrase(estimate.name)]);
  }

  /** Carries out a spoken command (see lib/voiceCommand.ts). */
  function runCommand(text: string) {
    const command = parseCommand(text, user.name);
    if (!command) {
      flash(`Heard “${text}”. Try “What is this?”, “Boost”, or “Actual vision”.`, 5000);
      return;
    }
    flash(`Heard “${text}”`);
    if (command === "traffic") {
      flash("Traffic lights: use position (top is stop, bottom is go) and walk signals.", 7000);
      speak([TRAFFIC_REPLY]);
      return;
    }
    if (command === "describe" && !reading) {
      describeCenter();
      return;
    }
    const needsObject = ["boost", "unboost", "more", "close"].includes(command);
    if (needsObject && !reading) {
      flash("Tap or pinch an object first.");
      return;
    }
    if (command === "describe" && reading)
      speak([colorPhrase(reading.estimate.name, reading.object?.name), colorPhrase(reading.estimate.name)]);
    if (command === "boost" && !enhanced && !reading?.identifying) toggleEnhanced();
    if (command === "unboost" && enhanced) toggleEnhanced();
    if (command === "actual") {
      setViewMode("normal");
      setEnhanced(false);
    }
    if (command === "user") {
      setViewMode("user");
      setEnhanced(false);
    }
    if (command === "more" && reading?.object && !reading.more) moreDetail();
    if (command === "resume") resume();
    if (command === "close") clearSelection();
  }

  useEffect(() => {
    runCommandRef.current = runCommand;
  });

  /** "Ask": listen for one short spoken command. */
  function ask() {
    if (listening) {
      recognizerRef.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      flash("Voice commands aren’t available in this browser. Tap still works.", 5000);
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? "";
      if (text) runCommandRef.current?.(text);
    };
    rec.onerror = (e) =>
      flash(e.error === "not-allowed" ? "Microphone permission is off for this site." : "Didn’t catch that. Tap 🎤 and try again.");
    rec.onend = () => setListening(false);
    recognizerRef.current = rec;
    setListening(true);
    setVoiceMsg("Listening… try “What color is this?”");
    try {
      rec.start();
    } catch {
      setListening(false);
      flash("Couldn’t start the microphone. Tap 🎤 again.");
    }
  }

  const live = status === "live";
  const message = status in MESSAGES ? MESSAGES[status as keyof typeof MESSAGES] : null;
  const chip =
    voiceMsg ??
    chipText(working, note) ??
    (pinchOn
      ? pinchStatus === "loading"
        ? "Loading hand tracking…"
        : pinchStatus === "failed"
          ? "Pinch unavailable here. Tap still works."
          : "✋ Pinch to select (prototype)"
      : null);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0E1624] text-lg text-white">
      {/* Fallback for the user's-eyes view when WebGL is unavailable (works on laptops, not iPhone video). */}
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
        {/* The user's-eyes view: the camera (or frozen frame) redrawn through their simulation. */}
        <canvas
          ref={simCanvasRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${simulate ? "" : "hidden"}`}
        />
      </div>

      {live && (
        <>
          <canvas ref={overlayRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
          <div
            ref={cursorRef}
            aria-hidden
            style={{ display: "none" }}
            className="pointer-events-none fixed z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#F5B841] shadow-[0_0_0_2px_rgba(14,22,36,0.7)]"
          />
          {listening && (
            <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2">
              <span className="absolute left-1/2 top-0 h-8 w-[3px] -translate-x-1/2 rounded bg-white shadow-[0_0_0_1.5px_rgba(14,22,36,0.7)]" />
              <span className="absolute left-0 top-1/2 h-[3px] w-8 -translate-y-1/2 rounded bg-white shadow-[0_0_0_1.5px_rgba(14,22,36,0.7)]" />
            </div>
          )}
          {/* Ask: tap, then say a short command. */}
          <button
            ref={micRef}
            type="button"
            onClick={ask}
            aria-pressed={listening}
            aria-label={listening ? "Stop listening" : "Ask with your voice"}
            className={`absolute right-4 top-1/2 z-10 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-full text-2xl shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF] ${
              listening ? "bg-[#F5B841] text-[#0E1624] ring-4 ring-[#F5B841]/40" : "bg-[#0E1624]/85 text-white"
            }`}
          >
            <span aria-hidden>🎤</span>
          </button>

          {reading && (
            <>
              <div
                ref={ringRef}
                aria-hidden
                className="pointer-events-none fixed h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1.5px_rgba(14,22,36,0.7),inset_0_0_0_1.5px_rgba(14,22,36,0.5)]"
              />
              <div
                ref={labelRef}
                className="fixed left-0 top-0 w-[min(19rem,calc(100vw-32px))] rounded-2xl border border-[#4DA3FF]/80 bg-white/75 p-2 pl-3 text-[#0E1624] shadow-[0_4px_16px_rgba(14,22,36,0.25)] backdrop-blur-md"
              >
                <div className="flex items-start gap-2">
                  {/* Swatch shows sampled camera content; the text carries the full meaning. */}
                  <span
                    aria-hidden
                    className="mt-1.5 h-6 w-6 shrink-0 rounded-full ring-1 ring-[#0E1624]/30"
                    style={{ backgroundColor: `rgb(${reading.estimate.rgb.r} ${reading.estimate.rgb.g} ${reading.estimate.rgb.b})` }}
                  />
                  <div role="status" className="min-w-0 flex-1 py-1 leading-snug">
                    {reading.object && <div className="font-semibold capitalize">{reading.object.name}</div>}
                    <div className="font-medium">{reading.estimate.label}</div>
                    {reading.identifying && <div className="text-[#0E1624]/60">Identifying…</div>}
                    {reading.object?.description && <div className="text-[#0E1624]/75">{reading.object.description}</div>}
                    {reading.more && <div className="mt-1 text-[#0E1624]/85">{reading.more}</div>}
                    {reading.loadingMore && <div className="text-[#0E1624]/60">Getting more detail…</div>}
                    {enhanced && <div className="text-[#0E1624]/60">Boosted for {user.name} (approximate)</div>}
                  </div>
                  <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Close label"
                    className="-mr-1 -mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl leading-none text-[#0E1624]/55 hover:bg-[#0E1624]/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                  >
                    <span aria-hidden>✕</span>
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      speak([colorPhrase(reading.estimate.name, reading.object?.name), colorPhrase(reading.estimate.name)])
                    }
                    className={ACTION}
                  >
                    <span aria-hidden>🔊 </span>Listen
                  </button>
                  {!reading.identifying && (
                    <button type="button" onClick={toggleEnhanced} aria-pressed={enhanced} className={ACTION}>
                      <span aria-hidden>✨ </span>
                      {enhanced ? "Unboost" : "Boost"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setViewMode((m) => (m === "user" ? "normal" : "user"));
                      setEnhanced(false);
                    }}
                    aria-label={viewMode === "user" ? "See in actual vision" : `See in ${user.name}'s vision`}
                    className={ACTION}
                  >
                    <span aria-hidden>👁 </span>
                    {viewMode === "user" ? "Actual" : `${user.name}'s`}
                  </button>
                  {reading.object && !reading.more && !reading.loadingMore && (
                    <button type="button" onClick={moreDetail} className={ACTION}>
                      More
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {controlsHidden && (
            <button
              type="button"
              onClick={() => setControlsHidden(false)}
              aria-label="Show controls"
              className="absolute left-3 top-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#0E1624]/60 text-2xl opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              <span aria-hidden>☰</span>
            </button>
          )}

          {!controlsHidden && (
          <div ref={homeRef} className="absolute left-4 top-4 flex max-w-[13rem] flex-col items-start gap-2">
            <button
              type="button"
              onClick={() => setControlsHidden(true)}
              className="min-h-12 rounded-xl bg-[#0E1624]/90 px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              <span aria-hidden>◀ </span>Hide controls
            </button>
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
              {viewMode === "user" ? "Switch to actual vision" : `Switch to ${user.name}'s vision`}
              <span className="block text-base text-[#F5B841]">
                {viewMode === "user" ? `Now: ${user.name}'s vision (simulation)` : "Now: actual vision"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPinchOn((on) => !on);
                setPinchStatus("loading");
              }}
              aria-pressed={pinchOn}
              className={`min-h-12 rounded-xl px-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF] ${
                pinchOn ? "border-2 border-[#F5B841] bg-[#0E1624]/95" : "bg-[#0E1624]/90"
              }`}
            >
              <span aria-hidden>✋ </span>Pinch: {pinchOn ? "On" : "Off"}
              <span className="block text-base text-white/70">Prototype · tap always works</span>
            </button>
          </div>
          )}

          {usersOpen && (
            <div className="absolute inset-0 z-20 overflow-y-auto bg-[#0E1624]/97 px-4 py-8">
              <UserPanel state={usersState} onChange={changeUsers} onClose={() => setUsersOpen(false)} />
            </div>
          )}

          {chip && !controlsHidden && (
            <p
              ref={chipRef}
              role="status"
              className="pointer-events-none absolute right-4 top-4 max-w-[calc(100vw-15rem)] rounded-xl border border-[#4DA3FF] bg-[#0E1624]/90 px-4 py-3 text-right"
            >
              {chip}
            </p>
          )}

          {controlsHidden ? (
            frozen && (
              <div ref={bottomRef} className="absolute inset-x-4 bottom-6 flex justify-center">
                <button
                  type="button"
                  onClick={resume}
                  className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
                >
                  Tap to resume
                </button>
              </div>
            )
          ) : frozen ? (
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

      {!live && !signedIn && (
        <main className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-8">
          <form
            className="flex w-full max-w-sm flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const match = usersState.users.find((u) => email.toLowerCase().startsWith(u.name.toLowerCase()));
              if (match) changeUsers({ ...usersState, activeId: match.id });
              setSignedIn(true);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-192.png" alt="" width={72} height={72} className="mx-auto rounded-2xl" />
            <h1 className="text-center text-3xl font-semibold">Outlens</h1>
            <p className="text-center text-white/80">Sign in to your lens</p>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
                className="min-h-12 rounded-lg bg-white px-3 text-[#0E1624]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold">Password</span>
              <input type="password" defaultValue="demo-password" autoComplete="off" className="min-h-12 rounded-lg bg-white px-3 text-[#0E1624]" />
            </label>
            <button type="submit" className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624]">
              Sign in
            </button>
            <div className="flex flex-wrap justify-center gap-x-4">
              {usersState.users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setEmail(`${u.name.toLowerCase()}@outlens.demo`)}
                  className="min-h-12 text-[#4DA3FF] underline underline-offset-4"
                >
                  Demo: {u.name}
                </button>
              ))}
            </div>
            <p className="text-center text-base text-white/70">
              Demo sign-in: no account is created, and nothing you type is stored or sent.
            </p>
          </form>
        </main>
      )}

      {!live && signedIn && usersOpen && (
        <main className="flex h-full flex-col items-center overflow-y-auto px-4 py-8">
          <UserPanel state={usersState} onChange={changeUsers} onClose={() => setUsersOpen(false)} />
        </main>
      )}

      {!live && signedIn && !usersOpen && (
        <main className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
          {!message && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/icon-192.png" alt="" width={96} height={96} className="rounded-3xl shadow-[0_0_40px_rgba(77,163,255,0.45)]" />
          )}
          <h1 className="text-3xl font-semibold">{message?.title ?? "Put on your lens"}</h1>
          <p className="max-w-md leading-relaxed text-white/85">
            {status === "starting"
              ? "Waiting for camera permission… Look for the prompt near the address bar."
              : (message?.body ??
                "On glasses, this is what you'd see. Here, your phone's camera stands in: look at something, tap it, and Outlens outlines it, names it, tells you its color, then shows it in colors you can tell apart.")}
          </p>
          {status !== "starting" && (
            <button
              type="button"
              onClick={startCamera}
              className="min-h-12 rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
            >
              {status === "idle" ? "Open the lens" : "Try again"}
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
