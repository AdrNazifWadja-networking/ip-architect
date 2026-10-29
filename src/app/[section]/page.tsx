import { requireUser } from "@/lib/auth/guard";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Hammer } from "lucide-react";
import { labelKeyForSlug } from "@/lib/nav";
import { format } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

/** Écran générique pour les modules du menu qui ne sont pas encore développés. */
export default async function ComingSoon(props: { params: Promise<{ section: string }> }) {
  requireUser("viewer", { projectless: true });
  const params = await props.params;
  const { t } = getDictionary();
  const key = labelKeyForSlug(params.section);
  if (!key) notFound();
  const label = t.nav.items[key];

  return (
    <>
      <PageHeader title={label} subtitle={t.comingSoon.subtitle} />
      <div className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/15">
          <Hammer className="h-6 w-6 text-brand-soft" />
        </div>
        <div>
          <p className="text-base font-semibold text-fg">{format(t.comingSoon.heading, { name: label })}</p>
          <p className="mt-1 max-w-md text-sm text-muted">{t.comingSoon.body}</p>
        </div>
        <Link href="/reseaux" className="btn-primary">
          {t.comingSoon.cta}
        </Link>
      </div>
    </>
  );
}
