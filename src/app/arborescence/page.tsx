import { requireUser } from "@/lib/auth/guard";
import { listNetworks } from "@/lib/db/queries";
import { listVrfs } from "@/lib/db/vrf";
import { buildTree } from "@/lib/ip/tree";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { TreeView } from "@/components/networks/TreeView";

export const dynamic = "force-dynamic";

export default async function ArborescencePage(props: { searchParams: Promise<{ vrf?: string }> }) {
  requireUser();
  const searchParams = await props.searchParams;
  const { t } = getDictionary();
  const vrfs = listVrfs();
  // ?vrf=none -> table globale ; ?vrf=3 -> VRF n° 3 ; autre -> toutes, une arborescence par VRF
  const raw = searchParams.vrf;
  const only = raw === "none" ? "none" : raw && /^\d+$/.test(raw) && vrfs.some((v) => v.id === Number(raw)) ? Number(raw) : undefined;
  const networks = listNetworks({ vrf: only });

  const groups: { key: string; title: string; roots: ReturnType<typeof buildTree> }[] = [];
  const global = networks.filter((n) => n.vrfId === null);
  if (global.length > 0) groups.push({ key: "global", title: t.tree.global, roots: buildTree(global) });
  for (const v of vrfs) {
    const list = networks.filter((n) => n.vrfId === v.id);
    if (list.length > 0) groups.push({ key: `vrf-${v.id}`, title: `VRF ${v.name}`, roots: buildTree(list) });
  }

  return (
    <>
      <PageHeader title={t.tree.title} subtitle={t.tree.subtitle} />
      <TreeView groups={groups} vrfs={vrfs.map((v) => ({ id: v.id, name: v.name }))} selected={only === undefined ? "" : String(only)} />
    </>
  );
}
