"use client";

import { signOffCloseAction } from "@/app/actions";
import { ConfirmButton } from "./ConfirmButton";

export function SignOffButton({ throughSeq, attention }: { throughSeq: number; attention: number }) {
  return (
    <ConfirmButton
      label="Sign off"
      busyLabel="Signing off"
      tone="primary"
      confirmText={attention ? `${attention} item${attention === 1 ? "" : "s"} above still need${attention === 1 ? "s" : ""} a look. Signing off records that you have seen them.` : "Records that you reviewed everything on this page."}
      action={() => signOffCloseAction(throughSeq)}
    />
  );
}
