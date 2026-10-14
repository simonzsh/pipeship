import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { siClaude } from "simple-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import type { Session, State, T3Thread } from "../state.ts";
import { cn } from "./utils";

export function resumeCommand(s: Session): string {
  const cwd = /^[\w./~-]+$/.test(s.cwd) ? s.cwd : `'${s.cwd.replace(/'/g, `'\\''`)}'`;
  return s.harness === "claude" ? `cd ${cwd} && claude --resume ${s.id}` : `cd ${cwd} && codex resume ${s.id}`;
}

// Borderless and smaller than the action buttons above: the session links stay secondary.
const SESSION_BUTTON = "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// navigator.clipboard needs a secure origin; the dashboard may be open on a LAN IP.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// The ChatGPT knot; simple-icons dropped it, this path comes from @lobehub/icons (MIT).
const CHATGPT = { title: "ChatGPT", path: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" };

// The provider logo; a click copies the resume command, so the card needs no session row.
export function AgentLogo({ p }: { p: State }) {
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Reset the icon after 1.5 s; clean up if the card unmounts first.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const session = p.session;
  if (typeof session?.id !== "string") return null;
  const claude = session.harness === "claude";
  const name = claude ? "Claude Code" : "Codex";
  const icon = claude ? siClaude : CHATGPT;
  const cmd = resumeCommand(session);
  // Hand-edited state may hold anything: only offer a command for a real session id.
  const canResume = UUID.test(session.id);
  return (
    // Radix closes the tooltip on click: keep it open while it says "Copied".
    <Tooltip open={hovered || copied} onOpenChange={setHovered}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={canResume ? `Copy the command to resume the ${name} session` : `${name} session`}
          aria-disabled={!canResume}
          className={cn(
            SESSION_BUTTON,
            canResume ? "cursor-pointer hover:bg-accent hover:text-foreground" : "cursor-default",
          )}
          onClick={async (e) => {
            e.stopPropagation();
            if (!canResume) return;
            if (await copyText(cmd)) setCopied(true);
            else window.prompt("Copy the resume command", cmd);
          }}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            // Claude in its brand orange; the ChatGPT logo is black or white, so it follows the text colour.
            <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5 text-foreground" style={{ color: claude ? `#${siClaude.hex}` : undefined }}>
              <path d={icon.path} />
            </svg>
          )}
          {canResume && (copied ? "Copied" : "Copy session")}
        </button>
      </TooltipTrigger>
      <TooltipContent onClick={(e) => e.stopPropagation()}>
        {!canResume ? `${name} session` : copied ? "Copied" : "Copy resume command"}
      </TooltipContent>
    </Tooltip>
  );
}

// The T3 Code mark, from apps/mobile/assets/widget/T3Mark.svg in pingdotgg/t3code (MIT).
const T3_MARK = "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";

export function t3ThreadLink(t: T3Thread): string {
  return `t3code://threads/${encodeURIComponent(t.environmentId)}/${encodeURIComponent(t.threadId)}`;
}

// The T3 Code desktop app opens this link on the thread that runs the pipeline (T3 Code 0.0.46 or later).
export function T3ThreadButton({ thread }: { thread: T3Thread }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={t3ThreadLink(thread)}
          aria-label="Open the thread in T3 Code"
          className={cn(SESSION_BUTTON, "hover:bg-accent hover:text-foreground")}
          onClick={(e) => e.stopPropagation()}
        >
          {/* The mark is black in T3 Code: follow the text colour, like the ChatGPT logo. */}
          <svg viewBox="7 29 111 74" fill="currentColor" className="h-3 w-auto text-foreground">
            <path d={T3_MARK} />
          </svg>
          Open
        </a>
      </TooltipTrigger>
      <TooltipContent>Open in T3 Code</TooltipContent>
    </Tooltip>
  );
}
