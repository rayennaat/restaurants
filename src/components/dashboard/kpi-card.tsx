import type { LucideIcon } from "lucide-react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatPercent } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * A KPI with an optional period-over-period comparison.
 *
 * Sits alongside {@link StatCard}, which stays as-is for the simple counts on
 * other screens. The distinction here is `change`: a null value renders no
 * delta at all rather than "0.0%", because no previous data means no trend.
 *
 * `invertChange` marks metrics where up is bad — waste rising is not good news —
 * so the colour reflects the business meaning rather than the arithmetic sign.
 */
export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  change,
  invertChange = false,
  emphasis = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  /** Percentage change vs the previous period. Null hides the indicator. */
  change?: number | null;
  invertChange?: boolean;
  emphasis?: "neutral" | "success" | "warning" | "danger";
}) {
  const hasChange = typeof change === "number" && Number.isFinite(change);
  const rising = hasChange && change > 0;
  const flat = hasChange && Math.round(change * 10) === 0;
  const good = invertChange ? !rising : rising;

  return (
    <Card className="relative overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
            <p
              className={cn(
                "mt-1.5 text-2xl font-black tabular-nums",
                emphasis === "success" && "text-green-800",
                emphasis === "warning" && "text-amber-700",
                emphasis === "danger" && "text-red-700",
              )}
            >
              {value}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {hasChange && !flat && (
                <span className={cn("inline-flex items-center gap-1 text-xs font-bold", good ? "text-green-700" : "text-red-700")}>
                  {rising ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  {rising ? "+" : ""}
                  {formatPercent(change)}
                </span>
              )}
              <span className="text-xs text-[var(--muted)]">{hint}</span>
            </div>
          </div>
          <div className="rounded-lg bg-green-50 p-2.5">
            <Icon size={21} className="text-green-800" />
          </div>
        </div>
      </div>
    </Card>
  );
}
