"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Fenêtre modale : se ferme avec Échap ou en cliquant à côté. */
export function Modal({ title, closeLabel, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="card max-h-[92vh] w-full max-w-lg overflow-y-auto p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold text-fg">{title}</h2>
          <button onClick={onClose} aria-label={closeLabel} className="rounded-md p-1.5 text-muted hover:bg-panel2 hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
