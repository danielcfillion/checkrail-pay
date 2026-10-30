"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; message: string; tone: "ok" | "error" };
type Ctx = { toast: (message: string, tone?: Toast["tone"]) => void };

const ToastContext = createContext<Ctx>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/** Minimal toasts: bottom centre of the content (above the phone nav and action bar), one line, auto-dismiss, confirm in the same words as the button. */
export function ToastProvider({ children, bare = false }: { children: ReactNode; /** Public vendor pages have no bottom nav or action bar to clear. */ bare?: boolean }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const toast = useCallback((message: string, tone: Toast["tone"] = "ok") => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4500);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={`pointer-events-none fixed inset-x-4 z-50 flex flex-col items-center gap-2 ${bare ? "bottom-6" : "bottom-[116px] md:bottom-20 md:left-16 md:right-0 lg:bottom-6 lg:left-[220px]"}`} aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          // An error is told by an icon and the word "Error" as well as the colour, and is announced as an alert.
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="pointer-events-auto panel flex items-start gap-2 px-3 py-2" style={{ borderColor: t.tone === "error" ? "var(--blocked)" : undefined, color: t.tone === "error" ? "var(--blocked)" : undefined }}>
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke={t.tone === "error" ? "currentColor" : "var(--settled)"} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0">
              <circle cx="9" cy="9" r="7.25" />
              {t.tone === "error" ? <path d="M6.5 6.5l5 5M11.5 6.5l-5 5" /> : <path d="M5.75 9.25l2.25 2.25 4.25-4.75" />}
            </svg>
            <span>
              {t.tone === "error" ? <span className="font-semibold">Error: </span> : null}
              {t.message}
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Lets server-rendered pages hand a message to the toast rail via a search param. */
export function ToastFromParam({ message, tone = "ok" }: { message: string | null | undefined; tone?: Toast["tone"] }) {
  const { toast } = useToast();
  const fired = useRef(false);
  useEffect(() => {
    if (message && !fired.current) {
      fired.current = true;
      toast(message, tone);
    }
  }, [message, tone, toast]);
  return null;
}
