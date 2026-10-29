import { requireUser } from "@/lib/auth/guard";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

/** Compte « à projets choisis » auquel aucun projet n'est encore attribué. */
export default function NoProjectPage() {
  requireUser("viewer", { projectless: true });
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.access.noProjectTitle} subtitle="" />
      <div className="card max-w-2xl p-5 text-sm text-fg2">{t.access.noProjectBody}</div>
    </>
  );
}
