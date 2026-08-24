import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, rows = 3, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={rows}
    className={cn("w-full rounded-lg border bg-white px-3 py-2.5 outline-none transition focus:border-green-700 focus:ring-4 focus:ring-green-700/10", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";
