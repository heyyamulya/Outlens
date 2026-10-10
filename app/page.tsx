import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Outlens</h1>
      <p className="text-lg text-zinc-600 dark:text-zinc-400">Coming soon.</p>
      <Link
        href="/explore"
        className="mt-3 flex min-h-12 items-center rounded-xl bg-[#F5B841] px-6 text-lg font-semibold text-[#0E1624] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4DA3FF]"
      >
        Open camera
      </Link>
    </main>
  );
}
