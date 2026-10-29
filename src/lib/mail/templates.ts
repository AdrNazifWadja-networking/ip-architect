/** Textes des e-mails (texte brut, FR/EN). Aucune donnée saisie par un tiers n'y figure, hors le nom d'affichage de la personne. */
import type { Locale } from "../i18n";
import type { MailMessage } from "./smtp";

type Body = Omit<MailMessage, "to">;

export function codeMail(locale: Locale, code: string, minutes: number, name: string): Body {
  // le nom est celui que la personne a saisi : une seule ligne, sans caractère de contrôle, borné
  const who = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
  return locale === "en"
    ? {
        subject: "Your IP Architect verification code",
        text: `Hello ${who},\n\nYour verification code is: ${code}\n\nIt is valid for ${minutes} minutes. After that, you have to start the sign-up again.\n\nIf you did not ask for an account, ignore this message: nothing will be created.\n`,
      }
    : {
        subject: "Votre code de vérification IP Architect",
        text: `Bonjour ${who},\n\nVotre code de vérification est : ${code}\n\nIl est valable ${minutes} minutes. Passé ce délai, il faut recommencer l'inscription.\n\nSi vous n'avez pas demandé de compte, ignorez ce message : rien ne sera créé.\n`,
      };
}

export function alreadyRegisteredMail(locale: Locale): Body {
  return locale === "en"
    ? {
        subject: "IP Architect: this address already has an account",
        text: "Someone asked to create an IP Architect account with this address, which already has one.\n\nIf it was you, sign in with your existing account. If you forgot your password, ask an administrator to reset it.\nIf it was not you, ignore this message.\n",
      }
    : {
        subject: "IP Architect : cette adresse a déjà un compte",
        text: "Quelqu'un a demandé la création d'un compte IP Architect avec cette adresse, qui en possède déjà un.\n\nSi c'était vous, connectez-vous avec votre compte existant. Mot de passe oublié : demandez sa réinitialisation à un administrateur.\nSi ce n'était pas vous, ignorez ce message.\n",
      };
}

export function testMail(locale: Locale): Body {
  return locale === "en"
    ? { subject: "IP Architect: test message", text: "This is a test message from IP Architect. Your mail settings work.\n" }
    : { subject: "IP Architect : message de test", text: "Ceci est un message de test d'IP Architect. Vos réglages d'envoi fonctionnent.\n" };
}

export function resetCodeMail(locale: Locale, code: string, minutes: number): Body {
  return locale === "en"
    ? {
        subject: "IP Architect: your password reset code",
        text: `Someone asked to reset the password of the IP Architect account linked to this address.\n\nYour code is: ${code}\n\nIt is valid for ${minutes} minutes and works once. Enter it on the reset page, together with your new password.\n\nIf you did not ask for this, ignore this message: your password has not changed.\n`,
      }
    : {
        subject: "IP Architect : votre code de réinitialisation du mot de passe",
        text: `Quelqu'un a demandé la réinitialisation du mot de passe du compte IP Architect lié à cette adresse.\n\nVotre code est : ${code}\n\nIl est valable ${minutes} minutes et ne sert qu'une fois. Saisissez-le sur la page de réinitialisation, avec votre nouveau mot de passe.\n\nSi vous n'avez rien demandé, ignorez ce message : votre mot de passe n'a pas changé.\n`,
      };
}

export interface AlertLine {
  project: string;
  severity: "critical" | "warning";
  text: string;
  href: string;
}

/** Résumé des nouveaux problèmes de supervision. Les textes viennent des contrôles de l'application (noms de réseaux, de projets). */
export function alertMail(locale: Locale, lines: AlertLine[], more: number): Body {
  const clean = (x: string) => x.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  const crit = lines.filter((l) => l.severity === "critical").length;
  const en = locale === "en";
  const label = (s: "critical" | "warning") => (en ? (s === "critical" ? "CRITICAL" : "WARNING") : s === "critical" ? "CRITIQUE" : "AVERTISSEMENT");
  const body = lines.map((l) => `- [${label(l.severity)}] ${clean(l.project)} : ${clean(l.text)}\n  ${l.href}`).join("\n");
  const total = lines.length + more;
  const tail = more > 0 ? (en ? `\n… and ${more} more.` : `\n… et ${more} autre(s).`) : "";
  return en
    ? {
        subject: `IP Architect: ${total} new problem(s)${crit ? ` (${crit} critical)` : ""}`,
        text: `IP Architect detected ${total} new problem(s):\n\n${body}${tail}\n\nEach problem is reported once while it lasts; it is reported again if it goes away and comes back.\nChange the settings in Settings > E-mail alerts.\n`,
      }
    : {
        subject: `IP Architect : ${total} nouveau(x) problème(s)${crit ? ` (${crit} critique(s))` : ""}`,
        text: `IP Architect a détecté ${total} nouveau(x) problème(s) :\n\n${body}${tail}\n\nChaque problème est signalé une fois tant qu'il dure ; il l'est de nouveau s'il disparaît puis revient.\nRéglages : Paramètres > Alertes par e-mail.\n`,
      };
}
