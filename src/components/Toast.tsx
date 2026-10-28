"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; message: string; tone: "ok" | "error" };
type Ctx = { toast: (message: string, tone?: Toast["tone"]) => void };

const ToastContext = createContext<Ctx>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/** Minimal toasts: bottom left, one line, auto-dismiss, confirm in the same words as the button. */
export function ToastProvider({ children }: { children: ReactNode }) {
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
      <div className="pointer-events-none fixed bottom-16 left-4 z-50 flex flex-col gap-2 sm:bottom-4 md:left-[244px]" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto panel flex items-center gap-2 px-3 py-2 ${t.tone === "error" ? "border-blocked text-blocked" : ""}`} style={{ borderColor: t.tone === "error" ? "var(--blocked)" : undefined }}>
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: t.tone === "error" ? "var(--blocked)" : "var(--settled)" }} />
            <span>{t.message}</span>
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
