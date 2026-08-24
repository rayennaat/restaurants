import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import type { SupplierComparisonRow } from "@/server/queries/suppliers";

/**
 * Ingredients you can buy from more than one supplier, ranked by how much the
 * cheapest and dearest offers differ.
 */
export function SupplierComparison({ rows, currency }: { rows: SupplierComparisonRow[]; currency: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-neutral-50/60">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <ArrowLeftRight size={18} className="text-green-700" />
          Price comparison
        </h2>
        <p className="text-sm text-[var(--muted)]">Ingredients offered by more than one supplier, biggest spread first.</p>
      </CardHeader>
      <CardContent className="p-0">
        <Table className="min-w-[640px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Ingredient</TH>
              <TH>Cheapest</TH>
              <TH>Other offers</TH>
              <TH className="text-right">Spread</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(row => {
              const [cheapest, ...others] = row.offers;
              return (
                <TR key={row.ingredientId}>
                  <TD>
                    <b>{row.ingredientName}</b>
                    <span className="block text-xs text-[var(--muted)]">per {row.baseUnitCode}</span>
                  </TD>
                  <TD>
                    <Link href={`/dashboard/suppliers/${cheapest.supplierId}`} className="font-semibold text-green-800 hover:underline">
                      {cheapest.supplierName}
                    </Link>
                    <span className="block text-xs tabular-nums text-[var(--muted)]">{formatMoney(cheapest.lastPriceMillis, currency)}</span>
                  </TD>
                  <TD className="text-xs text-[var(--muted)]">
                    {others.map(offer => (
                      <span key={offer.supplierId} className="mr-2 inline-block whitespace-nowrap">
                        {offer.supplierName} <span className="tabular-nums">{formatMoney(offer.lastPriceMillis, currency)}</span>
                      </span>
                    ))}
                  </TD>
                  <TDNum>
                    <Badge tone={row.savingsMillis > 0 ? "warning" : "neutral"}>{formatMoney(row.savingsMillis, currency)}</Badge>
                  </TDNum>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
