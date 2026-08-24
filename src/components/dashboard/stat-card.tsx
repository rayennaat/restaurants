import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

export function StatCard({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: LucideIcon }) {
  return (
    <Card className="relative overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
            <p className="mt-1.5 text-2xl font-black tabular-nums">{value}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>
          </div>
          <div className="rounded-lg bg-green-50 p-2.5">
            <Icon size={21} className="text-green-800" />
          </div>
        </div>
      </div>
    </Card>
  );
}
