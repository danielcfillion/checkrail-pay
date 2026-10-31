"use client";

import { resetDemoAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";

/** `mine`: sandbox mode, where each browser has its own copy, so this starts over in that copy only. */
export function ResetDemoButton({ size = "md", mine = false }: { size?: "sm" | "md"; mine?: boolean }) {
  if (mine) return <ConfirmButton label="Start over" busyLabel="Starting over" confirmText="Start over puts the four opening requests back in your copy of the demo. Nobody else is affected." action={() => resetDemoAction()} size={size} />;
  return <ConfirmButton label="Reset demo" busyLabel="Resetting" confirmText="Everyone using this demo shares it. Reset puts the four opening requests back for all of them." action={() => resetDemoAction()} size={size} />;
}
