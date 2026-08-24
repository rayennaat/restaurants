"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { SupplierForm } from "@/components/forms/supplier-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Modal } from "@/components/ui/modal";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { formatRelative } from "@/lib/utils";
import { deleteSupplier, setSupplierArchived } from "@/server/actions/suppliers";
import type { SupplierListRow } from "@/server/queries/suppliers";

export function SupplierDirectory({ rows, currency, canManage, isEmptyDirectory }: { rows: SupplierListRow[]; currency: string; canManage: boolean; isEmptyDirectory: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SupplierListRow | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function runAction(promise: Promise<{ ok: boolean; error?: string }>, successMessage: string) {
    setMenuFor(null);
    startTransition(async () => {
      const result = await promise;
      if (result.ok) {
        toast.success(successMessage);
        router.refresh();
      } else {
        toast.error(result.error ?? "Action failed");
      }
    });
  }

  const createModal = (
    <Modal open={creating} onClose={() => setCreating(false)} title="New supplier" description="You can add the products they sell once the supplier exists." size="lg">
      <SupplierForm onSaved={id => { setCreating(false); router.push(`/dashboard/suppliers/${id}`); }} onCancel={() => setCreating(false)} />
    </Modal>
  );

  if (isEmptyDirectory) {
    return (
      <>
        <Card>
          <EmptyState
            icon={Truck}
            title="No suppliers yet"
            description="Add who you buy from, then list the products they sell with their SKU and pack size. Once you record invoices, you will see who is cheapest for each ingredient."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Add your first supplier</Button> : undefined}
          />
        </Card>
        {createModal}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          searchPlaceholder="Search supplier, contact or email…"
          filters={[
            {
              name: "status",
              label: "Status",
              defaultValue: "active",
              options: [
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
                { value: "all", label: "All statuses" },
              ],
            },
          ]}
          className="flex-1"
        />
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} /> New supplier
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={Truck} title="No suppliers match these filters" description="Try clearing the search box or switching the status filter." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="text-lg font-black">Supplier directory</h2>
            <p className="text-sm text-[var(--muted)]">Products and purchase history first; price comparison stays below as intelligence.</p>
          </CardHeader>
          <Table className="min-w-[860px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Supplier</TH>
                <TH>Contact</TH>
                <TH className="text-right">Products</TH>
                <TH className="text-right">Invoices</TH>
                <TH className="text-right">Total spend</TH>
                <TH>Last activity</TH>
                <TH className="w-12" />
              </TR>
            </THead>
            <TBody>
              {rows.map(supplier => (
                <TR key={supplier.id}>
                  <TD>
                    <Link href={`/dashboard/suppliers/${supplier.id}`} className="font-bold text-green-900 hover:underline">
                      {supplier.name}
                    </Link>
                    {!supplier.isActive && <Badge className="ml-2">Archived</Badge>}
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{supplier.contactName ?? supplier.phone ?? supplier.email ?? "No contact details"}</TD>
                  <TDNum className="font-semibold">{supplier.productCount}</TDNum>
                  <TDNum>{supplier.purchaseCount}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(supplier.totalSpendMillis, currency)}</TDNum>
                  <TD className="text-xs text-[var(--muted)]">{supplier.purchaseCount > 0 ? `Last ${formatRelative(supplier.lastPurchaseAt!)}` : "No invoices yet"}</TD>
                  <TD className="relative text-right">
                    {canManage && (
                      <button type="button" aria-label={`Actions for ${supplier.name}`} onClick={() => setMenuFor(menuFor === supplier.id ? null : supplier.id)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100">
                        <MoreHorizontal size={18} />
                      </button>
                    )}
                    {menuFor === supplier.id && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                        <div className="absolute right-4 top-10 z-20 w-52 overflow-hidden rounded-lg border bg-white py-1 text-left shadow-xl">
                          <button type="button" onClick={() => { setMenuFor(null); setEditing(supplier); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50">
                            <Pencil size={15} /> Edit details
                          </button>
                          <button
                            type="button"
                            onClick={() => runAction(setSupplierArchived(supplier.id, supplier.isActive), supplier.isActive ? "Supplier archived" : "Supplier restored")}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
                          >
                            {supplier.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (confirm(`Permanently delete “${supplier.name}”?`)) runAction(deleteSupplier(supplier.id), "Supplier deleted"); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"
                          >
                            <Trash2 size={15} /> Delete
                          </button>
                        </div>
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {createModal}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="lg">
        {editing && (
          <SupplierForm
            submitLabel="Save changes"
            defaultValues={{
              id: editing.id,
              name: editing.name,
              contactName: editing.contactName ?? "",
              phone: editing.phone ?? "",
              email: editing.email ?? "",
              address: editing.address ?? "",
              notes: editing.notes ?? "",
              isActive: editing.isActive,
            }}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}
