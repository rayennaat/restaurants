import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { formatRelative } from "@/lib/utils";
import type { MovementRow } from "@/server/queries/inventory";

/** Human labels and tone for each `movement_type` enum value. */
const MOVEMENT_LABELS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  purchase: { label: "Purchase", tone: "success" },
  sale_consumption: { label: "Sold", tone: "neutral" },
  waste: { label: "Waste", tone: "danger" },
  transfer_in: { label: "Transfer in", tone: "success" },
  transfer_out: { label: "Transfer out", tone: "warning" },
  stock_count_adjustment: { label: "Count", tone: "warning" },
  return_to_supplier: { label: "Returned", tone: "warning" },
  manual_adjustment: { label: "Adjustment", tone: "neutral" },
};

export function MovementLedger({ rows, currency }: { rows: MovementRow[]; currency: string }) {
  if (!rows.length) {
    return <p className="px-5 pb-6 text-sm text-[var(--muted)]">No movements recorded yet. Receiving a purchase or logging waste writes the first ledger entries.</p>;
  }

  return (
    <ul className="divide-y">
      {rows.map(row => {
        const meta = MOVEMENT_LABELS[row.type] ?? { label: row.type, tone: "neutral" as const };
        const isInbound = row.quantity >= 0;
        const body = (
          <div className="flex items-start justify-between gap-3 px-5 py-3.5">
            <div className="min-w-0">
              <b className="block truncate text-sm">{row.ingredientName}</b>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                <Badge tone={meta.tone} className="mr-1.5 align-middle">
                  {meta.label}
                </Badge>
                {formatRelative(row.occurredAt)}
                {row.note ? ` · ${row.note}` : ""}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <b className={`block text-sm tabular-nums ${isInbound ? "text-green-800" : "text-red-700"}`}>
                {isInbound ? "+" : ""}
                {formatQuantity(row.quantity, row.unit)}
              </b>
              {row.unitCostMillis > 0 && <span className="text-xs text-[var(--muted)]">{formatMoney(Math.abs(Math.round(row.quantity * row.unitCostMillis)), currency)}</span>}
            </div>
          </div>
        );

        // Purchase movements link back to the invoice that produced them.
        return (
          <li key={row.id} className="transition hover:bg-neutral-50">
            {row.referenceType === "purchase" && row.referenceId ? <Link href={`/dashboard/purchases/${row.referenceId}`}>{body}</Link> : body}
          </li>
        );
      })}
    </ul>
  );
}
