"use client";

import { resetDemoAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";

export function ResetDemoButton({ size = "md" }: { size?: "sm" | "md" }) {
  return <ConfirmButton label="Reset demo" busyLabel="Resetting" confirmText="This replaces every record with the demo story." action={() => resetDemoAction()} size={size} />;
}
