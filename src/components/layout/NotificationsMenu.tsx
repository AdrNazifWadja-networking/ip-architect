"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check } from "lucide-react";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { NotificationItem, NotificationsData } from "@/lib/notifTypes";
import { useDismiss } from "./useDismiss";

const POLL_MS = 60_000;

/** Liste des notifications (sans état : testable seule). */
export function NotificationList({ data, onRead, onNavigate }: { data: NotificationsData; onRead: (id: string) => void; onNavigate: () => void }) {
  const { t } = useI18n();
  const n = t.notifCenter;
  if (data.items.length === 0) return <p className="px-4 py-6 text-center text-sm text-muted">{n.empty}</p>;
  return (
    <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
      {data.items.map((it: NotificationItem) => (
        <li key={it.id} className={it.read ? "flex items-start gap-2 px-3 py-2.5 opacity-60" : "flex items-start gap-2 bg-brand/5 px-3 py-2.5"}>
          <span
            className={it.severity === "critical" ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-bad" : "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warn"}
            title={n.severity[it.severity]}
            aria-label={n.severity[it.severity]}
          />
          <Link
            href={it.href}
            onClick={() => {
              if (!it.read) onRead(it.id);
              onNavigate();
            }}
            className="min-w-0 flex-1 text-[13px] leading-snug text-fg2 hover:text-fg"
          >
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{n.severity[it.severity]}</span>
            <span className="break-words">{format(t.monitoring.findings[it.kind], it.params)}</span>
          </Link>
          {!it.read && (
            <button type="button" onClick={() => onRead(it.id)} className="shrink-0 rounded p-1 text-muted hover:bg-panel2 hover:text-fg" aria-label={n.markOne} title={n.markOne}>
              <Check className="h-4 w-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function NotificationsMenu({ initialUnread, iconBtn }: { initialUnread: number; iconBtn: string }) {
  const { t } = useI18n();
  const n = t.notifCenter;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<NotificationsData | null>(null);
  const [unread, setUnread] = useState(initialUnread);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  // la page serveur a recalculé le nombre : on le reprend à chaque navigation
  useEffect(() => setUnread(initialUnread), [initialUnread]);

  const apply = (d: NotificationsData) => {
    setData(d);
    setUnread(d.unread);
    setFailed(false);
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      apply((await res.json()) as NotificationsData);
    } catch {
      setFailed(true);
    }
  }, []);

  // rafraîchissement toutes les minutes, seulement si l'onglet est visible
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const read = async (body: { ids: string[] } | { all: true }) => {
    try {
      const res = await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) apply((await res.json()) as NotificationsData);
    } catch {
      setFailed(true);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={iconBtn}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={format(t.header.notifications, { n: unread })}
        title={unread > 0 ? format(n.unread, { n: unread }) : n.title}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold leading-none text-white ring-2 ring-bg">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label={n.title} className="absolute right-0 top-full z-50 mt-1.5 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
            <div>
              <p className="text-sm font-semibold text-fg">{n.title}</p>
              <p className="text-[11px] text-muted">{n.subtitle}</p>
            </div>
            {unread > 0 && (
              <button type="button" onClick={() => void read({ all: true })} className="rounded-md border border-line px-2 py-1 text-[11px] text-fg2 hover:bg-panel2">
                {n.markAll}
              </button>
            )}
          </div>
          {failed && !data ? (
            <p role="alert" className="px-4 py-6 text-center text-sm text-bad">{n.loadFailed}</p>
          ) : data ? (
            <>
              <NotificationList data={data} onRead={(id) => void read({ ids: [id] })} onNavigate={close} />
              {data.total > data.items.length && <p className="border-t border-line px-3 py-2 text-[11px] text-muted">{format(n.more, { n: data.total - data.items.length })}</p>}
              {data.total > 0 && data.unread === 0 && <p className="border-t border-line px-3 py-2 text-[11px] text-muted">{format(n.allRead, { n: data.total })}</p>}
            </>
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted">…</p>
          )}
          <Link href="/supervision" onClick={close} className="block border-t border-line px-3 py-2.5 text-center text-sm font-medium text-brand-soft hover:bg-panel2">
            {n.viewAll}
          </Link>
        </div>
      )}
    </div>
  );
}
