"use client";

import { Button } from "@/components/ui/button";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="grid min-h-screen place-items-center p-5"><div className="max-w-md rounded-lg border bg-white p-8 text-center shadow-sm"><p className="text-sm font-black uppercase tracking-[.2em] text-red-700">Application error</p><h1 className="mt-3 text-3xl font-black">Something went wrong</h1><p className="my-4 text-[var(--muted)]">Retry the request. If it repeats, check the server logs and Sentry.</p><Button onClick={reset}>Try again</Button></div></main>;
}
