"use client";

import { useState } from "react";
import { calcSubnet } from "@/lib/ip/cidr";
import type { DhcpScopeRow } from "@/lib/types";
import { formatLease } from "@/lib/dhcp/lease";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/Modal";

export interface NetworkOption {
  id: number;
  cidr: string;
  name: string;
  /** Deux réseaux de même CIDR peuvent coexister dans des VRF différentes : on les distingue dans la liste. */
  vrfName: string | null;
}

interface Props {
  networks: NetworkOption[];
  initialNetworkId: number | null;
  /** Présent = mode modification : le réseau est figé. */
  scope?: DhcpScopeRow;
  onClose: () => void;
  onCreated: (scopeId: number) => void;
}

const LEASE_VALUES = ["3600", "14400", "28800", "86400", "604800", "2592000"] as const;

export function ScopeForm({ networks: allNetworks, initialNetworkId, scope, onClose, onCreated }: Props) {
  const { t } = useI18n();
  const f = t.dhcp.form;
  const editing = scope !== undefined;
  // en modification, le réseau de la plage est la seule option (il ne se change pas)
  const networks: NetworkOption[] = scope
    ? [{ id: scope.networkId, cidr: scope.networkCidr, name: scope.networkName, vrfName: null }]
    : allNetworks;

  const [networkId, setNetworkId] = useState(scope ? String(scope.networkId) : initialNetworkId !== null ? String(initialNetworkId) : "");
  const [name, setName] = useState(scope?.name ?? "");
  const [rangeStart, setRangeStart] = useState(scope?.rangeStart ?? "");
  const [rangeEnd, setRangeEnd] = useState(scope?.rangeEnd ?? "");
  const [gateway, setGateway] = useState(scope?.gateway ?? "");
  const [dns, setDns] = useState(scope ? scope.dns.join(", ") : "");
  const [lease, setLease] = useState(scope ? String(scope.leaseSeconds) : "86400");
  const [enabled, setEnabled] = useState(scope?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const network = networks.find((n) => String(n.id) === networkId);
  const info = network ? calcSubnet(network.cidr) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editing ? `/api/dhcp/scopes/${scope.id}` : "/api/dhcp/scopes", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(editing ? {} : { networkId: Number(networkId) }),
          name,
          rangeStart,
          rangeEnd,
          gateway: gateway || null,
          dns,
          leaseSeconds: Number(lease),
          enabled,
        }),
      });
      // le serveur renvoie déjà le message d'erreur dans la langue de l'utilisateur
      const data = (await res.json().catch(() => ({}))) as { error?: string; scope?: { id: number } };
      if (!res.ok || !data.scope) throw new Error(data.error ?? (editing ? f.saveFailed : f.createFailed));
      onCreated(data.scope.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : editing ? f.saveFailed : f.createFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? f.editTitle : f.title} closeLabel={f.close} onClose={onClose}>
      {networks.length === 0 ? (
        <p className="text-sm text-muted">{f.noNetworks}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label-caps mb-1.5 block" htmlFor="dhcp-network">
              {f.network}
            </label>
            <select
              id="dhcp-network"
              required
              disabled={editing}
              value={networkId}
              onChange={(e) => {
                setNetworkId(e.target.value);
                // suggestion : la passerelle est souvent la première adresse du réseau
                const n = networks.find((x) => String(x.id) === e.target.value);
                const i = n ? calcSubnet(n.cidr) : null;
                if (i && !gateway) setGateway(i.firstHost);
              }}
              className="input disabled:opacity-60"
            >
              <option value="">{f.networkPlaceholder}</option>
              {networks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.cidr} — {n.name}
                  {n.vrfName ? ` (${n.vrfName})` : ""}
                </option>
              ))}
            </select>
            {editing && <p className="mt-1 text-xs text-muted">{f.networkLocked}</p>}
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="dhcp-name">
              {f.name}
            </label>
            <input id="dhcp-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="dhcp-start">
                {f.rangeStart}
              </label>
              <input
                id="dhcp-start"
                required
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                placeholder={info?.firstHost ?? "10.0.0.100"}
                className="input font-mono"
              />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="dhcp-end">
                {f.rangeEnd}
              </label>
              <input
                id="dhcp-end"
                required
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                placeholder={info?.lastHost ?? "10.0.0.200"}
                className="input font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="dhcp-gateway">
                {f.gateway}
              </label>
              <input id="dhcp-gateway" value={gateway} onChange={(e) => setGateway(e.target.value)} className="input font-mono" />
            </div>
            <div>
              <label className="label-caps mb-1.5 block" htmlFor="dhcp-lease">
                {f.lease}
              </label>
              <select id="dhcp-lease" value={lease} onChange={(e) => setLease(e.target.value)} className="input">
                {!(LEASE_VALUES as readonly string[]).includes(lease) && (
                  <option value={lease}>{formatLease(Number(lease), t.dhcp.lease)}</option>
                )}
                {LEASE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {f.leaseOptions[v]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label-caps mb-1.5 block" htmlFor="dhcp-dns">
              {f.dns}
            </label>
            <input id="dhcp-dns" value={dns} onChange={(e) => setDns(e.target.value)} placeholder="1.1.1.1, 9.9.9.9" className="input font-mono" />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-brand" />
            {f.enabled}
          </label>

          {error && (
            <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              {f.cancel}
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? (editing ? f.saving : f.submitting) : editing ? f.save : f.submit}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
