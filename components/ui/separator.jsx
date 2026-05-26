import * as React from "react";

import { cn } from "@/lib/utils";

function Separator({ className, orientation = "horizontal", ...props }) {
  return (
    <div
      role="separator"
      className={cn(orientation === "vertical" ? "h-full w-px" : "h-px w-full", "shrink-0 bg-border", className)}
      {...props}
    />
  );
}

export { Separator };
