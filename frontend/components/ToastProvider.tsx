"use client";

import React, { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { CheckCircle2, AlertTriangle, X, Info } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-3 rounded-lg border p-4 shadow-lg transition-all animate-in slide-in-from-right-5 fade-in duration-300 ${
              t.type === "success"
                ? "border-emerald-500/30 bg-[#0a0a0a] text-emerald-400"
                : t.type === "error"
                ? "border-red-500/30 bg-[#0a0a0a] text-red-400"
                : "border-[#c8a951]/30 bg-[#0a0a0a] text-[#c8a951]"
            }`}
          >
            {t.type === "success" && <CheckCircle2 className="h-5 w-5 shrink-0" />}
            {t.type === "error" && <AlertTriangle className="h-5 w-5 shrink-0" />}
            {t.type === "info" && <Info className="h-5 w-5 shrink-0" />}
            <p className="text-sm font-medium text-zinc-100 pr-4">{t.message}</p>
            <button
              onClick={() => setToasts((prev) => prev.filter((toast) => toast.id !== t.id))}
              className="ml-auto p-1 rounded hover:bg-zinc-800 transition-colors text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
