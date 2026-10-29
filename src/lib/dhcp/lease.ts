import { format } from "../i18n";
import { splitLease } from "./config";

export interface LeaseUnits {
  d: string;
  h: string;
  m: string;
  s: string;
}

/** 90 000 s -> « 1 j 1 h » (les unités viennent du dictionnaire : fonctionne côté serveur et côté client). */
export function formatLease(seconds: number, units: LeaseUnits): string {
  const { d, h, m, s } = splitLease(seconds);
  const parts: string[] = [];
  if (d) parts.push(format(units.d, { n: d }));
  if (h) parts.push(format(units.h, { n: h }));
  if (m) parts.push(format(units.m, { n: m }));
  if (s || parts.length === 0) parts.push(format(units.s, { n: s }));
  return parts.join(" ");
}
