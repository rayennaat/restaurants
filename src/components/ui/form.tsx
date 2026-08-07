"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Field wrapper that renders the label, the control and its validation error. */
export function Field({
  label,
  error,
  hint,
  required,
  className,
  children,
}: {
  /** Omit for inline grid rows where a column header already labels the input. */
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      {label && (
        <label className="mb-1.5 block text-sm font-semibold">
          {label}
          {required && <span className="ml-0.5 text-red-600">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="mt-1 text-xs font-semibold text-red-600">{error}</p> : hint ? <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}

export function FormError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return <p className={cn("rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700", className)}>{message}</p>;
}

/** Submit button for `<form action={serverAction}>` that disables while pending. */
export function SubmitButton({ children, pendingLabel = "Saving…", ...props }: React.ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
