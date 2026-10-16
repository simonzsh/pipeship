import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

// Short delay so a quick reconnect (page load, server restart after an update) does not flash the alert.
const DELAY_MS = 2000;

// In the sidebar flow, above the version footer: it scrolls and resizes with the page instead of floating over it.
export function OfflineAlert({ live }: { live: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (live) return setShow(false);
    const timer = setTimeout(() => setShow(true), DELAY_MS);
    return () => clearTimeout(timer);
  }, [live]);
  if (!show) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 border-t border-destructive/40 bg-destructive/15 px-3 py-2.5 text-sm font-medium text-destructive"
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/40" />
        <TriangleAlert className="relative size-3.5" />
      </span>
      Dashboard offline
    </div>
  );
}
