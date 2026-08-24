import * as React from "react";
import { cn } from "@/lib/utils";
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cn("h-10 w-full rounded-lg border bg-white px-3 outline-none transition focus:border-green-700 focus:ring-4 focus:ring-green-700/10", className)} {...props} />); Input.displayName = "Input";
