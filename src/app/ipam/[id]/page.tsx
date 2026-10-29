import { requireUser } from "@/lib/auth/guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { calcSubnet } from "@/lib/ip/cidr";
import { getNetwork, listAddresses } from "@/lib/db/ipam";
import { listFields, listTags } from "@/lib/db/meta";
import { ApiError, type NetworkRow } from "@/lib/types";
import { format } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n/server";
import { formatCount } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { AddressManager } from "@/components/ipam/AddressManager";

export const dynamic = "force-dynamic";

function loadNetwork(id: number): NetworkRow | null {
  try {
    return getNetwork(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="label-caps">{label}</div>
      <div className="mt-1.5 text-xl font-bold text-fg">{value}</div>
    </div>
  );
}

export default async function IpamDetailPage(props: { params: Promise<{ id: string }> }) {
  requireUser();
  const params = await props.params;
  const { t, locale } = getDictionary();
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();

  const network = loadNetwork(id);
  const info = network ? calcSubnet(network.cidr) : null;
  if (!network || !info) notFound();

  const addresses = listAddresses(id);
  const counted = network.usedIps + network.reservedIps;
  const free = info.usable > BigInt(counted) ? info.usable - BigInt(counted) : 0n;
  const untracked = Math.max(0, counted - addresses.length);
  const s = t.ipam.detail.stats;

  return (
    <>
      <PageHeader
        title={network.cidr}
        subtitle={[network.name, network.siteName, network.vrfName ? `VRF ${network.vrfName}` : null].filter(Boolean).join(" · ")}
        actions={
          <Link href="/ipam" className="btn-ghost">
            <ArrowLeft className="h-4 w-4" />
            {t.ipam.back}
          </Link>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label={s.usable} value={formatCount(info.usable, locale)} />
        <Stat label={s.used} value={formatCount(BigInt(network.usedIps), locale)} />
        <Stat label={s.reserved} value={formatCount(BigInt(network.reservedIps), locale)} />
        <Stat label={s.free} value={formatCount(free, locale)} />
        <Stat label={s.inventoried} value={formatCount(BigInt(addresses.length), locale)} />
      </section>

      {untracked > 0 && (
        <p className="mb-4 rounded-md border border-line bg-panel2 px-3 py-2 text-xs text-muted">
          {format(t.ipam.detail.untracked, { n: formatCount(BigInt(untracked), locale) })}
        </p>
      )}

      <AddressManager
        network={network}
        addresses={addresses}
        allTags={listTags().map((x) => ({ name: x.name, color: x.color }))}
        fields={listFields("address")}
      />
    </>
  );
}
