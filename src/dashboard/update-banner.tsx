import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { responseError, shouldReload, type UpdateInfo } from "./update-info";

const REFRESH_MS = 600_000;

// Bottom of the sidebar. `live` is the SSE state: after an install, a new live=true means the server restarted.
export function UpdateBanner({ live }: { live: boolean }) {
  const [info, setInfo] = useState<UpdateInfo>();
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string>();
  const wasLive = useRef(live);
  const oldVersion = useRef<string | undefined>(undefined);

  useEffect(() => {
    const load = () =>
      fetch("/api/update").then((r) => (r.ok ? r.json() : undefined)).then((d) => d && setInfo(d), () => {});
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // Check the version on each SSE reconnect, and every 3 s as a fallback if the restart was too quick to see.
  useEffect(() => {
    if (!updating) return;
    const check = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((h) => shouldReload(oldVersion.current ?? "", h.version) && location.reload(), () => {});
    if (live && !wasLive.current) check();
    wasLive.current = live;
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, [live, updating]);

  const install = async () => {
    setError(undefined);
    setUpdating(true);
    oldVersion.current = info?.current ?? "";
    wasLive.current = live;
    try {
      const res = await fetch("/api/update/install", { method: "POST" });
      if (!res.ok) throw new Error(await responseError(res));
      const data: { restarting?: boolean; message?: string } = await res.json();
      if (!data.restarting) {
        setError(data.message ?? "Nothing to update");
        setUpdating(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUpdating(false);
    }
  };

  if (!info?.available) return null;
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-3">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="size-4 shrink-0 text-violet-600 dark:text-violet-400" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">Update available</span>
          <span className="truncate text-xs text-muted-foreground">{info.current} → {info.latest}</span>
        </div>
        {info.harness && (
          <Button size="xs" disabled={updating} onClick={install}>
            {updating && <Loader2 className="animate-spin" />}
            {updating ? "Restarting…" : "Update & restart"}
          </Button>
        )}
      </div>
      {info.harness && !updating && <p className="text-xs text-muted-foreground">The dashboard restarts. Test environments and pipelines keep running.</p>}
      {!info.harness && <p className="text-xs text-muted-foreground">Not installed through a plugin manager: update it with git.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
