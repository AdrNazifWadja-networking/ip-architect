import { requireUser } from "@/lib/auth/guard";
import { getDictionary } from "@/lib/i18n/server";
import { getDocs } from "@/lib/docs";
import { PageHeader } from "@/components/PageHeader";
import { DocumentationView } from "@/components/docs/DocumentationView";

export const dynamic = "force-dynamic";

/** Lisible par tout compte connecté (ou par tout le monde tant que l'application est ouverte). */
export default function DocumentationPage() {
  requireUser("viewer", { projectless: true });
  const { t, locale } = getDictionary();
  const docs = getDocs(locale);
  return (
    <>
      <PageHeader title={t.docs.title} subtitle={t.docs.subtitle} />
      <DocumentationView sections={docs.sections} api={docs.api} />
    </>
  );
}
