/**
 * Contrat OpenAPI 3.0 de l'API, GÉNÉRÉ à partir du tableau de référence (api.ts) et de la politique d'accès (policy.ts) :
 * il ne peut donc pas diverger des routes réelles (docs.test.ts vérifie le tableau contre les fichiers route.ts).
 *
 * Il décrit les chemins, méthodes, paramètres de chemin, authentification et codes de réponse. Les champs des corps de
 * requête sont décrits en texte (description de chaque opération), pas par un schéma détaillé.
 */
import type { Locale } from "../i18n";
import { CSV_ENTITIES } from "../types";
import { REPORT_KINDS } from "../reportTypes";
import { SESSION_COOKIE } from "../auth/roles";
import { API_ENTRIES } from "./api";
import { getApiDocs } from "./index";

/** Routes qui exigent une vraie session de navigateur, même avec un jeton valide (voir requireSessionUser). */
export const SESSION_ONLY_PATHS = ["/api/auth/password", "/api/tokens", "/api/tokens/:id"] as const;

/** POST qui répondent 201 (création) ; docs.test.ts le vérifie contre les fichiers route.ts. */
export const CREATED_PATHS = new Set<string>([
  "/api/auth/register/verify",
  "/api/dhcp/scopes",
  "/api/dhcp/scopes/:id/reservations",
  "/api/networks",
  "/api/networks/:id/addresses",
  "/api/plans",
  "/api/projects",
  "/api/sites",
  "/api/tags",
  "/api/webhooks",
  "/api/custom-fields",
  "/api/topology/devices",
  "/api/topology/links",
  "/api/topology/credentials",
  "/api/tp",
  "/api/tp/:id/submit",
  "/api/tp/:id/duplicate",
  "/api/tp/classes",
  "/api/tokens",
  "/api/users",
  "/api/vlans",
  "/api/vrfs",
]);

/** POST qui répondent 202 (travail lancé en arrière-plan). */
export const ACCEPTED_PATHS = new Set<string>(["/api/networks/:id/scan", "/api/topology/discover"]);

const NO_BODY = new Set([
  "POST /api/auth/logout",
  "POST /api/projects/:id/activate",
  "POST /api/webhooks/:id/test",
  "DELETE /api/networks/:id/scan",
  "DELETE /api/topology/discover",
  "POST /api/webhooks/:id/secret",
  "POST /api/webhooks/:id/deliveries/:deliveryId/retry",
]);

const PATH_PARAM_ENUM: Record<string, readonly string[]> = {
  kind: REPORT_KINDS,
  entity: CSV_ENTITIES,
  mode: ["split", "merge", "free", "fit"],
};

type Json = Record<string, unknown>;

const ERROR_REF = { $ref: "#/components/schemas/Error" };
const errorResponse = (description: string): Json => ({ description, content: { "application/json": { schema: ERROR_REF } } });

