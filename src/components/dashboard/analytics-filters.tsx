"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { CalendarRange, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DATE_RANGE_LABELS, DATE_RANGE_PRESETS, DEFAULT_PRESET, type DateRangePreset } from "@/lib/date-range";
import type { LocationOption } from "@/server/queries/locations";
import { cn } from "@/lib/utils";

/**
 * Date range + location filters for the dashboard and reports.
 *
 * State lives in the query string, exactly like {@link FilterBar}, so the pages
 * behind it stay server components and a filtered view stays shareable and
 * refresh-safe. Nothing is fetched here — changing a filter re-runs the server
 * queries with the new window.
 *
 * The location id is only a hint: the server validates it against the tenant
 * before any query uses it.
 */
export function AnalyticsFilters({
  locations,
  currentPreset,
  currentLocationId,
  from,
  to,
  className,
}: {
  locations: LocationOption[];
  currentPreset: DateRangePreset;
  currentLocationId: string | null;
  /** Custom-range bounds as YYYY-MM-DD, echoed back from the server. */
  from: string;
  to: string;
  className?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    startTransition(() => router.replace(query ? `?${query}` : "?", { scroll: false }));
  }

  const isCustom = currentPreset === "custom";

  return (
    <div className={cn("flex flex-wrap items-center gap-2.5 rounded-lg border bg-white px-3 py-2 shadow-sm", pending && "opacity-70", className)}>
      <div className="flex items-center gap-2">
        <CalendarRange size={17} className="text-[var(--muted)]" />
        <Select
          aria-label="Date range"
          value={currentPreset}
          onChange={event => {
            const preset = event.target.value as DateRangePreset;
            // Seed a custom range with the dates already on screen so the first
            // switch shows data rather than an empty window.
            apply(preset === "custom" ? { range: preset, from, to } : { range: preset === DEFAULT_PRESET ? "" : preset, from: "", to: "" });
          }}
          className="h-10 w-auto min-w-40"
        >
          {DATE_RANGE_PRESETS.map(preset => (
            <option key={preset} value={preset}>
              {DATE_RANGE_LABELS[preset]}
            </option>
          ))}
        </Select>
      </div>

      {isCustom && (
        <div className="flex items-center gap-2">
          <Input type="date" aria-label="From date" value={from} max={to} onChange={event => apply({ range: "custom", from: event.target.value })} className="h-10 w-auto" />
          <span className="text-sm text-[var(--muted)]">→</span>
          <Input type="date" aria-label="To date" value={to} min={from} onChange={event => apply({ range: "custom", to: event.target.value })} className="h-10 w-auto" />
        </div>
      )}

      {locations.length > 1 && (
        <div className="flex items-center gap-2">
          <MapPin size={17} className="text-[var(--muted)]" />
          <Select
            aria-label="Location"
            value={currentLocationId ?? "all"}
            onChange={event => apply({ location: event.target.value === "all" ? "" : event.target.value })}
            className="h-10 w-auto min-w-40"
          >
            <option value="all">All locations</option>
            {locations.map(location => (
              <option key={location.id} value={location.id}>
                {location.name}
                {location.isActive ? "" : " (archived)"}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
