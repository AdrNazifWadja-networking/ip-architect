/**
 * Placement automatique d'une topologie : les routeurs et pare-feu en haut, puis une rangée par « saut » (switchs, bornes, machines),
 * triés pour que les liens se croisent peu. Fonction pure : mêmes entrées, mêmes positions. Les positions choisies à la main l'emportent.
 */
import type { TopoKind } from "../topologyTypes";

export interface LNode { id: number; kind: TopoKind; x: number | null; y: number | null }
export interface LLink { aDevice: number; bDevice: number }

export const NODE_W = 150;
export const NODE_H = 64;
const GAP_X = 40;
const GAP_Y = 90;
const GAP_COMP = 120;

export interface Layout {
  pos: Map<number, { x: number; y: number }>;
  width: number;
  height: number;
}

const ROOT_KINDS: TopoKind[] = ["firewall", "router"];

export function layoutTopology(nodes: LNode[], links: LLink[]): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<number, number[]>(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    if (l.aDevice === l.bDevice || !byId.has(l.aDevice) || !byId.has(l.bDevice)) continue;
    adj.get(l.aDevice)!.push(l.bDevice);
    adj.get(l.bDevice)!.push(l.aDevice);
  }
  for (const [k, v] of adj) adj.set(k, [...new Set(v)].sort((a, b) => a - b));
  const degree = (id: number): number => adj.get(id)!.length;

  // composantes connexes, la plus grande d'abord
  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const n of [...nodes].sort((a, b) => a.id - b.id)) {
    if (seen.has(n.id)) continue;
    const comp: number[] = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const o of adj.get(id)!) if (!seen.has(o)) { seen.add(o); stack.push(o); }
    }
    comps.push(comp.sort((a, b) => a - b));
  }
  comps.sort((a, b) => b.length - a.length || a[0] - b[0]);

  const pos = new Map<number, { x: number; y: number }>();
  let offsetX = 0;
  let maxY = 0;
  for (const comp of comps) {
    // racines : routeurs et pare-feu ; à défaut, l'équipement le plus connecté
    let roots = comp.filter((id) => ROOT_KINDS.includes(byId.get(id)!.kind));
    if (roots.length === 0) roots = [[...comp].sort((a, b) => degree(b) - degree(a) || a - b)[0]];
    const layer = new Map<number, number>(roots.map((r) => [r, 0]));
    const queue = [...roots];
    for (let i = 0; i < queue.length; i++) for (const o of adj.get(queue[i])!) if (!layer.has(o)) { layer.set(o, layer.get(queue[i])! + 1); queue.push(o); }
    const rows: number[][] = [];
    for (const id of comp) (rows[layer.get(id)!] ??= []).push(id);
    // ordre initial : les plus connectés au centre n'ont pas d'importance ; on trie par identifiant puis on réduit les croisements (barycentre)
    const order = new Map<number, number>();
    rows.forEach((r) => { r.sort((a, b) => a - b); r.forEach((id, i) => order.set(id, i)); });
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let li = sweep % 2 === 0 ? 1 : rows.length - 2; li >= 0 && li < rows.length; li += sweep % 2 === 0 ? 1 : -1) {
        const ref = sweep % 2 === 0 ? li - 1 : li + 1;
        const bary = (id: number): number => {
          const ns = adj.get(id)!.filter((o) => layer.get(o) === ref);
          return ns.length ? ns.reduce((s, o) => s + order.get(o)!, 0) / ns.length : order.get(id)!;
        };
        rows[li].sort((a, b) => bary(a) - bary(b) || a - b);
        rows[li].forEach((id, i) => order.set(id, i));
      }
    }
    const widest = Math.max(...rows.map((r) => r.length));
    const compW = widest * NODE_W + (widest - 1) * GAP_X;
    rows.forEach((r, li) => {
      const rowW = r.length * NODE_W + (r.length - 1) * GAP_X;
      const start = offsetX + (compW - rowW) / 2;
      r.forEach((id, i) => pos.set(id, { x: start + i * (NODE_W + GAP_X), y: li * (NODE_H + GAP_Y) }));
      maxY = Math.max(maxY, li * (NODE_H + GAP_Y) + NODE_H);
    });
    offsetX += compW + GAP_COMP;
  }
  // positions choisies à la main
  for (const n of nodes) if (n.x !== null && n.y !== null) pos.set(n.id, { x: n.x, y: n.y });
  let width = 0, height = 0;
  for (const p of pos.values()) { width = Math.max(width, p.x + NODE_W); height = Math.max(height, p.y + NODE_H); }
  return { pos, width, height: Math.max(height, maxY) };
}

/** Rectangle englobant (marge comprise) pour cadrer la vue. */
export function bounds(pos: Map<number, { x: number; y: number }>, margin = 60): { x: number; y: number; w: number; h: number } {
  if (pos.size === 0) return { x: 0, y: 0, w: 600, h: 400 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pos.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + NODE_W); y1 = Math.max(y1, p.y + NODE_H); }
  return { x: x0 - margin, y: y0 - margin, w: x1 - x0 + 2 * margin, h: y1 - y0 + 2 * margin };
}
