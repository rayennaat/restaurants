"use client";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatQuantity } from "@/lib/utils";
type Row = { id: string; name: string; unit: string; stock: number; minimum: number; unitCostMillis: number };
const columns: ColumnDef<Row>[] = [
  { accessorKey: "name", header: "Ingredient", cell: ({ row }) => <div><b>{row.original.name}</b><div className="text-xs text-[var(--muted)]">{formatMoney(row.original.unitCostMillis)}/{row.original.unit}</div></div> },
  { accessorKey: "stock", header: "Current stock", cell: ({ row }) => formatQuantity(row.original.stock, row.original.unit) },
  { accessorKey: "minimum", header: "Minimum", cell: ({ row }) => formatQuantity(row.original.minimum, row.original.unit) },
  { id: "status", header: "Status", cell: ({ row }) => row.original.stock < row.original.minimum ? <Badge tone="danger">Low stock</Badge> : <Badge tone="success">Healthy</Badge> }
];
export function InventoryTable({ data }: { data: Row[] }) { const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() }); return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b text-xs uppercase tracking-wider text-[var(--muted)]">{table.getHeaderGroups()[0].headers.map(h => <th key={h.id} className="px-5 py-4">{flexRender(h.column.columnDef.header, h.getContext())}</th>)}</tr></thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id} className="border-b last:border-0 hover:bg-neutral-50">{row.getVisibleCells().map(cell => <td key={cell.id} className="px-5 py-4">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>; }
