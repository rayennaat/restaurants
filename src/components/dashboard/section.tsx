import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A titled band of a page.
 *
 * The dashboard's problem was not that it held too much — the brief is explicit
 * that nothing should be removed — but that every band announced itself at the
 * same volume. A screen where "Needs attention" and "Analytics" are typeset
 * identically gives the eye no order to read in, so the reader has to weigh
 * each section themselves.
 *
 * `tone="alert"` is for a band the user should look at *now*, and it is applied
 * conditionally: the attention band only wears it when something is actually
 * wrong. A heading permanently coloured for urgency stops meaning urgency.
 */
export function Section({
  title,
  description,
  action,
  tone = "default",
  className,
  children,
}: {
  title: string;
  description?: string;
  /** Optional "see all" link, rendered to the right of the title. */
  action?: { label: string; href: string };
  tone?: "default" | "alert";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className={cn("text-base font-black tracking-tight", tone === "alert" && "text-amber-800")}>{title}</h2>
          {description && <p className="mt-0.5 text-sm text-[var(--muted)]">{description}</p>}
        </div>
        {action && (
          <Link
            href={action.href}
            className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-green-800 transition hover:gap-1.5 hover:text-green-900"
          >
            {action.label}
            <ArrowRight size={15} aria-hidden />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
