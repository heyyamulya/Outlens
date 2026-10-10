"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { estimateColor, pixelsInCircle, type ColorEstimate } from "@/lib/color";

type Status = "idle" | "starting" | "live" | "denied" | "no-camera" | "busy" | "unsupported" | "error";

type Reading = { x: number; y: number; estimate: ColorEstimate };

// Sample circle radius as a share of the camera image's shorter side.
const SAMPLE_RADIUS_FRACTION = 0.02;

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

// The video fills the screen with object-fit: cover, so it is scaled up and cropped.
// Convert a screen point to the matching pixel in the camera image.
function toVideoPoint(video: HTMLVideoElement, clientX: number, clientY: number) {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw || !vh) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const x = (clientX - rect.left - (rect.width - vw * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - vh * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= vw || y >= vh) return null;
  return { x, y };
}

function sampleAt(
  video: HTMLVideoElement,
  x: number,
  y: number,
  canvasRef: { current: HTMLCanvasElement | null },
): ColorEstimate | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  const radius = Math.max(4, Math.round(Math.min(vw, vh) * SAMPLE_RADIUS_FRACTION));
  const left = Math.max(0, Math.floor(x - radius));
  const top = Math.max(0, Math.floor(y - radius));
  const width = Math.min(vw, Math.ceil(x + radius)) - left;
  const height = Math.min(vh, Math.ceil(y + radius)) - top;
  if (width <= 0 || height <= 0) return null;

  // Only this small crop is drawn, in memory. It is overwritten on the next tap and never saved or sent.
  const canvas = (canvasRef.current ??= document.createElement("canvas"));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, left, top, width, height, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  return estimateColor(pixelsInCircle(data, width, height, x - left, y - top, radius));
}

export default function CameraExplorer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [reading, setReading] = useState<Reading | null>(null);

  // Attach the stream once the video is visible (iPhone only autoplays visible video).
  useEffect(() => {
    const video = videoRef.current;
    if (status !== "live" || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    video.play().catch(() => {}); // autoplay normally starts it; this is a backup
  }, [status]);

  // Turn the camera off when leaving the page.
  useEffect(() => () => stopStream(streamRef.current), []);

  // Place the label near the tap, kept fully on screen.
  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!reading || !label) return;
    const margin = 16;
    const gap = 28;
    const { offsetWidth: w, offsetHeight: h } = label;
    const left = Math.max(margin, Math.min(reading.x - w / 2, window.innerWidth - w - margin));
    const above = reading.y - gap - h;
    const top = above >= margin ? above : Math.min(reading.y + gap, window.innerHeight - h - margin);
    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
  }, [reading]);

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    setStatus("starting");
    setReading(null);
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

  function handleTap(event: PointerEvent<HTMLVideoElement>) {
    if (!event.isPrimary) return;
    const video = event.currentTarget;
    const point = toVideoPoint(video, event.clientX, event.clientY);
    if (!point) return;
    const estimate = sampleAt(video, point.x, point.y, canvasRef);
    if (estimate) setReading({ x: event.clientX, y: event.clientY, estimate });
  }

  const live = status === "live";
  const message = status in MESSAGES ? MESSAGES[status as keyof typeof MESSAGES] : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#0E1624] text-lg text-white">
      <video
        ref={videoRef}
        className={`h-full w-full touch-manipulation object-cover ${live ? "" : "hidden"}`}
        playsInline
        muted
        autoPlay
        onPointerUp={live ? handleTap : undefined}
        aria-label="Live camera. Tap anything to estimate its color."
      />

      {live && (
        <>
          <Link
            href="/"
            className="absolute left-4 top-4 flex min-h-12 items-center rounded-xl bg-[#0E1624]/90 px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
          >
            ← Home
          </Link>

          {reading ? (
            <>
              <div
                aria-hidden
                className="pointer-events-none fixed h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[#F5B841] shadow-[0_0_0_2px_rgba(14,22,36,0.85)]"
                style={{ left: reading.x, top: reading.y }}
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
          ) : (
            <p className="pointer-events-none absolute inset-x-4 bottom-6 mx-auto w-fit rounded-xl bg-[#0E1624]/90 px-4 py-3 text-center">
              Tap anything to estimate its color.
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
                "Point your camera at something and tap it to see an estimated color name. Nothing is saved or uploaded.")}
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
