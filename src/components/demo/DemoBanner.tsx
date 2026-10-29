"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

interface Props {
  name: string;
  networks: number;
  sites: number;
  vlans: number;
  vrfs: number;
}

const HIDE_KEY = "ipa-demo-banner-hidden";

/** Bandeau « vous explorez la démonstration » + action pour repartir de zéro avec ses propres données. */
export function DemoBanner({ name, networks, sites, vlans, vrfs }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const d = t.demo;
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [projectName, setProjectName] = useState(d.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      /* stockage indisponible : le bandeau reste affiché */
    }
  }, []);

  const hide = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* sans conséquence */
    }
  };

  const leave = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? d.failed);
      setOpen(false);
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : d.failed);
    } finally {
      setBusy(false);
    }
  };

  if (hidden && !open) return null;

  return (
    <>
      {!hidden && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-brand/40 bg-brand/10 px-4 py-3 text-sm text-fg">
          <FlaskConical className="h-4 w-4 shrink-0 text-brand" aria-hidden />
          <span className="min-w-[16rem] flex-1">{format(d.text, { name })}</span>
          <button className="btn-primary h-8 px-3 text-xs" onClick={() => setOpen(true)}>
            {d.leave}
          </button>
          <button className="btn-ghost h-8 px-3 text-xs" onClick={hide}>
            {d.hide}
          </button>
        </div>
      )}
      {open && (
        <Modal title={d.modalTitle} closeLabel={d.cancel} onClose={() => !busy && setOpen(false)}>
          <form onSubmit={leave} className="space-y-4 text-sm">
            <p className="text-fg2">{format(d.warning, { name, networks, sites, vlans, vrfs })}</p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">{d.nameLabel}</span>
              <input className="input" value={projectName} onChange={(e) => setProjectName(e.target.value)} maxLength={80} required autoFocus />
            </label>
            {error && (
              <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-bad">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
                {d.cancel}
              </button>
              <button type="submit" className="btn-primary" disabled={busy || !projectName.trim()}>
                {busy ? d.working : d.confirm}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
