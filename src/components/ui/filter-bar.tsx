"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type FilterDefinition = { name: string; label: string; options: { value: string; label: string }[]; defaultValue?: string };

/**
 * URL-driven search + filter bar. State lives in the query string so list pages
 * stay server components and filtered views are shareable and refresh-safe.
 */
export function FilterBar({ searchPlaceholder = "Search…", filters = [], className }: { searchPlaceholder?: string; filters?: FilterDefinition[]; className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const urlQuery = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  // Adjust state during render rather than in an effect: when the URL changes
  // from elsewhere (Clear, back button), reset the box without a second pass
  // that could overwrite what the user is mid-way through typing.
  const [lastUrlQuery, setLastUrlQuery] = useState(urlQuery);
  if (urlQuery !== lastUrlQuery) {
    setLastUrlQuery(urlQuery);
    setQuery(urlQuery);
  }

  function apply(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page");
    startTransition(() => router.replace(`?${params.toString()}`, { scroll: false }));
  }

  // Debounce typing so we do not navigate on every keystroke.
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (query === current) return;
    const timer = setTimeout(() => apply({ q: query }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const hasFilters = [...searchParams.keys()].some(key => key === "q" || filters.some(filter => filter.name === key));

  return (
    <div className={cn("flex flex-wrap items-center gap-3", pending && "opacity-70", className)}>
      <div className="relative min-w-56 flex-1">
        <Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={searchPlaceholder} className="pl-9" aria-label={searchPlaceholder} />
      </div>
      {filters.map(filter => (
        <Select
          key={filter.name}
          aria-label={filter.label}
          value={searchParams.get(filter.name) ?? filter.defaultValue ?? ""}
          onChange={event => apply({ [filter.name]: event.target.value === (filter.defaultValue ?? "") ? "" : event.target.value })}
          className="h-11 w-auto min-w-36"
        >
          {filter.options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ))}
      {hasFilters && (
        <button
          type="button"
          onClick={() => startTransition(() => router.replace("?", { scroll: false }))}
          className="inline-flex h-11 items-center gap-1.5 rounded-xl border bg-white px-3 text-sm font-semibold text-[var(--muted)] transition hover:bg-neutral-50"
        >
          <X size={15} />
          Clear
        </button>
      )}
    </div>
  );
}
