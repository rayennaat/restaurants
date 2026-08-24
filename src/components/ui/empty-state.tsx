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
    <div className={cn("grid place-items-center px-5 py-10 text-center", className)}>
      <span className="grid size-12 place-items-center rounded-lg bg-green-50 text-green-800">
        <Icon size={23} />
      </span>
      <h3 className="mt-3 text-base font-black">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-[var(--muted)]">{description}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
        {action && typeof action === "object" && "href" in action ? (
          <Link href={action.href} className="inline-flex h-10 items-center rounded-lg bg-[var(--primary)] px-3.5 text-sm font-semibold text-white transition hover:bg-green-800">
            {action.label}
          </Link>
        ) : (
          action
        )}
        {secondaryAction && (
          <Link href={secondaryAction.href} className="inline-flex h-10 items-center rounded-lg border bg-white px-3.5 text-sm font-semibold transition hover:bg-neutral-50">
            {secondaryAction.label}
          </Link>
        )}
      </div>
    </div>
  );
}
