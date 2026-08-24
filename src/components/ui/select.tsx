import * as React from "react";
import { cn } from "@/lib/utils";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-10 w-full appearance-none rounded-lg border bg-white bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2369736d%22 stroke-width=%222.5%22 stroke-linecap=%22round%22><path d=%22M6 9l6 6 6-6%22/></svg>')] bg-[length:18px_18px] bg-[right_0.65rem_center] bg-no-repeat px-3 pr-9 outline-none transition focus:border-green-700 focus:ring-4 focus:ring-green-700/10 disabled:cursor-not-allowed disabled:bg-neutral-50",
      className,
    )}
    {...props}
  />
));
Select.displayName = "Select";
