"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney, formatMoneyCompact } from "@/lib/money";

export function WasteChart({ data, currency }: { data: { day: string; label?: string; cost: number }[]; currency: string }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="waste" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#166534" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#166534" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={data[0]?.label ? "label" : "day"} tickLine={false} axisLine={false} />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={value => formatMoneyCompact(Number(value), currency)} />
          <Tooltip formatter={value => [formatMoney(Number(value), currency), "Waste"]} />
          <Area type="monotone" dataKey="cost" stroke="#166534" strokeWidth={3} fill="url(#waste)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
