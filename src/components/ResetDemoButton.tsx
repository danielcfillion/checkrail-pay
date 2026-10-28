"use client";

import { resetDemoAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";

export function ResetDemoButton({ size = "md" }: { size?: "sm" | "md" }) {
  return <ConfirmButton label="Reset demo" busyLabel="Resetting" confirmText="Everyone using this demo shares it. Reset puts the four opening requests back for all of them." action={() => resetDemoAction()} size={size} />;
}
