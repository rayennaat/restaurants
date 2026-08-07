import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Every list in the app renders this instead of an empty table, so a new
 * workspace always shows the next useful action rather than blank space.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: { label: string; href: string } | React.ReactNode;
  secondaryAction?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={cn("grid place-items-center px-6 py-14 text-center", className)}>
      <span className="grid size-14 place-items-center rounded-2xl bg-green-50 text-green-800">
        <Icon size={26} />
      </span>
      <h3 className="mt-4 text-lg font-black">{title}</h3>
      <p className="mt-2 max-w-md text-sm text-[var(--muted)]">{description}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        {action && typeof action === "object" && "href" in action ? (
          <Link href={action.href} className="inline-flex h-11 items-center rounded-xl bg-[var(--primary)] px-4 font-semibold text-white transition hover:bg-green-800">
            {action.label}
          </Link>
        ) : (
          action
        )}
        {secondaryAction && (
          <Link href={secondaryAction.href} className="inline-flex h-11 items-center rounded-xl border bg-white px-4 font-semibold transition hover:bg-neutral-50">
            {secondaryAction.label}
          </Link>
        )}
      </div>
    </div>
  );
}
