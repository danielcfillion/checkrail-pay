"use client";

import { useRouter } from "next/navigation";
import { startTour } from "./store";

/** Starts the judge tour at step 1, on the overview. */
export function TakeTourButton({ primary = false, size = "md" }: { primary?: boolean; size?: "sm" | "md" }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={`btn ${primary ? "btn-primary" : ""} ${size === "sm" ? "btn-sm" : ""}`}
      onClick={() => {
        startTour();
        router.push("/");
      }}
    >
      Take the tour
    </button>
  );
}
