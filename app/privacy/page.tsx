import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy · Outlens",
};

// Plain-language privacy note. Keep it in step with the code: lib/crop.ts (what is sent to
// Gemini), app/api/describe (Gemini), app/api/speak (ElevenLabs), lib/profile.ts (on-device profile).
export default function PrivacyPage() {
  return (
    <div className="flex-1 bg-[#0E1624]">
    <main className="mx-auto w-full max-w-2xl px-6 py-10 text-lg leading-relaxed text-white">
      <h1 className="text-3xl font-semibold">Privacy</h1>
      <p className="mt-2 text-white/80">In plain words: what happens to your camera and your choices.</p>

      <h2 className="mt-8 text-2xl font-semibold">Your camera</h2>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        <li>The live camera video stays on your device. It is never recorded, saved or uploaded.</li>
        <li>
          When you tap, the app freezes that one frame in memory to draw the outline and estimate the color. This happens on
          your device. The frame is cleared when you tap “Tap to resume” or leave the page.
        </li>
      </ul>

      <h2 className="mt-8 text-2xl font-semibold">Pinch to select (prototype)</h2>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        <li>
          If you turn on Pinch, your hand is tracked on your device with Google’s MediaPipe. Camera images are not sent for this.
          MediaPipe does send usage and performance numbers (not images) to Google.
        </li>
      </ul>

      <h2 className="mt-8 text-2xl font-semibold">Naming the object (Google Gemini)</h2>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        <li>
          Only when you tap, a small picture of just the area around the object (at most 384 pixels wide) is sent to Google’s
          Gemini API to get its name and a short description. The full camera view is never sent.
        </li>
        <li>
          Outlens does not store these pictures. This demo uses Gemini’s free tier, where Google says it may use what is sent to
          improve its products. On Gemini’s paid tier, it does not.
        </li>
        <li>If Gemini is unavailable, the app still works and shows only the estimated color.</li>
      </ul>

      <h2 className="mt-8 text-2xl font-semibold">Listening (ElevenLabs)</h2>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        <li>
          When a label appears, its short sentence (for example “Mug. Estimated color: black.”) is sent to ElevenLabs to turn it
          into speech. No image is sent. If ElevenLabs is unavailable, your browser’s built-in voice reads it instead.
        </li>
      </ul>

      <h2 className="mt-8 text-2xl font-semibold">Your color-vision profile</h2>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        <li>The type you choose is saved only in this browser on this device. There are no accounts, and it is never sent anywhere.</li>
        <li>Outlens is not a medical device and does not diagnose color blindness. For a diagnosis, see an eye doctor.</li>
      </ul>

      <h2 className="mt-8 text-2xl font-semibold">Colors are estimates</h2>
      <p className="mt-2">
        Every color name is an estimate from the camera, and lighting can change it. “Show in my colors” and “Share what I see”
        are approximations: they help tell colors apart or show what others see, but they do not restore color vision.
      </p>

      <h2 className="mt-8 text-2xl font-semibold">Hosting</h2>
      <p className="mt-2">The site runs on Vercel, which keeps standard request logs (like time and address) to run the service.</p>

      <div className="mt-10 flex flex-wrap gap-4">
        <Link
          href="/explore"
          className="flex min-h-12 items-center rounded-xl bg-[#F5B841] px-6 font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
        >
          Open the camera
        </Link>
        <Link href="/" className="flex min-h-12 items-center text-[#4DA3FF] underline underline-offset-4">
          Back to home
        </Link>
      </div>
    </main>
    </div>
  );
}
