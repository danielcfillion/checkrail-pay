"use client";

import { useSyncExternalStore } from "react";
import { TOUR_COOKIE, tourCookieValue, type TourState } from "./steps";

/**
 * The tour's progress on the client. The tour is mounted once in the layout and survives navigation; "Take the tour"
 * buttons elsewhere start it through here. Kept in a cookie (per visitor, one day) so a reload or a server render
 * picks up where the visitor was.
 */

let current: TourState | null = null;
const listeners = new Set<() => void>();

export function setTourState(next: TourState): void {
  current = next;
  try {
    document.cookie = `${TOUR_COOKIE}=${tourCookieValue(next)}; path=/; max-age=86400; samesite=lax`;
  } catch {
    /* cookies blocked: progress lasts for this page view */
  }
  for (const l of listeners) l();
}

export function startTour(): void {
  setTourState({ status: "on", index: 0 });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTourState(initial: TourState): TourState {
  return useSyncExternalStore(
    subscribe,
    () => current ?? initial,
    () => initial,
  );
}
