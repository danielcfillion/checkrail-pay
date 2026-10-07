"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { pauseAutopilotAction } from "@/app/actions";
import { useToast } from "./Toast";

/** One click, no confirmation: stopping should never be slow. */
export function PauseButton({ paused }: { paused: boolean }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  return (
    <button
      type="button"
      className={`btn btn-sm ${paused ? "" : "btn-danger"}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await pauseAutopilotAction(!paused);
          toast(r.message, r.ok ? "ok" : "error");
          router.refresh();
        })
      }
    >
      {paused ? "Resume" : "Pause"}
    </button>
  );
}
