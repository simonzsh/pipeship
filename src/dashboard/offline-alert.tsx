import { useEffect, useState } from "react";
import { ServerOff } from "lucide-react";

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
      className="fixed bottom-14 left-3 z-50 flex max-w-72 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive px-3 py-2.5 text-sm text-white shadow-lg"
    >
      <ServerOff className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col">
        <span className="font-medium">Dashboard offline</span>
        <span className="text-xs opacity-90">The server is no longer running. Restart it with the pipeship dashboard command.</span>
      </div>
    </div>
  );
}
