import { useEffect, useState } from "react";
import type { StepStatus } from "../state.ts";
import { formatElapsed } from "./pipeline-info";
import { cn } from "./utils";

// "waiting" is a running step whose pipeline waits for the user: amber like the "Waiting for you" badge.
export type DotStatus = StepStatus | "waiting";

const STEP_DOT: Record<DotStatus, string> = {
  done: "bg-emerald-500",
  running: "bg-blue-500 animate-pulse",
  waiting: "bg-amber-500 animate-pulse",
  failed: "bg-red-500",
  pending: "bg-muted-foreground/25",
  skipped: "border border-dashed border-muted-foreground/50",
};

export interface DisplayStep {
  name: string;
  status: DotStatus;
  startedAt?: string;
  note?: string; // shown under a waiting step: the question to answer
}

// Ticks every second, so it only mounts under a running step.
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatElapsed(since, now)}</>;
}

export function Steps({ steps, compact }: { steps: DisplayStep[]; compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        {steps.map((step) => (
          <span key={step.name} title={`${step.name}: ${step.status}`} className={cn("size-2 rounded-full", STEP_DOT[step.status])} />
        ))}
      </div>
    );
  }
  // A link is green up to the furthest step reached, so skipped steps do not break the line.
  const reached = steps.findLastIndex((s) => s.status !== "pending" && s.status !== "skipped");
  return (
    <div className="grid grid-cols-7 items-start">
      {steps.map((step, i) => (
        <div key={step.name} className="relative flex flex-col items-center gap-1.5" title={`${step.name}: ${step.status}`}>
          {i < steps.length - 1 && (
            // Runs from the edge of this dot to the edge of the next one, so it never shows through a dot.
            <div
              className={cn(
                "absolute top-[5px] left-[calc(50%+10px)] h-0.5 w-[calc(100%-20px)] rounded-full",
                i < reached ? "bg-emerald-500" : "bg-muted-foreground/15",
              )}
            />
          )}
          <div className={cn("size-3 rounded-full", STEP_DOT[step.status])} />
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground capitalize",
              (step.status === "running" || step.status === "waiting") && "font-medium text-foreground",
              step.status === "skipped" && "line-through opacity-60",
            )}
          >
            {step.name}
          </span>
          {step.status === "running" && step.startedAt && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              <Elapsed since={step.startedAt} />
            </span>
          )}
          {step.status === "waiting" && step.note && (
            <span className="text-center text-[11px] leading-tight font-medium text-amber-700 dark:text-amber-400">{step.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}
