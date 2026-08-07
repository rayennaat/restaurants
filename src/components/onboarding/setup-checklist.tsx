"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight, Check, PackagePlus, Store, Truck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { completeSetup } from "@/server/actions/organization";
import type { SetupProgress, SetupStepKey } from "@/server/queries/onboarding";

const STEP_ICONS: Record<SetupStepKey, typeof Store> = {
  ingredient: Store,
  supplier: Truck,
  purchase: PackagePlus,
};

/**
 * The guided setup. Progress is derived from real row counts, so completing a
 * step anywhere in the app ticks it off here, and the owner can leave and come
 * back without losing their place.
 */
export function SetupChecklist({ progress }: { progress: SetupProgress }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [skipping, setSkipping] = useState(false);

  function finish() {
    setSkipping(true);
    startTransition(async () => {
      const result = await completeSetup();
      if (result.ok) {
        router.push("/dashboard");
        router.refresh();
      } else {
        toast.error(result.error);
        setSkipping(false);
      }
    });
  }

  return (
    <main className="min-h-screen grid-bg">
      <div className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
        <header className="mb-8">
          <p className="text-xs font-black uppercase tracking-[.2em] text-green-700">Getting started</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight">Set up your kitchen</h1>
          <p className="mt-3 max-w-xl text-[var(--muted)]">
            Three steps to turn this into a working profit and operations system: what you buy, who you buy it from, and your first invoice. You can stop and resume at any time.
          </p>
        </header>

        <div className="mb-8 rounded-2xl border bg-white p-5 panel-shadow">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-bold">
              {progress.completedCount} of {progress.totalCount} complete
            </span>
            <span className="text-sm font-black tabular-nums text-green-800">{progress.percent}%</span>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-[var(--primary)] transition-all duration-500" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>

        <ol className="space-y-4">
          {progress.steps.map(step => {
            const Icon = STEP_ICONS[step.key];
            const isNext = progress.nextStep?.key === step.key;

            return (
              <li
                key={step.key}
                className={`rounded-2xl border bg-white p-5 transition ${isNext ? "border-green-700/50 panel-shadow" : step.isComplete ? "opacity-75" : ""}`}
              >
                <div className="flex items-start gap-4">
                  <span
                    className={`grid size-11 shrink-0 place-items-center rounded-xl ${
                      step.isComplete ? "bg-green-700 text-white" : isNext ? "bg-green-50 text-green-800" : "bg-neutral-100 text-[var(--muted)]"
                    }`}
                  >
                    {step.isComplete ? <Check size={22} strokeWidth={3} /> : <Icon size={20} />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-black">{step.title}</h2>
                      {step.isComplete && (
                        <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-bold text-green-800">
                          {step.count} added
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-[var(--muted)]">{step.description}</p>
                    <p className="mt-2 text-xs font-semibold text-green-800">{step.payoff}</p>

                    <div className="mt-4">
                      <Link href={step.href}>
                        <Button variant={isNext ? "primary" : "secondary"} size="sm">
                          {step.isComplete ? "Add another" : isNext ? "Start this step" : "Open"}
                          <ArrowRight size={15} />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-white p-5">
          <div>
            <p className="font-bold">{progress.allStepsComplete ? "Everything is ready." : "Want to explore first?"}</p>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              {progress.allStepsComplete
                ? "Your workspace has real data in every area. Head to the dashboard."
                : "You can skip ahead — this checklist stays available in Settings."}
            </p>
          </div>
          <Button onClick={finish} disabled={pending || skipping} variant={progress.allStepsComplete ? "primary" : "secondary"}>
            {skipping ? "Finishing…" : progress.allStepsComplete ? "Go to dashboard" : "Skip for now"}
            <ArrowRight size={16} />
          </Button>
        </div>
      </div>
    </main>
  );
}
