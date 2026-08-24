"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { CheckCircle2, Save, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney, formatPercent } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import {
  calculateItemVariance,
  isEditableStatus,
  summarizeCount,
  varianceTone,
  type CountItemVariance,
} from "@/lib/stock-count";
import { approveStockCount, rejectStockCount, saveStockCountEntries, submitStockCount } from "@/server/actions/stock-counts";
import type { StockCountDetail } from "@/server/queries/stock-counts";

/**
 * The count sheet: enter physical quantities, see variance as you type, then
 * submit for approval.
 *
 * Variance is recomputed locally with the same `calculateItemVariance` the
 * server uses, so what the counter sees while typing and what the approver
 * signs off are produced by one function rather than two implementations that
 * could drift.
 *
 * The system quantity is display-only. There is deliberately no control that
 * edits it — it is the ledger's answer, and the whole point of the exercise is
 * to compare against it.
 */
export function CountSheet({
  count,
  currency,
  canCount,
  canApprove,
}: {
  count: StockCountDetail;
  currency: string;
  canCount: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const editable = isEditableStatus(count.status) && canCount;

  // Draft entries, keyed by line id. Empty string means "not counted".
  const [entries, setEntries] = useState<Record<string, string>>(() =>
    Object.fromEntries(count.items.map(item => [item.id, item.countedQuantity === null ? "" : String(item.countedQuantity)])),
  );
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pending, startTransition] = useTransition();

  /** Live variance from the typed values, using the server's own engine. */
  const live: (CountItemVariance & { id: string })[] = useMemo(
    () =>
      count.items.map(item => {
        const raw = entries[item.id];
        const parsed = raw === undefined || raw.trim() === "" ? null : Number(raw);
        return {
          ...calculateItemVariance({
            ingredientId: item.ingredientId,
            ingredientName: item.ingredientName,
            unit: item.unit,
            systemQuantity: item.systemQuantity,
            countedQuantity: parsed !== null && Number.isFinite(parsed) ? parsed : null,
            unitCostMillis: item.unitCostMillis,
          }),
          id: item.id,
        };
      }),
    [count.items, entries],
  );

  const summary = useMemo(() => summarizeCount(live), [live]);

  const save = (then?: () => void) =>
    startTransition(async () => {
      const result = await saveStockCountEntries({
        stockCountId: count.id,
        entries: live.map(item => ({ itemId: item.id, countedQuantity: item.countedQuantity })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDirty(false);
      setError(null);
      router.refresh();
      then?.();
    });

  const submit = () =>
    startTransition(async () => {
      // Save first so the server judges completeness against what is on screen.
      const saved = await saveStockCountEntries({
        stockCountId: count.id,
        entries: live.map(item => ({ itemId: item.id, countedQuantity: item.countedQuantity })),
      });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      const result = await submitStockCount(count.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDirty(false);
      toast.success("Count submitted for approval.");
      router.refresh();
    });

  const approve = () =>
    startTransition(async () => {
      const result = await approveStockCount(count.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setApproving(false);
      toast.success(
        result.data.movements === 0
          ? "Count approved. No variances, so no adjustments were needed."
          : `Count approved. ${result.data.movements} inventory adjustment${result.data.movements === 1 ? "" : "s"} created.`,
      );
      router.refresh();
    });

  const reject = (formData: FormData) =>
    startTransition(async () => {
      const result = await rejectStockCount({ stockCountId: count.id, reason: String(formData.get("reason") ?? "") });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRejecting(false);
      toast.success("Count rejected. Inventory was not changed.");
      router.refresh();
    });

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ summary */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile label="Items counted" value={`${summary.countedCount} / ${summary.itemCount}`} hint={`${summary.varianceCount} with a variance`} />
        <SummaryTile label="Total gain" value={formatMoney(summary.positiveValueMillis, currency)} hint="Counted above the ledger" tone="success" />
        <SummaryTile label="Total loss" value={formatMoney(summary.negativeValueMillis, currency)} hint="Counted below the ledger" tone="danger" />
        <SummaryTile
          label="Net variance"
          value={formatMoney(summary.netValueMillis, currency)}
          hint={summary.netValueMillis === 0 ? "Ledger confirmed" : summary.netValueMillis > 0 ? "Stock gained" : "Stock lost"}
          tone={summary.netValueMillis < 0 ? "danger" : summary.netValueMillis > 0 ? "success" : "neutral"}
        />
      </div>

      {count.status === "rejected" && count.rejectionReason && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="pt-5">
            <p className="text-sm font-black text-red-800">Rejected</p>
            <p className="mt-1 text-sm text-red-900/80">{count.rejectionReason}</p>
            <p className="mt-2 text-xs text-[var(--muted)]">Inventory was not changed. Start a new count to correct this.</p>
          </CardContent>
        </Card>
      )}

      {count.status === "approved" && (
        <Card className="border-green-200 bg-green-50/50">
          <CardContent className="pt-5">
            <p className="text-sm font-black text-green-900">Approved{count.approvedByName ? ` by ${count.approvedByName}` : ""}</p>
            <p className="mt-1 text-sm text-green-900/80">
              Inventory adjustments were written to the stock ledger. This count is now a permanent record and cannot be
              edited — correct it with a new count.
            </p>
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------- count sheet */}
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b">
          <div>
            <h2 className="text-lg font-black">Count sheet</h2>
            <p className="text-sm text-[var(--muted)]">
              {editable
                ? "Enter what is physically on the shelf. The system quantity comes from the stock ledger and cannot be edited."
                : "This count is locked. Quantities are shown as they were recorded."}
            </p>
          </div>
          {editable && (
            <span className="grid w-full gap-2 sm:flex sm:w-auto">
              <Button variant="secondary" onClick={() => save()} disabled={pending || !dirty}>
                <Save size={16} /> {pending ? "Saving…" : dirty ? "Save progress" : "Saved"}
              </Button>
              <Button onClick={submit} disabled={pending || !summary.isComplete} title={summary.isComplete ? undefined : "Every ingredient needs a counted quantity"}>
                <Send size={16} /> Submit for approval
              </Button>
            </span>
          )}
        </CardHeader>

        <Table className="min-w-[900px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Ingredient</TH>
              <TH className="text-right">System</TH>
              <TH className="text-right">Physical count</TH>
              <TH className="text-right">Variance</TH>
              <TH className="text-right">%</TH>
              <TH className="text-right">Value</TH>
            </TR>
          </THead>
          <TBody>
            {live.map(item => {
              const tone = varianceTone(item);
              return (
                <TR key={item.id}>
                  <TD>
                    <b className="text-sm">{item.ingredientName}</b>
                    <span className="block text-xs text-[var(--muted)]">
                      {formatMoney(item.unitCostMillis, currency)}/{item.unit}
                    </span>
                  </TD>
                  <TDNum className="text-[var(--muted)]">{formatQuantity(item.systemQuantity, item.unit)}</TDNum>
                  <TD className="text-right">
                    {editable ? (
                      <span className="inline-flex items-center gap-2">
                        <Input
                          type="number"
                          step="any"
                          min="0"
                          inputMode="decimal"
                          className="h-10 w-36 text-right text-base sm:text-sm"
                          value={entries[item.id] ?? ""}
                          placeholder="—"
                          onChange={event => {
                            setEntries(current => ({ ...current, [item.id]: event.target.value }));
                            setDirty(true);
                          }}
                        />
                        <span className="w-8 text-left text-xs text-[var(--muted)]">{item.unit}</span>
                      </span>
                    ) : (
                      <span className="text-sm tabular-nums">
                        {item.isCounted ? formatQuantity(item.countedQuantity ?? 0, item.unit) : "Not counted"}
                      </span>
                    )}
                  </TD>
                  <TDNum className={tone === "danger" ? "font-semibold text-red-700" : tone === "warning" ? "font-semibold text-amber-700" : ""}>
                    {item.isCounted ? `${item.varianceQuantity > 0 ? "+" : ""}${formatQuantity(item.varianceQuantity, item.unit)}` : "—"}
                  </TDNum>
                  <TDNum>
                    {item.isCounted && item.variancePercent !== null ? (
                      <Badge tone={tone === "neutral" ? "neutral" : tone}>
                        {item.variancePercent > 0 ? "+" : ""}
                        {formatPercent(item.variancePercent, 1)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-[var(--muted)]">—</span>
                    )}
                  </TDNum>
                  <TDNum className={item.varianceValueMillis < 0 ? "font-semibold text-red-700" : item.varianceValueMillis > 0 ? "font-semibold text-green-800" : ""}>
                    {item.isCounted ? formatMoney(item.varianceValueMillis, currency) : "—"}
                  </TDNum>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <FormError message={error} />

      {/* ------------------------------------------------------------ approval */}
      {count.status === "submitted" && canApprove && (
        <Card className="border-amber-200">
          <CardHeader>
            <h2 className="text-lg font-black">Approval</h2>
            <p className="text-sm text-[var(--muted)]">
              Submitted{count.submittedByName ? ` by ${count.submittedByName}` : ""}
              {count.submittedAt ? ` on ${count.submittedAt.toLocaleDateString()}` : ""}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-neutral-50 p-4 text-sm">
              <p className="font-bold">Approving will change inventory</p>
              <p className="mt-1 text-[var(--muted)]">
                {summary.varianceCount === 0
                  ? "No ingredient differs from the ledger, so no adjustments will be created."
                  : `${summary.varianceCount} adjustment${summary.varianceCount === 1 ? "" : "s"} will be written to the stock ledger, for a net ${formatMoney(summary.netValueMillis, currency)}. This cannot be undone — corrections require a new count.`}
              </p>
            </div>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <Button onClick={() => setApproving(true)} disabled={pending}>
                <CheckCircle2 size={16} /> Approve count
              </Button>
              <Button variant="secondary" onClick={() => setRejecting(true)} disabled={pending}>
                <XCircle size={16} /> Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {count.status === "submitted" && !canApprove && (
        <Card>
          <CardContent className="pt-5 text-sm text-[var(--muted)]">
            This count is waiting for a manager or owner to approve it. Your role can record counts but not approve the
            inventory adjustments they produce.
          </CardContent>
        </Card>
      )}

      <Modal open={approving} onClose={() => setApproving(false)} title="Approve this stock count?">
        <div className="space-y-4">
          <p className="text-sm">
            Approving writes {summary.varianceCount} inventory adjustment{summary.varianceCount === 1 ? "" : "s"} to the
            stock ledger at <b>{count.locationName}</b>, for a net of{" "}
            <b>{formatMoney(summary.netValueMillis, currency)}</b>.
          </p>
          <p className="text-sm text-[var(--muted)]">
            The ledger is append-only, so this is permanent. A mistake is corrected with a new count, never by editing
            this one.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setApproving(false)} disabled={pending}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={approve} disabled={pending}>
              {pending ? "Approving…" : "Approve and adjust"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={rejecting} onClose={() => setRejecting(false)} title="Reject this stock count">
        <form action={reject} className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            Inventory will not be changed. Tell the counter what needs redoing.
          </p>
          <Field label="Reason" required>
            <Input name="reason" required autoFocus placeholder="e.g. Walk-in freezer was not counted" />
          </Field>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setRejecting(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending}>
              {pending ? "Rejecting…" : "Reject count"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
        <p
          className={`mt-1.5 text-2xl font-black tabular-nums ${tone === "success" ? "text-green-800" : tone === "danger" ? "text-red-700" : ""}`}
        >
          {value}
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>
      </CardContent>
    </Card>
  );
}
