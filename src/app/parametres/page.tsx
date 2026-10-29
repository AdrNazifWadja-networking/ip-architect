import { requireUser } from "@/lib/auth/guard";
import { getAppSettings, getDatabaseInfo } from "@/lib/db/appsettings";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getSignupConfig } from "@/lib/db/signupsettings";
import { getAlertConfig } from "@/lib/db/alerts";
import { AlertSettings } from "@/components/settings/AlertSettings";
import { SignupSettings } from "@/components/settings/SignupSettings";
import { SettingsView } from "@/components/settings/SettingsView";

export const dynamic = "force-dynamic";

export default function ParametresPage() {
  requireUser("admin");
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.settings.title} subtitle={t.settings.subtitle} />
      <SettingsView settings={getAppSettings()} database={getDatabaseInfo()} />
      <AlertSettings initial={getAlertConfig()} />
      <SignupSettings initial={getSignupConfig()} />
    </>
  );
}
