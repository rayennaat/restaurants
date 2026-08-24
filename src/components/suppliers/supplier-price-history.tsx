import Link from "next/link";
import { History, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { formatDate } from "@/lib/utils";
import type { PriceHistoryPoint } from "@/server/queries/suppliers";

type PricedPoint = PriceHistoryPoint & { changePercent: number | null };

/**
 * Every invoice line this supplier has billed, newest first, annotated with how
 * the base-unit price moved against the previous time we bought the same item.
 */
export function SupplierPriceHistory({ points, currency }: { points: PriceHistoryPoint[]; currency: string }) {
  // Compare each line against the previous purchase of the same ingredient.
  const previousByIngredient = new Map<string, number>();
  const priced: PricedPoint[] = [...points]
    .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
    .map(point => {
      const previous = previousByIngredient.get(point.ingredientId);
      previousByIngredient.set(point.ingredientId, point.baseUnitCostMillis);
      const changePercent = previous && previous > 0 ? ((point.baseUnitCostMillis - previous) / previous) * 100 : null;
      return { ...point, changePercent };
    })
    .reverse();

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-neutral-50/60">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <History size={18} className="text-green-700" />
          Price history
        </h2>
        <p className="text-sm text-[var(--muted)]">Derived from the invoices you recorded — prices are normalised per base unit so they stay comparable.</p>
      </CardHeader>
      <CardContent className="p-0">
        {priced.length === 0 ? (
          <EmptyState
            icon={History}
            title="No invoices from this supplier yet"
            description="Record a purchase invoice and every line will appear here, with the price change against the last time you bought the same ingredient."
            action={{ label: "Record a purchase", href: "/dashboard/purchases?view=new" }}
          />
        ) : (
          <Table className="min-w-[760px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Date</TH>
                <TH>Ingredient</TH>
                <TH className="text-right">Quantity</TH>
                <TH className="text-right">Invoice price</TH>
                <TH className="text-right">Per base unit</TH>
                <TH className="text-right">Change</TH>
              </TR>
            </THead>
            <TBody>
              {priced.map((point, index) => (
                <TR key={`${point.purchaseId}-${point.ingredientId}-${index}`}>
                  <TD>
                    <Link href={`/dashboard/purchases/${point.purchaseId}`} className="font-semibold hover:text-green-800">
                      {formatDate(point.receivedAt)}
                    </Link>
                    {point.invoiceNumber && <span className="block text-xs text-[var(--muted)]">#{point.invoiceNumber}</span>}
                  </TD>
                  <TD>{point.ingredientName}</TD>
                  <TDNum className="text-[var(--muted)]">{formatQuantity(point.quantity, point.unitCode ?? point.baseUnitCode)}</TDNum>
                  <TDNum>
                    {formatMoney(point.unitCostMillis, currency)}
                    <span className="block text-xs text-[var(--muted)]">/{point.unitCode ?? point.baseUnitCode}</span>
                  </TDNum>
                  <TDNum className="font-semibold">
                    {formatMoney(point.baseUnitCostMillis, currency)}
                    <span className="block text-xs font-normal text-[var(--muted)]">/{point.baseUnitCode}</span>
                  </TDNum>
                  <TDNum>
                    {point.changePercent === null ? (
                      <span className="text-xs text-[var(--muted)]">First purchase</span>
                    ) : Math.abs(point.changePercent) < 0.05 ? (
                      <Badge>No change</Badge>
                    ) : (
                      <Badge tone={point.changePercent > 0 ? "danger" : "success"} className="inline-flex items-center gap-1">
                        {point.changePercent > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                        {point.changePercent > 0 ? "+" : ""}
                        {point.changePercent.toFixed(1)}%
                      </Badge>
                    )}
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
