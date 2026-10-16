import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

// Short delay so a quick reconnect (page load, server restart after an update) does not flash the alert.
const DELAY_MS = 2000;

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
      className="fixed bottom-14 left-3 z-50 flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
    >
      <TriangleAlert className="size-3 shrink-0" />
      Dashboard offline
    </div>
  );
}
