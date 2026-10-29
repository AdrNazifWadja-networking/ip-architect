import type { Locale } from "../i18n";
import { requiredAccess } from "../auth/policy";
import { API_ENTRIES } from "./api";
import { docsFr } from "./content.fr";
import { docsEn } from "./content.en";
import type { ApiDoc, DocSection } from "./types";

const SECTIONS: Record<Locale, DocSection[]> = { fr: docsFr, en: docsEn };

/** « /api/networks/:id » -> « /api/networks/[id] » (forme utilisée par la politique d'accès et par les fichiers route.ts). */
export function toRoutePath(path: string): string {
  return path.replace(/:(\w+)/g, "[$1]");
}

export function getApiDocs(locale: Locale): ApiDoc[] {
  return API_ENTRIES.map((e) => {
    const access = requiredAccess(e.method, toRoutePath(e.path));
    return { method: e.method, path: e.path, access, description: e[locale] };
  });
}

export function getDocs(locale: Locale): { sections: DocSection[]; api: ApiDoc[] } {
  return { sections: SECTIONS[locale], api: getApiDocs(locale) };
}
