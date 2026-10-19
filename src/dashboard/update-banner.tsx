import { ArrowUpCircle } from "lucide-react";
import { Spinner } from "./components/ui/spinner";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { shouldReload, type UpdateInfo } from "./update-info";
import { responseError } from "./utils";

// Bottom of the sidebar. `live` is the SSE state: after an install, a new live=true means the server restarted.
export function UpdateBanner({ live }: { live: boolean }) {
  const [info, setInfo] = useState<UpdateInfo>();
  // The version at click time: later /api/update refreshes must not change what the reload check compares to.
  const [from, setFrom] = useState<string>();
  const updating = from !== undefined;
  const [restarting, setRestarting] = useState(false);
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
      if (data.restarting) setRestarting(true);
      else {
        setError(data.message ?? "Nothing to update");
        setFrom(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFrom(undefined);
    }
  };

  if (!info) return null;
  if (!info.available) return <p className="border-t px-3 py-2 text-xs text-muted-foreground">Current version: {info.current}</p>;
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-3">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">Update available</span>
          <span className="truncate text-xs text-muted-foreground">{info.current} → {info.latest}</span>
        </div>
        {info.harness && (
          <Button size="xs" variant="outline" disabled={updating} onClick={install}>
            {updating && <Spinner />}
            {restarting ? "Restarting…" : updating ? "Updating…" : "Update & restart"}
          </Button>
        )}
      </div>
      {!info.harness && <p className="text-xs text-muted-foreground">Not installed through a plugin manager: update it with git.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
