"use client";

import { useSyncExternalStore } from "react";
import { TOUR_COOKIE, parseTourCookie, tourCookieValue, type TourState } from "./steps";

/**
 * The tour's progress on the client. The tour is mounted once in the layout and survives navigation; "Take the tour"
 * buttons elsewhere start it through here. Kept in a cookie (per visitor, one day) so a reload or a server render
 * picks up where the visitor was, and read again when the tab comes back into focus, so two tabs agree.
 */

let current: TourState | null = null;
let focusWanted = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setTourState(next: TourState): void {
  current = next;
  try {
    document.cookie = `${TOUR_COOKIE}=${tourCookieValue(next)}; path=/; max-age=86400; samesite=lax`;
  } catch {
    /* cookies blocked: progress lasts for this page view */
  }
  emit();
}

/** Start at step 1, and have the card take focus when it appears. */
export function startTour(): void {
  focusWanted = true;
  setTourState({ status: "on", index: 0 });
}

/** True once after startTour: the card moves focus to its title. */
export function takeFocusRequest(): boolean {
  const w = focusWanted;
  focusWanted = false;
  return w;
}

/** The progress another tab may have written. */
export function syncFromCookie(): void {
  try {
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${TOUR_COOKIE}=`))?.slice(TOUR_COOKIE.length + 1);
    const next = parseTourCookie(raw);
    if (current && tourCookieValue(current) === tourCookieValue(next)) return;
    current = next;
    emit();
  } catch {
    /* cookies blocked */
  }
}

function onVisible(): void {
  if (document.visibilityState === "visible") syncFromCookie();
}

function subscribe(l: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("focus", syncFromCookie);
    document.addEventListener("visibilitychange", onVisible);
  }
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.removeEventListener("focus", syncFromCookie);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export function useTourState(initial: TourState): TourState {
  return useSyncExternalStore(
    subscribe,
    () => current ?? initial,
    () => initial,
  );
}
