"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SupplierProductForm } from "@/components/forms/supplier-product-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney, toMajorUnits } from "@/lib/money";
import { formatQuantity, type UnitRow } from "@/lib/units";
import { formatRelative } from "@/lib/utils";
import { deleteSupplierProduct } from "@/server/actions/suppliers";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { SupplierProductRow } from "@/server/queries/suppliers";

export function SupplierProductTable({
  supplierId,
  rows,
  ingredients,
  units,
  currency,
  canManage,
}: {
  supplierId: string;
  rows: SupplierProductRow[];
  ingredients: IngredientOption[];
  units: UnitRow[];
  currency: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SupplierProductRow | null>(null);
  const [, startTransition] = useTransition();

  function remove(row: SupplierProductRow) {
    if (!confirm(`Remove “${row.ingredientName}” from this supplier's catalog? Past invoices are not affected.`)) return;
    startTransition(async () => {
      const result = await deleteSupplierProduct(row.id);
      if (result.ok) {
        toast.success("Product removed");
        router.refresh();
      } else {
        toast.error(result.error ?? "Could not remove product");
      }
    });
  }

  // Ingredients already in this catalog are excluded from the "add" picker; the
  // unique index would otherwise turn a second add into a silent update.
  const availableIngredients = ingredients.filter(ingredient => !rows.some(row => row.ingredientId === ingredient.id));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b">
        <div>
          <h2 className="text-lg font-black">Products they sell</h2>
          <p className="text-sm text-[var(--muted)]">Prices update automatically when you receive an invoice from this supplier.</p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setAdding(true)} disabled={availableIngredients.length === 0}>
            <Plus size={16} /> Add product
          </Button>
        )}
      </CardHeader>

      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No products listed for this supplier"
            description="Add the ingredients this supplier sells you, with their SKU and pack size, so invoices are faster to enter and prices become comparable."
            action={canManage ? <Button onClick={() => setAdding(true)}><Plus size={17} /> Add first product</Button> : undefined}
          />
        ) : (
          <Table className="min-w-[820px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH>Supplier SKU</TH>
                <TH className="text-right">Pack</TH>
                <TH className="text-right">Latest price</TH>
                <TH>Last updated</TH>
                <TH className="w-20" />
              </TR>
            </THead>
            <TBody>
              {rows.map(row => (
                <TR key={row.id} className={row.lastPriceMillis <= 0 ? "bg-amber-50/50" : undefined}>
                  <TD>
                    <b>{row.ingredientName}</b>
                    <span className="block text-xs text-[var(--muted)]">base unit {row.baseUnitCode}</span>
                  </TD>
                  <TD className="text-[var(--muted)]">{row.supplierSku ?? "—"}</TD>
                  <TDNum>{formatQuantity(row.packQuantity, row.packUnitCode ?? row.baseUnitCode)}</TDNum>
                  <TDNum>
                    {row.lastPriceMillis > 0 ? (
                      <>
                        <b>{formatMoney(row.lastPriceMillis, currency)}</b>
                        <span className="block text-xs text-[var(--muted)]">per {row.packUnitCode ?? row.baseUnitCode}</span>
                      </>
                    ) : (
                      <Badge tone="warning">No price yet</Badge>
                    )}
                  </TDNum>
                  <TD className="text-xs text-[var(--muted)]">
                    {row.lastPurchasedAt ? <>Invoiced {formatRelative(row.lastPurchasedAt)}</> : <>Edited {formatRelative(row.updatedAt)}</>}
                    {!row.isActive && <Badge className="ml-2">Inactive</Badge>}
                  </TD>
                  <TD>
                    {canManage && (
                      <div className="flex gap-1">
                        <button type="button" aria-label={`Edit ${row.ingredientName}`} onClick={() => setEditing(row)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100">
                          <Pencil size={16} />
                        </button>
                        <button type="button" aria-label={`Remove ${row.ingredientName}`} onClick={() => remove(row)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-red-50 hover:text-red-700">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add product" description="List an ingredient this supplier sells you." size="lg">
        <SupplierProductForm supplierId={supplierId} ingredients={availableIngredients} units={units} currency={currency} onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} />
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.ingredientName ?? ""}`} size="lg">
        {editing && (
          <SupplierProductForm
            supplierId={supplierId}
            ingredients={ingredients}
            units={units}
            currency={currency}
            submitLabel="Save changes"
            defaultValues={{
              id: editing.id,
              supplierId,
              ingredientId: editing.ingredientId,
              supplierSku: editing.supplierSku ?? "",
              packQuantity: editing.packQuantity,
              packUnitCode: editing.packUnitCode ?? editing.baseUnitCode,
              unitPrice: toMajorUnits(editing.lastPriceMillis, currency),
              isActive: editing.isActive,
            }}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </Card>
  );
}
