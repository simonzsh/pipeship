import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { shouldReload, type UpdateInfo } from "./update-info";
import { ThemeToggle } from "./theme";
import { cn, responseError } from "./utils";

// Bottom of the sidebar: live state, theme, version and update. `live` is the SSE state: after an install, a new live=true means the server restarted.
export function SidebarFooter({ live }: { live: boolean }) {
  const [info, setInfo] = useState<UpdateInfo>();
  // The version at click time: later /api/update refreshes must not change what the reload check compares to.
  const [from, setFrom] = useState<string>();
  const updating = from !== undefined;
  const [error, setError] = useState<string>();
  const wasLive = useRef(live);

  // One lookup on mount, then on tab focus and every 10 minutes: the server caches GitHub as long.
  useEffect(() => {
    const load = () =>
      fetch("/api/update").then((r) => (r.ok ? r.json() : undefined)).then((d) => d && setInfo(d), () => {});
    const onVisible = () => document.visibilityState === "visible" && load();
    load();
    const timer = setInterval(load, 600_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Check the version on each SSE reconnect, and every 500 ms as a fallback if the restart was too quick to see.
  useEffect(() => {
    if (from === undefined) return;
    const check = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((h) => shouldReload(from, h.version) && location.reload(), () => {});
    if (live && !wasLive.current) check();
    wasLive.current = live;
    const timer = setInterval(check, 500);
    return () => clearInterval(timer);
  }, [live, from]);

  const install = async () => {
    setError(undefined);
    setFrom(info?.current ?? "");
    wasLive.current = live;
    try {
      const res = await fetch("/api/update/install", { method: "POST" });
      if (!res.ok) throw new Error(await responseError(res));
      const data: { restarting?: boolean; message?: string } = await res.json();
      if (!data.restarting) {
        setError(data.message ?? "Nothing to update");
        setFrom(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFrom(undefined);
    }
  };

  const title = info?.available
    ? updating
      ? "Updating…"
      : info.harness
      ? `Update available: ${info.current} → ${info.latest}. Click to update and restart`
      : `Update to ${info.latest} with git`
    : undefined;
  return (
    <div className="flex flex-col gap-1 border-t px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          {live ? "Live" : "Offline"}
        </span>
        <ThemeToggle />
        {info && <span className="text-xs text-muted-foreground">v{info.current}</span>}
        {info?.available && (
          <Button
            variant="ghost"
            size="icon"
            className="relative ml-auto size-7"
            // aria-disabled keeps the git hint focusable; a disabled button hides it from keyboard users.
            aria-disabled={updating || !info.harness}
            onClick={() => !updating && info.harness && install()}
            title={title}
            aria-label={title}
          >
            <RefreshCw className={cn("size-3.5", updating && "animate-spin")} />
            {info.harness && !updating && <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />}
          </Button>
        )}
      </div>
      {error && <p className="truncate text-xs text-destructive" title={error}>{error}</p>}
    </div>
  );
}
