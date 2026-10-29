import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { authEnabled } from "@/lib/db/users";
import { isSignupOpen } from "@/lib/db/signupsettings";
import { isResetAvailable } from "@/lib/db/passwordreset";
import { currentUser } from "@/lib/auth/guard";
import { getLoginOptions } from "@/lib/db/ssosettings";
import { SSO_ERROR_CODES } from "@/lib/ssoTypes";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";

/** Page publique. Déjà connecté, ou connexion non activée : retour à l'accueil. */
export default async function LoginPage(props: { searchParams: Promise<{ next?: string; sso?: string }> }) {
  const searchParams = await props.searchParams;
  if (!authEnabled(getDb()) || currentUser()) redirect("/");
  // redirection après connexion : uniquement vers un chemin de ce site (jamais « //autre.site » ni une URL complète)
  const next = searchParams.next && /^\/(?![/\\])/.test(searchParams.next) ? searchParams.next : "/";
  const o = getLoginOptions();
  // code d'erreur du retour OpenID Connect : uniquement une valeur connue (jamais du texte venu de l'adresse)
  const ssoError = (SSO_ERROR_CODES as readonly string[]).includes(searchParams.sso ?? "") ? searchParams.sso : undefined;
  return <LoginForm next={next} signup={isSignupOpen()} reset={isResetAvailable()} oidcLabel={o.oidc?.label ?? null} ssoError={ssoError} />;
}
