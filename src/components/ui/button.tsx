import * as React from "react";
import { cn } from "@/lib/utils";
type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg" };
export function Button({ className, variant = "primary", size = "md", ...props }: Props) {
  return <button className={cn("inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-50", { "bg-[var(--primary)] text-white hover:bg-green-800": variant === "primary", "border bg-white hover:bg-neutral-50": variant === "secondary", "hover:bg-black/5": variant === "ghost", "bg-red-600 text-white hover:bg-red-700": variant === "danger", "h-9 px-3 text-sm": size === "sm", "h-11 px-4": size === "md", "h-12 px-6": size === "lg" }, className)} {...props} />;
}
