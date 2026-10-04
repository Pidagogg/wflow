import { useCallback, useRef, useState } from "react";

export function useToast() {
  const [toast, setToast] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  return { toast, show };
}

export function Toast({ toast }: { toast: { msg: string; kind: "ok" | "err" } | null }) {
  if (!toast) return null;
  return (
    <div
      className={`toast ${toast.kind === "err" ? "err" : ""}`}
      role={toast.kind === "err" ? "alert" : "status"}
      aria-live={toast.kind === "err" ? "assertive" : "polite"}
    >
      <span className="toast-mark" aria-hidden="true">{toast.kind === "err" ? "!" : "✓"}</span>
      <span>{toast.msg}</span>
    </div>
  );
}
