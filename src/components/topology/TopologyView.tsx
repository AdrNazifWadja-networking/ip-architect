"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Cloud, Monitor, Phone, Router, Server, Shield, Wifi, Network as SwitchIcon } from "lucide-react";
import { layoutTopology, bounds, NODE_H, NODE_W } from "@/lib/topology/layout";
import { TOPO_KINDS, type DiscoverStatus, type TopoClient, type TopoCredential, type TopoDevice, type TopoKind, type TopoLink, type TopologyData } from "@/lib/topologyTypes";
import { format } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

async function call<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data;
}

const ICON: Record<TopoKind, typeof Router> = { router: Router, firewall: Shield, switch: SwitchIcon, ap: Wifi, server: Server, host: Monitor, phone: Phone, network: Cloud, other: Box };
/** Une classe de bordure par type : la couleur seule ne porte jamais l'information (icône et libellé l'accompagnent). */
const STROKE: Record<TopoKind, string> = {
  router: "stroke-brand", firewall: "stroke-bad", switch: "stroke-ok", ap: "stroke-warn", server: "stroke-brand-soft", host: "stroke-muted", phone: "stroke-muted", network: "stroke-brand", other: "stroke-line",
};
const TEXT: Record<TopoKind, string> = {
  router: "text-brand", firewall: "text-bad", switch: "text-ok", ap: "text-warn", server: "text-brand-soft", host: "text-muted", phone: "text-muted", network: "text-brand", other: "text-muted",
};
const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function TopologyView({ initial, networks, canEdit, isAdmin }: { initial: TopologyData; networks: Array<{ id: number; cidr: string; name: string }>; canEdit: boolean; isAdmin: boolean }) {
  const { t, locale } = useI18n();
  const s = t.topology;
  const [data, setData] = useState<TopologyData>(initial);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ device: TopoDevice; clients: TopoClient[] } | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFirst, setLinkFirst] = useState<number | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ a: number; b: number; aPort: string; bPort: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<{ name: string; kind: TopoKind; address: string; info: string }>({ name: "", kind: "switch", address: "", info: "" });
  const [edit, setEdit] = useState<{ name: string; kind: TopoKind; address: string; info: string } | null>(null);
  const [query, setQuery] = useState("");
  const [creds, setCreds] = useState<TopoCredential[]>([]);
  const [seed, setSeed] = useState("");
  const [credId, setCredId] = useState<number | "">("");
  const [netId, setNetId] = useState<number | "">(networks[0]?.id ?? "");
  const [depth, setDepth] = useState(3);
  const [disc, setDisc] = useState<DiscoverStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointer = useRef<{ kind: "pan" | "node"; id?: number; startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const wasRunning = useRef(false);

  const reload = useCallback(async () => {
    const d = await call<TopologyData>("/api/topology", "GET", undefined, s.failed);
    setData(d);
    return d;
  }, [s.failed]);

  const layout = useMemo(
    () => layoutTopology(data.devices.map((d) => ({ id: d.id, kind: d.kind, x: d.x, y: d.y })), data.links),
    [data],
  );
  const pos = useCallback((id: number) => (drag && drag.id === id ? { x: drag.x, y: drag.y } : layout.pos.get(id) ?? { x: 0, y: 0 }), [drag, layout]);
  const deviceName = (id: number): string => data.devices.find((d) => d.id === id)?.name ?? String(id);

  const fit = useCallback(() => setView(bounds(layout.pos)), [layout]);
  // Tant que l'utilisateur n'a ni zoomé ni déplacé la vue, on recadre dès que le schéma change (nombre d'équipements ou taille).
  const touched = useRef(false);
  const count = data.devices.length;
  useEffect(() => { if (!touched.current) fit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [count, layout.width, layout.height]);
  const refit = () => { touched.current = false; fit(); };

  useEffect(() => {
    if (!canEdit) return;
    call<{ credentials: TopoCredential[] }>("/api/topology/credentials", "GET", undefined, s.failed)
      .then((r) => setCreds(r.credentials))
      .catch(() => setCreds([]));
  }, [canEdit, s.failed]);

  // suivi de la découverte : une lecture par seconde tant qu'elle tourne ; à la fin, on relit le schéma
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await call<{ discovery: DiscoverStatus }>("/api/topology/discover", "GET", undefined, s.failed);
        if (stop) return;
        setDisc(r.discovery);
        if (r.discovery.status === "running") { wasRunning.current = true; timer = setTimeout(tick, 1000); }
        else if (wasRunning.current) { wasRunning.current = false; await reload(); }
      } catch { /* la page reste utilisable sans le suivi */ }
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [s.failed, reload, disc?.status === "running" ? 1 : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected === null) { setDetail(null); setEdit(null); return; }
    let stop = false;
    call<{ device: TopoDevice; clients: TopoClient[] }>(`/api/topology/devices/${selected}`, "GET", undefined, s.failed)
      .then((r) => { if (stop) return; setDetail(r); setEdit({ name: r.device.name, kind: r.device.kind, address: r.device.address ?? "", info: r.device.info ?? "" }); })
      .catch((e) => { if (!stop) { setSelected(null); setError(e instanceof Error ? e.message : s.failed); } });
    return () => { stop = true; };
  }, [selected, data, s.failed]);

  const run = async (fn: () => Promise<string | null | void>) => {
    setBusy(true); setError(null); setInfo(null);
    try { const m = await fn(); if (m) setInfo(m); }
    catch (e) { setError(e instanceof Error ? e.message : s.failed); }
    finally { setBusy(false); }
  };

  /* ---------- souris : panoramique, zoom, glisser un équipement ---------- */
  const toSvg = (cx: number, cy: number): { x: number; y: number } => {
    const el = svgRef.current;
    const ctm = el?.getScreenCTM();
    if (!el || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!view) return;
    touched.current = true;
    const k = e.deltaY < 0 ? 0.88 : 1 / 0.88;
    const p = toSvg(e.clientX, e.clientY);
    const w = Math.min(Math.max(view.w * k, 200), 40000), h = view.h * (w / view.w);
    setView({ x: p.x - ((p.x - view.x) / view.w) * w, y: p.y - ((p.y - view.y) / view.h) * h, w, h });
  };
  const zoom = (k: number) => {
    if (!view) return;
    touched.current = true;
    setView({ x: view.x + (view.w * (1 - k)) / 2, y: view.y + (view.h * (1 - k)) / 2, w: view.w * k, h: view.h * k });
  };
  const onDown = (e: React.PointerEvent, id?: number) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    const p = toSvg(e.clientX, e.clientY);
    if (id !== undefined) { const o = pos(id); pointer.current = { kind: "node", id, startX: p.x, startY: p.y, origX: o.x, origY: o.y, moved: false }; }
    else if (view) pointer.current = { kind: "pan", startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const g = pointer.current;
    if (!g || !view) return;
    if (g.kind === "pan") {
      touched.current = true;
      const el = svgRef.current!;
      const sc = view.w / el.clientWidth;
      setView({ ...view, x: g.origX - (e.clientX - g.startX) * sc, y: g.origY - (e.clientY - g.startY) * sc });
      return;
    }
    const p = toSvg(e.clientX, e.clientY);
    if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) < 4) return;
    if (!canEdit || linkMode) return;
    g.moved = true;
    touched.current = true; // on déplace un équipement : plus de recadrage automatique
    setDrag({ id: g.id!, x: g.origX + p.x - g.startX, y: g.origY + p.y - g.startY });
  };
  const onUp = () => {
    const g = pointer.current;
    pointer.current = null;
    if (!g || g.kind !== "node") return;
    if (g.moved && drag) {
      const d = drag;
      setDrag(null);
      void run(async () => {
        await call("/api/topology/positions", "POST", { positions: [{ id: d.id, x: Math.round(d.x), y: Math.round(d.y) }] }, s.failed);
        await reload();
      });
      return;
    }
    clickNode(g.id!);
  };
  const clickNode = (id: number) => {
    if (linkMode) {
      if (linkFirst === null) setLinkFirst(id);
      else if (linkFirst !== id) { setLinkDraft({ a: linkFirst, b: id, aPort: "", bPort: "" }); setLinkMode(false); setLinkFirst(null); }
      return;
    }
    setSelected(id);
  };

  /* ---------- actions ---------- */
  const startNetwork = () => run(async () => {
    const body: Record<string, unknown> = { networkId: netId, depth };
    if (credId !== "") body.credentialId = credId;
    const r = await call<{ discovery: DiscoverStatus }>("/api/topology/discover", "POST", body, s.failed);
    wasRunning.current = true;
    setDisc(r.discovery);
  });
  const startDiscovery = (address?: string) => run(async () => {
    const r = await call<{ discovery: DiscoverStatus }>("/api/topology/discover", "POST", { seed: address ?? seed.trim(), credentialId: credId === "" ? creds[0]?.id : credId, depth }, s.failed);
    wasRunning.current = true;
    setDisc(r.discovery);
  });
  const cancelDiscovery = () => run(async () => { await call("/api/topology/discover", "DELETE", undefined, s.failed); });
  const createDevice = () => run(async () => {
    const body: Record<string, unknown> = { name: draft.name, kind: draft.kind };
    if (draft.address.trim()) body.address = draft.address.trim();
    if (draft.info.trim()) body.info = draft.info.trim();
    await call("/api/topology/devices", "POST", body, s.failed);
    setDraft({ name: "", kind: "switch", address: "", info: "" });
    setAddOpen(false);
    await reload();
    return s.created;
  });
  const saveDevice = () => run(async () => {
    await call(`/api/topology/devices/${selected}`, "PATCH", { name: edit!.name, kind: edit!.kind, address: edit!.address.trim() || null, info: edit!.info.trim() || null }, s.failed);
    await reload();
    return s.saved;
  });
  const unpin = () => run(async () => { await call(`/api/topology/devices/${selected}`, "PATCH", { x: null, y: null }, s.failed); await reload(); });
  const resetLayout = () => run(async () => { await call("/api/topology/positions", "POST", { reset: true }, s.failed); await reload(); });
  const deleteDevice = () => {
    if (!window.confirm(s.panel.confirmDelete)) return;
    void run(async () => { await call(`/api/topology/devices/${selected}`, "DELETE", undefined, s.failed); setSelected(null); await reload(); return s.removed; });
  };
  const deleteLink = (id: number) => {
    if (!window.confirm(s.panel.confirmLink)) return;
    void run(async () => { await call(`/api/topology/links/${id}`, "DELETE", undefined, s.failed); await reload(); return s.removed; });
  };
  const createLink = () => run(async () => {
    const d = linkDraft!;
    await call("/api/topology/links", "POST", { aDevice: d.a, bDevice: d.b, aPort: d.aPort.trim() || null, bPort: d.bPort.trim() || null }, s.failed);
    setLinkDraft(null);
    await reload();
    return s.created;
  });

  const q = query.trim().toLowerCase();
  const matches = (d: TopoDevice): boolean => !q || d.name.toLowerCase().includes(q) || (d.address ?? "").includes(q) || (d.chassisId ?? "").toLowerCase().includes(q);
  const running = disc?.status === "running";
  const date = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-FR" : "en-GB");
  const linksOf = (id: number): TopoLink[] => data.links.filter((l) => l.aDevice === id || l.bDevice === id);

  // plusieurs liens entre les mêmes équipements : on les écarte un peu
  const lineOffset = (l: TopoLink): number => {
    const same = data.links.filter((o) => o.aDevice === l.aDevice && o.bDevice === l.bDevice);
    return (same.indexOf(l) - (same.length - 1) / 2) * 14;
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">{s.intro}</p>
      {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
      {info && <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">{info}</div>}

      {canEdit && (
        <section className="card space-y-3 p-5" aria-label={s.discover.title}>
          <h2 className="card-title">{s.discover.title}</h2>
          {networks.length === 0 ? <p className="text-sm text-muted">{s.discover.noNetworks}</p> : (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="label-caps mb-1.5 block">{s.discover.network}</span>
                <select className="input min-w-[260px]" value={netId} onChange={(e) => setNetId(e.target.value === "" ? "" : Number(e.target.value))} disabled={running}>
                  <option value="">{s.discover.networkChoose}</option>
                  {networks.map((n) => <option key={n.id} value={n.id}>{n.cidr} — {n.name}</option>)}
                </select>
              </label>
              {creds.length > 0 && (
                <label className="block">
                  <span className="label-caps mb-1.5 block">{s.discover.credential}</span>
                  <select className="input" value={credId} onChange={(e) => setCredId(e.target.value === "" ? "" : Number(e.target.value))} disabled={running}>
                    <option value="">{s.discover.allCredentials}</option>
                    {creds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="label-caps mb-1.5 block">{s.discover.depth}</span>
                <select className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={running}>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button className="btn-primary" disabled={busy || running || netId === ""} onClick={startNetwork}>{busy && !running ? s.discover.starting : s.discover.startNetwork}</button>
              {running && <button className="btn-secondary" disabled={busy} onClick={cancelDiscovery}>{s.discover.cancel}</button>}
            </div>
          )}
          {creds.length === 0 && <p className="text-xs text-muted">{s.discover.noSnmp}</p>}
          {creds.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-muted">{s.discover.advanced}</summary>
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="label-caps mb-1.5 block">{s.discover.seed}</span>
                  <input className="input w-48 font-mono" placeholder="192.168.1.1" value={seed} onChange={(e) => setSeed(e.target.value)} disabled={running} />
                </label>
                <button className="btn-secondary" disabled={busy || running || !seed.trim()} onClick={() => startDiscovery()}>{s.discover.start}</button>
              </div>
              <p className="mt-1 text-xs text-muted">{s.discover.seedHint}</p>
            </details>
          )}
          <div aria-live="polite" className="space-y-1 text-sm">
            {running && disc && (
              <div className="text-fg">
                {disc.phase === "scan" ? format(s.discover.scanning, { visited: String(disc.visited), devices: String(disc.devices) })
                  : disc.phase === "merge" ? s.discover.merging
                  : disc.seed && disc.seed.includes("/") ? format(s.discover.snmpPhase, { visited: String(disc.visited), total: String(disc.visited + disc.queued), devices: String(disc.devices) })
                  : format(s.discover.running, { visited: String(disc.visited), queued: String(disc.queued), devices: String(disc.devices) })}
              </div>
            )}
            {!running && disc?.status === "done" && <div className="text-fg">{format(s.discover.done, { devices: String(disc.devices), links: String(disc.links), clients: String(disc.clients) })}</div>}
            {!running && disc?.status === "cancelled" && <div className="text-warn">{s.discover.cancelled}</div>}
            {!running && disc?.status === "failed" && <div className="text-bad">{s.discover.failed}</div>}
            {!running && disc?.notes.slice(0, 8).map((n) => <div key={n} className="text-warn">{n === "limit" ? s.discover.limit : format(s.discover.note, { note: n })}</div>)}
          </div>
        </section>
      )}

      {isAdmin && <CredentialsCard creds={creds} onChange={setCreds} />}

      <section className="card p-3" aria-label={s.title}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input className="input w-52" placeholder={s.toolbar.filter} aria-label={s.toolbar.filter} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn-secondary" onClick={() => zoom(0.8)} aria-label={s.toolbar.zoomIn}>+</button>
          <button className="btn-secondary" onClick={() => zoom(1.25)} aria-label={s.toolbar.zoomOut}>−</button>
          <button className="btn-secondary" onClick={refit}>{s.toolbar.fit}</button>
          {canEdit && (
            <>
              <button className="btn-secondary" onClick={() => setAddOpen((v) => !v)}>{s.toolbar.addDevice}</button>
              <button className="btn-secondary" onClick={() => { setLinkMode((v) => !v); setLinkFirst(null); }}>{linkMode ? s.toolbar.linkCancel : s.toolbar.addLink}</button>
              <button className="btn-secondary" disabled={busy} onClick={resetLayout}>{s.toolbar.reset}</button>
            </>
          )}
          <span className="ml-auto text-xs text-muted">{format(s.stats, { devices: String(data.devices.length), links: String(data.links.length) })}</span>
        </div>
        {linkMode && <p className="mb-2 text-sm text-brand-soft">{s.toolbar.linkHint}{linkFirst !== null ? ` — ${deviceName(linkFirst)}` : ""}</p>}

        {addOpen && canEdit && (
          <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-line p-3">
            <label className="block"><span className="label-caps mb-1.5 block">{s.form.name}</span><input className="input w-44" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} /></label>
            <label className="block"><span className="label-caps mb-1.5 block">{s.form.kind}</span>
              <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TopoKind })}>{TOPO_KINDS.map((k) => <option key={k} value={k}>{s.kinds[k]}</option>)}</select></label>
            <label className="block"><span className="label-caps mb-1.5 block">{s.form.address}</span><input className="input w-40 font-mono" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} /></label>
            <label className="block"><span className="label-caps mb-1.5 block">{s.form.info}</span><input className="input w-56" value={draft.info} onChange={(e) => setDraft({ ...draft, info: e.target.value })} maxLength={300} /></label>
            <button className="btn-primary" disabled={busy || !draft.name.trim()} onClick={createDevice}>{s.form.create}</button>
            <button className="btn-secondary" onClick={() => setAddOpen(false)}>{s.form.cancel}</button>
          </div>
        )}

        {linkDraft && canEdit && (
          <div className="mb-3 flex flex-wrap items-end gap-3 rounded-md border border-line p-3">
            <div className="text-sm font-medium">{format(s.form.linkTitle, { a: deviceName(linkDraft.a), b: deviceName(linkDraft.b) })}</div>
            <label className="block"><span className="label-caps mb-1.5 block">{format(s.form.aPort, { name: deviceName(linkDraft.a) })}</span><input className="input w-36" value={linkDraft.aPort} onChange={(e) => setLinkDraft({ ...linkDraft, aPort: e.target.value })} maxLength={60} /></label>
            <label className="block"><span className="label-caps mb-1.5 block">{format(s.form.bPort, { name: deviceName(linkDraft.b) })}</span><input className="input w-36" value={linkDraft.bPort} onChange={(e) => setLinkDraft({ ...linkDraft, bPort: e.target.value })} maxLength={60} /></label>
            <button className="btn-primary" disabled={busy} onClick={createLink}>{s.form.createLink}</button>
            <button className="btn-secondary" onClick={() => setLinkDraft(null)}>{s.form.cancel}</button>
          </div>
        )}

        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="min-w-0 flex-1">
            {data.devices.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted">{s.empty}</p>
            ) : (
              <svg
                ref={svgRef} role="img" aria-label={s.title}
                className="h-[620px] w-full touch-none rounded-md border border-line bg-panel2 select-none"
                viewBox={view ? `${view.x} ${view.y} ${view.w} ${view.h}` : "0 0 600 400"}
                onWheel={onWheel} onPointerDown={(e) => onDown(e)} onPointerMove={onMove} onPointerUp={onUp}
              >
                {data.links.map((l) => {
                  const a = pos(l.aDevice), b = pos(l.bDevice);
                  const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H / 2, x2 = b.x + NODE_W / 2, y2 = b.y + NODE_H / 2;
                  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
                  const off = lineOffset(l), ox = (-dy / len) * off, oy = (dx / len) * off;
                  // les noms de ports se posent près de chaque extrémité (hors du rectangle de l'équipement)
                  const near = (x: number, y: number, tx: number, ty: number): { x: number; y: number } => {
                    const k = Math.min(1, (NODE_H / 2 + 14) / (Math.abs(ty - y) || 1));
                    return { x: x + (tx - x) * Math.min(k, 0.45), y: y + (ty - y) * Math.min(k, 0.45) };
                  };
                  const pa = near(x1 + ox, y1 + oy, x2 + ox, y2 + oy), pb = near(x2 + ox, y2 + oy, x1 + ox, y1 + oy);
                  const dim = q && !(matches(data.devices.find((d) => d.id === l.aDevice)!) || matches(data.devices.find((d) => d.id === l.bDevice)!));
                  return (
                    <g key={l.id} opacity={dim ? 0.25 : 1}>
                      <title>{`${deviceName(l.aDevice)}${l.aPort ? ` (${l.aPort})` : ""} ↔ ${deviceName(l.bDevice)}${l.bPort ? ` (${l.bPort})` : ""}${l.speedMbps ? ` — ${format(s.panel.speed, { mbps: String(l.speedMbps) })}` : ""}${l.source === "manual" ? ` — ${s.panel.manualLink}` : ""}`}</title>
                      <line x1={x1 + ox} y1={y1 + oy} x2={x2 + ox} y2={y2 + oy} className={l.source === "manual" ? "stroke-muted" : "stroke-brand-soft"} strokeWidth={(l.speedMbps ?? 0) >= 10000 ? 4 : 2} strokeDasharray={l.source === "manual" ? "6 4" : undefined} />
                      {l.aPort && <text x={pa.x} y={pa.y} textAnchor="middle" className="fill-fg2" fontSize={11} paintOrder="stroke" strokeWidth={3} stroke="rgb(var(--panel2))">{short(l.aPort, 14)}</text>}
                      {l.bPort && <text x={pb.x} y={pb.y} textAnchor="middle" className="fill-fg2" fontSize={11} paintOrder="stroke" strokeWidth={3} stroke="rgb(var(--panel2))">{short(l.bPort, 14)}</text>}
                    </g>
                  );
                })}
                {data.devices.map((d) => {
                  const p = pos(d.id);
                  const Icon = ICON[d.kind];
                  const sel = selected === d.id || linkFirst === d.id;
                  return (
                    <g key={d.id} transform={`translate(${p.x} ${p.y})`} opacity={matches(d) ? 1 : 0.25} className={canEdit && !linkMode ? "cursor-grab" : "cursor-pointer"}
                      tabIndex={0} role="button" aria-label={`${d.name} — ${s.kinds[d.kind]}`}
                      onPointerDown={(e) => onDown(e, d.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clickNode(d.id); } }}>
                      <title>{`${d.name} (${s.kinds[d.kind]})${d.address ? ` — ${d.address}` : ""}`}</title>
                      <rect width={NODE_W} height={NODE_H} rx={10} className={`fill-panel ${sel ? "stroke-fg" : STROKE[d.kind]}`} strokeWidth={sel ? 3 : 2} strokeDasharray={d.source === "lldp" ? "5 3" : undefined} />
                      <Icon x={10} y={12} width={26} height={26} className={TEXT[d.kind]} />
                      <text x={44} y={26} fontSize={13} fontWeight={600} className="fill-fg">{short(d.name, 15)}</text>
                      <text x={44} y={43} fontSize={11} className="fill-muted">{d.address ?? s.kinds[d.kind]}</text>
                      {d.clientCount > 0 && (
                        <g transform={`translate(${NODE_W - 8} 8)`}>
                          <circle r={11} className="fill-brand" />
                          <text textAnchor="middle" y={4} fontSize={11} fontWeight={700} fill="#fff">{d.clientCount > 99 ? "99+" : d.clientCount}</text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>
            )}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted" aria-label={s.toolbar.legend}>
              {TOPO_KINDS.map((k) => { const I = ICON[k]; return <span key={k} className="flex items-center gap-1"><I className={`h-4 w-4 ${TEXT[k]}`} />{s.kinds[k]}</span>; })}
            </div>
          </div>

          {selected !== null && detail && edit && (
            <aside className="w-full shrink-0 space-y-3 rounded-md border border-line p-4 text-sm lg:w-80" aria-label={detail.device.name}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="card-title break-all">{detail.device.name}</h2>
                <button className="btn-ghost" onClick={() => setSelected(null)} aria-label={s.panel.close}>×</button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted">{s.panel.kind}</dt><dd>{s.kinds[detail.device.kind]}</dd>
                <dt className="text-muted">{s.panel.address}</dt><dd className="font-mono">{detail.device.address ?? s.panel.none}</dd>
                <dt className="text-muted">{s.panel.source}</dt><dd>{s.sources[detail.device.source]}</dd>
                {detail.device.chassisId && (<><dt className="text-muted">ID</dt><dd className="break-all font-mono text-xs">{detail.device.chassisId}</dd></>)}
                {detail.device.lastSeenAt && (<><dt className="text-muted">{s.panel.lastSeen}</dt><dd>{date(detail.device.lastSeenAt)}</dd></>)}
                {detail.device.info && (<><dt className="text-muted">{s.panel.info}</dt><dd className="break-words">{detail.device.info}</dd></>)}
              </dl>

              {canEdit && (
                <div className="space-y-2 border-t border-line pt-3">
                  <label className="block"><span className="label-caps mb-1 block">{s.panel.name}</span><input className="input w-full" value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
                  <label className="block"><span className="label-caps mb-1 block">{s.panel.kind}</span>
                    <select className="input w-full" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as TopoKind })}>{TOPO_KINDS.map((k) => <option key={k} value={k}>{s.kinds[k]}</option>)}</select></label>
                  <label className="block"><span className="label-caps mb-1 block">{s.panel.address}</span><input className="input w-full font-mono" value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></label>
                  <label className="block"><span className="label-caps mb-1 block">{s.panel.info}</span><input className="input w-full" value={edit.info} maxLength={300} onChange={(e) => setEdit({ ...edit, info: e.target.value })} /></label>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary" disabled={busy || !edit.name.trim()} onClick={saveDevice}>{s.panel.save}</button>
                    {detail.device.x !== null && <button className="btn-secondary" disabled={busy} onClick={unpin}>{s.panel.unpin}</button>}
                    {detail.device.address && creds.length > 0 && !running && (
                      <button className="btn-secondary" disabled={busy} onClick={() => startDiscovery(detail.device.address!)}>{s.panel.rediscover}</button>
                    )}
                    <button className="btn-secondary text-bad" disabled={busy} onClick={deleteDevice}>{s.panel.delete}</button>
                  </div>
                </div>
              )}

              <div className="border-t border-line pt-3">
                <h3 className="label-caps mb-1.5">{s.panel.links}</h3>
                {linksOf(detail.device.id).length === 0 ? <p className="text-muted">{s.panel.noLinks}</p> : (
                  <ul className="space-y-1">
                    {linksOf(detail.device.id).map((l) => {
                      const mine = l.aDevice === detail.device.id;
                      const other = mine ? l.bDevice : l.aDevice;
                      return (
                        <li key={l.id} className="flex items-start justify-between gap-2">
                          <span>
                            <button className="text-brand-soft underline" onClick={() => setSelected(other)}>{deviceName(other)}</button>
                            <span className="block text-xs text-muted">{(mine ? l.aPort : l.bPort) ?? "?"} ↔ {(mine ? l.bPort : l.aPort) ?? "?"}{l.speedMbps ? ` · ${format(s.panel.speed, { mbps: String(l.speedMbps) })}` : ""}{l.source === "manual" ? ` · ${s.panel.manualLink}` : ` · ${l.source.toUpperCase()}`}</span>
                          </span>
                          {canEdit && <button className="btn-ghost text-bad" onClick={() => deleteLink(l.id)} aria-label={s.panel.removeLink}>×</button>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {detail.device.ports.length > 0 && (
                <details className="border-t border-line pt-3">
                  <summary className="label-caps cursor-pointer">{s.panel.ports} — {format(s.panel.portsCount, { count: String(detail.device.ports.length) })}</summary>
                  <ul className="mt-2 max-h-48 space-y-0.5 overflow-auto text-xs">
                    {detail.device.ports.map((p) => (
                      <li key={p.name} className="flex justify-between gap-2">
                        <span className="font-mono">{p.name}</span>
                        <span className={p.up === false ? "text-muted" : p.up ? "text-ok" : "text-muted"}>{p.up === null ? "" : p.up ? s.panel.portUp : s.panel.portDown}{p.speedMbps ? ` · ${format(s.panel.speed, { mbps: String(p.speedMbps) })}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="border-t border-line pt-3">
                <h3 className="label-caps mb-1.5">{s.panel.clients}</h3>
                {detail.clients.length === 0 ? <p className="text-muted">{s.panel.noClients}</p> : (
                  <div className="max-h-56 overflow-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-muted"><th className="pr-2">{s.panel.port}</th><th className="pr-2">{s.panel.mac}</th><th>{s.panel.ip}</th></tr></thead>
                      <tbody>
                        {detail.clients.map((c) => (
                          <tr key={c.mac}><td className="pr-2 font-mono">{c.port ?? ""}</td><td className="pr-2 font-mono">{c.mac}</td><td className="font-mono">{c.ip ?? ""}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}

function CredentialsCard({ creds, onChange }: { creds: TopoCredential[]; onChange: (c: TopoCredential[]) => void }) {
  const { t } = useI18n();
  const s = t.topology;
  const [name, setName] = useState("");
  const [community, setCommunity] = useState("");
  const [port, setPort] = useState("161");
  const [edits, setEdits] = useState<Record<number, { name: string; community: string; port: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => onChange((await call<{ credentials: TopoCredential[] }>("/api/topology/credentials", "GET", undefined, s.failed)).credentials);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : s.failed); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    await call("/api/topology/credentials", "POST", { name, community, port: Number(port) }, s.failed);
    setName(""); setCommunity(""); setPort("161");
  });

  return (
    <details className="card p-5">
      <summary className="card-title cursor-pointer">{s.credentials.title} ({creds.length})</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-warn">{s.credentials.warning}</p>
        {error && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        {creds.length === 0 && <p className="text-sm text-muted">{s.credentials.none}</p>}
        {creds.map((c) => {
          const e = edits[c.id] ?? { name: c.name, community: "", port: String(c.port) };
          const set = (v: Partial<typeof e>) => setEdits({ ...edits, [c.id]: { ...e, ...v } });
          return (
            <div key={c.id} className="flex flex-wrap items-end gap-2">
              <label className="block"><span className="label-caps mb-1 block">{s.credentials.name}</span><input className="input w-40" value={e.name} onChange={(ev) => set({ name: ev.target.value })} /></label>
              <label className="block"><span className="label-caps mb-1 block">{s.credentials.community}</span><input className="input w-48" type="password" autoComplete="off" placeholder={s.credentials.communityKeep} value={e.community} onChange={(ev) => set({ community: ev.target.value })} /></label>
              <label className="block"><span className="label-caps mb-1 block">{s.credentials.port}</span><input className="input w-20" inputMode="numeric" value={e.port} onChange={(ev) => set({ port: ev.target.value })} /></label>
              <button className="btn-secondary" disabled={busy} onClick={() => run(async () => { await call(`/api/topology/credentials/${c.id}`, "PATCH", { name: e.name, community: e.community, port: Number(e.port) }, s.failed); setEdits({ ...edits, [c.id]: { ...e, community: "" } }); })}>{s.credentials.save}</button>
              <button className="btn-secondary text-bad" disabled={busy} onClick={() => { if (window.confirm(s.credentials.confirmDelete)) void run(async () => { await call(`/api/topology/credentials/${c.id}`, "DELETE", undefined, s.failed); }); }}>{s.credentials.delete}</button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="block"><span className="label-caps mb-1 block">{s.credentials.name}</span><input className="input w-40" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
          <label className="block"><span className="label-caps mb-1 block">{s.credentials.community}</span><input className="input w-48" type="password" autoComplete="new-password" value={community} onChange={(e) => setCommunity(e.target.value)} maxLength={128} /></label>
          <label className="block"><span className="label-caps mb-1 block">{s.credentials.port}</span><input className="input w-20" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></label>
          <button className="btn-primary" disabled={busy || !name.trim() || !community} onClick={add}>{s.credentials.add}</button>
        </div>
      </div>
    </details>
  );
}