export function buildOpenApi(locale: Locale, serverUrl: string): Json {
  const fr = locale === "fr";
  const docs = getApiDocs(locale);
  const sessionOnly = new Set<string>(SESSION_ONLY_PATHS);
  const paths: Record<string, Record<string, Json>> = {};
  const seenIds = new Set<string>();

  API_ENTRIES.forEach((entry, i) => {
    const doc = docs[i];
    const oasPath = entry.path.replace(/:(\w+)/g, "{$1}");
    const method = entry.method.toLowerCase();
    const params = [...entry.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const key = `${entry.method} ${entry.path}`;

    let operationId = `${method}${entry.path
      .replace(/^\/api\//, "")
      .split(/[/:]+/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1).replace(/[^A-Za-z0-9]/g, ""))
      .join("")}`;
    while (seenIds.has(operationId)) operationId += "_";
    seenIds.add(operationId);

    // sécurité : public = aucune ; administrateur ou session obligatoire = cookie seul (un jeton n'est jamais administrateur) ;
    // sinon jeton (Bearer) ou cookie
    let security: Json[];
    if (doc.access === "public") security = [];
    else if (doc.access === "admin" || sessionOnly.has(entry.path)) security = [{ cookieAuth: [] }];
    else security = [{ bearerAuth: [] }, { cookieAuth: [] }];

    const responses: Record<string, Json> = {
      [entry.method === "POST" && CREATED_PATHS.has(entry.path) ? "201" : entry.method === "POST" && ACCEPTED_PATHS.has(entry.path) ? "202" : "200"]: {
        description: fr ? "Succès" : "Success",
      },
      "400": errorResponse(fr ? "Requête invalide" : "Invalid request"),
      "422": errorResponse(fr ? "Données refusées par les contrôles (champ invalide…)" : "Data rejected by validation"),
    };
    if (doc.access !== "public") {
      responses["401"] = errorResponse(fr ? "Connexion ou jeton requis" : "Sign-in or token required");
      responses["403"] = errorResponse(fr ? "Droits insuffisants" : "Insufficient rights");
    }
    if (params.length > 0) responses["404"] = errorResponse(fr ? "Objet introuvable" : "Object not found");
    if (entry.method !== "GET") responses["409"] = errorResponse(fr ? "Conflit (chevauchement, nom pris, objet utilisé…)" : "Conflict (overlap, name taken, object in use…)");

    const op: Json = {
      operationId,
      tags: [entry.path.split("/")[2]],
      summary: doc.description,
      description: `${doc.description}\n\n${fr ? "Rôle minimum" : "Minimum role"} : ${doc.access}${sessionOnly.has(entry.path) ? (fr ? " (session de navigateur obligatoire)" : " (browser session required)") : ""}.`,
      "x-required-role": doc.access,
      security,
      responses,
    };
    if (params.length > 0) {
      op.parameters = params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: PATH_PARAM_ENUM[name] ? { type: "string", enum: [...PATH_PARAM_ENUM[name]] } : { type: "integer" },
      }));
    }
    if ((entry.method === "POST" || entry.method === "PATCH") && !NO_BODY.has(key)) {
      op.requestBody = {
        required: false,
        description: doc.description,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      };
    }
    // projet de la requête : en-tête facultatif (sinon, le projet actif du compte)
    if (doc.access !== "public") op.parameters = [...((op.parameters as Json[] | undefined) ?? []), { $ref: "#/components/parameters/XProjectId" }];
    (paths[oasPath] ??= {})[method] = op;
  });

  return {
    openapi: "3.0.3",
    info: {
      title: "IP Architect API",
      version: "1.0.0",
      description: fr
        ? "API JSON d'IP Architect. Authentification : jeton d'API (en-tête « Authorization: Bearer ipa_… », créé dans la page Jetons d'API ; lecture seule ou lecture et écriture, jamais administrateur) ou cookie de session du navigateur. Les messages d'erreur suivent la langue de l'utilisateur, avec un code stable."
        : "IP Architect JSON API. Authentication: API token (“Authorization: Bearer ipa_…” header, created on the API tokens page; read-only or read and write, never administrator) or the browser session cookie. Error messages follow the user's language, with a stable code.",
    },
    servers: [{ url: serverUrl }],
    components: {
      parameters: {
        XProjectId: {
          name: "X-Project-Id",
          in: "header",
          required: false,
          description: fr
            ? "Identifiant du projet visé par la requête. Absent : le projet actif du compte. 403 si le compte n'y a pas accès."
            : "ID of the project the request targets. Absent: the account's active project. 403 if the account has no access to it.",
          schema: { type: "integer", minimum: 1 },
        },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: fr ? "Jeton d'API (ipa_…)" : "API token (ipa_…)" },
        cookieAuth: { type: "apiKey", in: "cookie", name: SESSION_COOKIE, description: fr ? "Session de navigateur" : "Browser session" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: { error: { type: "string", description: fr ? "Message dans la langue de l'utilisateur" : "Message in the user's language" }, code: { type: "string", description: fr ? "Code stable (ex. addressTaken)" : "Stable code (e.g. addressTaken)" } },
        },
      },
    },
    paths,
  };
}
