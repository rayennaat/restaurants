import { cn } from "@/lib/utils";

/** Shared table shell so every list screen has identical density and borders. */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-left text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b bg-neutral-50/70 text-xs uppercase tracking-wider text-[var(--muted)]", className)} {...props} />;
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-3 py-2.5 font-semibold sm:px-4", className)} {...props} />;
}

export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b transition last:border-0 hover:bg-neutral-50", className)} {...props} />;
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2.5 align-middle sm:px-4", className)} {...props} />;
}

/** Right-aligned numeric cell with tabular figures so columns line up. */
export function TDNum({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <TD className={cn("text-right tabular-nums", className)} {...props} />;
}
