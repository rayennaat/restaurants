"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lightweight modal used by the catalog editors. Built on the native `<dialog>`
 * element so focus trapping, Escape handling and the top layer come from the
 * platform instead of another dependency.
 */

/**
 * Whether React has finished hydrating.
 *
 * A portal has no server equivalent: its markup is appended to `document.body`,
 * which does not exist during SSR. Rendering it on the very first client pass
 * would mean the server sent nothing where the client expects a `<dialog>`, and
 * React reports a hydration mismatch and throws the tree away.
 *
 * `useSyncExternalStore` expresses exactly that — the server snapshot is
 * `false` and is also what the hydration pass renders, then the client snapshot
 * takes over on the commit after. A `useState` + `useEffect` pair would produce
 * the same result by deliberately triggering the cascading re-render that
 * `react-hooks/set-state-in-effect` exists to prevent; this asks the question
 * directly instead. The store never changes, so the subscribe callback has
 * nothing to register.
 */
const subscribeToNothing = () => () => {};
const useHasHydrated = () =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const mounted = useHasHydrated();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Server render and first client render agree: both produce nothing.
  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100vw-1.5rem)] rounded-lg border bg-white p-0 text-[var(--foreground)] backdrop:bg-black/40 backdrop:backdrop-blur-sm",
        size === "md" && "max-w-lg",
        size === "lg" && "max-w-2xl",
        size === "xl" && "max-w-4xl",
      )}
    >
      {open && (
        <div className="max-h-[85vh] overflow-y-auto">
          <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-white px-6 py-5">
            <div>
              <h2 className="text-xl font-black">{title}</h2>
              {description && <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 rounded-lg p-2 text-[var(--muted)] transition hover:bg-neutral-100">
              <X size={18} />
            </button>
          </header>
          <div className="px-6 py-5">{children}</div>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
