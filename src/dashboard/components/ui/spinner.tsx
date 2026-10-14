import { Loader2 } from "lucide-react";
import { cn } from "../../utils";

// The one loader icon: the spin lives here, so a restyle changes one file.
export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return <Loader2 role="status" aria-label={label} className={cn("animate-spin", className)} />;
}
