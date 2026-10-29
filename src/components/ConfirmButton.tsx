"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./Toast";
import type { ActionResult } from "@/app/actions";

type Props = {
  /** Button text. The confirmation step reuses it. */
  label: string;
  busyLabel?: string;
  /** Explains what will happen. Shown in the inline confirm step. */
  confirmText: string;
  action: () => Promise<ActionResult>;
  tone?: "default" | "primary" | "danger";
  size?: "sm" | "md";
  onDone?: (result: ActionResult) => void;
  children?: ReactNode;
  className?: string;
};

/**
 * Two-step button: click, confirm inline, run. No modal. Toasts the result
 * in the action's own words and refreshes the route.
 */
export function ConfirmButton({ label, busyLabel, confirmText, action, tone = "default", size = "md", onDone, className = "" }: Props) {
  const [arm, setArm] = useState(false);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const toneClass = tone === "primary" ? "btn-primary" : tone === "danger" ? "btn-danger" : "";
  const sizeClass = size === "sm" ? "btn-sm" : "";

  if (!arm) {
    return (
      <button type="button" className={`btn ${toneClass} ${sizeClass} ${className}`} onClick={() => setArm(true)} disabled={pending}>
        {pending ? busyLabel ?? label : label}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm: ${label}`}>
      <span className="max-w-prose text-ink-soft" role="status">{confirmText}</span>
      <button
        type="button"
        className={`btn ${toneClass} ${sizeClass}`}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await action();
            toast(r.message, r.ok ? "ok" : "error");
            setArm(false);
            onDone?.(r);
            router.refresh();
          })
        }
      >
        {pending ? busyLabel ?? label : `Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
      </button>
      <button type="button" className={`btn ${sizeClass}`} onClick={() => setArm(false)} disabled={pending}>
        Keep as is
      </button>
    </span>
  );
}
