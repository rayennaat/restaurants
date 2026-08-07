"use client";

import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import type { InventoryRow } from "@/server/queries/inventory";

function buildColumns(currency: string): ColumnDef<InventoryRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Ingredient",
      cell: ({ row }) => (
        <div>
          <b>{row.original.name}</b>
          <div className="text-xs text-[var(--muted)]">
            {formatMoney(row.original.unitCostMillis, currency)}/{row.original.unit}
            {row.original.category ? ` · ${row.original.category}` : ""}
          </div>
        </div>
      ),
    },
    { accessorKey: "stock", header: "In stock", cell: ({ row }) => <span className="tabular-nums">{formatQuantity(row.original.stock, row.original.unit)}</span> },
    { accessorKey: "minimum", header: "Minimum", cell: ({ row }) => <span className="tabular-nums text-[var(--muted)]">{formatQuantity(row.original.minimum, row.original.unit)}</span> },
    { accessorKey: "valueMillis", header: "Value", cell: ({ row }) => <span className="font-semibold tabular-nums">{formatMoney(row.original.valueMillis, currency)}</span> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.stock <= 0 ? <Badge tone="danger">Out</Badge> : row.original.stock < row.original.minimum ? <Badge tone="warning">Low</Badge> : <Badge tone="success">Healthy</Badge>,
    },
  ];
}

export function InventoryTable({ data, currency }: { data: InventoryRow[]; currency: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns: buildColumns(currency),
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead>
          <tr className="border-b text-xs uppercase tracking-wider text-[var(--muted)]">
            {table.getHeaderGroups()[0].headers.map(header => {
              const sorted = header.column.getIsSorted();
              return (
                <th key={header.id} className="px-5 py-4 font-semibold">
                  <button type="button" onClick={header.column.getToggleSortingHandler()} className="inline-flex items-center gap-1.5 transition hover:text-[var(--foreground)]">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {sorted === "asc" ? <ArrowUp size={13} /> : sorted === "desc" ? <ArrowDown size={13} /> : <ChevronsUpDown size={13} className="opacity-40" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id} className="border-b last:border-0 hover:bg-neutral-50">
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-5 py-4">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
