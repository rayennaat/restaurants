"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { MapPin } from "lucide-react";
import { Select } from "@/components/ui/select";
import type { LocationOption } from "@/server/queries/locations";

export function InventoryLocationFilter({
  locations,
  currentLocationId,
}: {
  locations: LocationOption[];
  currentLocationId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (locations.length <= 1) return null;

  const apply = (locationId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (locationId === "all") params.delete("location");
    else params.set("location", locationId);
    const query = params.toString();
    startTransition(() => router.replace(query ? `?${query}` : "?", { scroll: false }));
  };

  return (
    <div className={`flex items-center gap-2${pending ? " opacity-70" : ""}`}>
      <MapPin size={17} className="text-[var(--muted)]" />
      <Select
        aria-label="Inventory location"
        value={currentLocationId ?? "all"}
        onChange={event => apply(event.currentTarget.value)}
        disabled={pending}
        className="h-11 min-w-40"
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
  );
}
