import { requireUser } from "@/lib/auth/guard";
import { getSsoConfig } from "@/lib/db/ssosettings";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { SsoSettings } from "@/components/settings/SsoSettings";

export const dynamic = "force-dynamic";

/** Connexion unique (OpenID Connect) et annuaire (LDAP) : administrateur. */
export default function SsoPage() {
  requireUser("admin");
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.sso.title} subtitle={t.sso.subtitle} />
      <SsoSettings config={getSsoConfig()} />
    </>
  );
}
