import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { docsFr } from "./content.fr";
import { docsEn } from "./content.en";
import { API_ENTRIES } from "./api";
import { getApiDocs, getDocs, toRoutePath } from "./index";
import { buildOpenApi, CREATED_PATHS, SESSION_ONLY_PATHS } from "./openapi";
import { DOC_GROUPS, searchTerms, sectionText, type DocBlock, type DocSection } from "./types";
import { requiredAccess } from "../auth/policy";
import { ALL_ITEMS } from "../nav";
import { dictionaries, LOCALES } from "../i18n";

const SRC_APP = path.join(process.cwd(), "src", "app");

function walk(dir: string, name: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

/** Forme d'un bloc, sans le texte : deux langues doivent avoir exactement la même. */
function shape(b: DocBlock): string {
  switch (b.t) {
    case "ul":
    case "ol":
      return `${b.t}:${b.items.length}`;
    case "table":
      return `table:${b.head.length}x${b.rows.length}:${b.rows.map((r) => r.length).join(",")}`;
    case "note":
      return `note:${b.kind}`;
    default:
      return b.t;
  }
}

test("docs : français et anglais ont les mêmes sections, dans le même ordre, avec la même structure", () => {
  assert.deepEqual(docsEn.map((s) => s.id), docsFr.map((s) => s.id));
  docsFr.forEach((fr, i) => {
    const en = docsEn[i];
    assert.equal(en.group, fr.group, fr.id);
    assert.deepEqual(en.open?.href, fr.open?.href, `${fr.id} : lien différent`);
    assert.equal(!!en.open, !!fr.open, fr.id);
    assert.deepEqual(en.blocks.map(shape), fr.blocks.map(shape), `${fr.id} : blocs différents entre FR et EN`);
  });
});

test("docs : identifiants uniques et stables, tous les groupes utilisés, aucun texte vide", () => {
  for (const [name, docs] of [["fr", docsFr], ["en", docsEn]] as const) {
    const ids = docs.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${name} : identifiants en double`);
    for (const s of docs) {
      assert.match(s.id, /^[a-z][a-z0-9-]*$/, `${name}/${s.id}`);
      assert.ok(s.title.trim() && s.summary.trim() && s.blocks.length > 0, `${name}/${s.id} : titre, résumé ou contenu vide`);
      for (const b of s.blocks) {
        const raw = JSON.stringify(b);
        assert.ok(!/TODO|XXX|lorem/i.test(raw), `${name}/${s.id} : texte provisoire`);
        if (b.t === "p" || b.t === "h3" || b.t === "note") assert.ok(b.text.trim(), `${name}/${s.id} : bloc vide`);
        if (b.t === "ul" || b.t === "ol") assert.ok(b.items.length > 0 && b.items.every((x) => x.trim()), `${name}/${s.id} : liste vide`);
      }
    }
    for (const g of DOC_GROUPS) assert.ok(docs.some((s) => s.group === g), `${name} : groupe ${g} vide`);
  }
  // les groupes ont une étiquette dans chaque langue
  for (const l of LOCALES) for (const g of DOC_GROUPS) assert.ok(dictionaries[l].docs.groups[g]);
});

function pageExists(href: string): boolean {
  const seg = href === "/" ? "" : href.replace(/^\//, "");
  return fs.existsSync(path.join(SRC_APP, seg, "page.tsx"));
}

test("docs : chaque lien « ouvrir » mène à une vraie page, et chaque module du menu est documenté", () => {
  for (const docs of [docsFr, docsEn]) {
    for (const s of docs) if (s.open) assert.ok(pageExists(s.open.href), `${s.id} : la page ${s.open.href} n'existe pas`);
    const linked = new Set(docs.filter((s) => s.open).map((s) => s.open!.href));
    for (const item of ALL_ITEMS.filter((i) => i.ready)) assert.ok(linked.has(item.href), `module ${item.key} (${item.href}) sans documentation`);
  }
  // la page de documentation elle-même existe (le lien du menu ne tombe plus sur « en préparation »)
  assert.ok(pageExists("/documentation"));
  assert.ok(pageExists("/inscription"));
});

test("docs : le tableau de l'API correspond exactement aux routes réelles (rien d'inventé, rien d'oublié)", () => {
  const real = new Set<string>();
  for (const file of walk(SRC_APP, "route.ts")) {
    const route = "/" + path.relative(SRC_APP, path.dirname(file)).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)) real.add(`${m[1]} ${route}`);
  }
  assert.ok(real.size >= 60, `routes réelles trouvées : ${real.size}`);

  const documented = new Set<string>();
  for (const e of API_ENTRIES) {
    const key = `${e.method} ${toRoutePath(e.path)}`;
    assert.ok(!documented.has(key), `${key} : documentée deux fois`);
    documented.add(key);
  }
  // les noms de paramètres peuvent différer (:type / [entity]) : on compare la forme avec des paramètres anonymes
  const anon = (k: string) => k.replace(/\[\w+\]/g, "[]");
  const realAnon = new Set([...real].map(anon));
  const docAnon = new Set([...documented].map(anon));
  for (const k of docAnon) assert.ok(realAnon.has(k), `${k} : documentée mais inexistante`);
  for (const k of realAnon) assert.ok(docAnon.has(k), `${k} : existe mais n'est pas documentée`);
});

test("docs : le rôle affiché vient de la politique d'accès, et chaque description est renseignée", () => {
  for (const l of LOCALES) {
    const rows = getApiDocs(l);
    assert.equal(rows.length, API_ENTRIES.length);
    for (const r of rows) {
      assert.equal(r.access, requiredAccess(r.method, toRoutePath(r.path)), `${r.method} ${r.path}`);
      assert.ok(r.description.trim(), `${r.method} ${r.path} : description vide en ${l}`);
      assert.ok(dictionaries[l].docs.api[`access_${r.access}` as const], `étiquette de rôle manquante : ${r.access}`);
    }
  }
  // quelques valeurs sûres, pour que le test ne soit pas une simple tautologie
  const byKey = new Map(getApiDocs("fr").map((r) => [`${r.method} ${r.path}`, r.access]));
  assert.equal(byKey.get("GET /api/health"), "public");
  assert.equal(byKey.get("POST /api/auth/register/start"), "public");
  assert.equal(byKey.get("GET /api/networks"), "viewer");
  assert.equal(byKey.get("POST /api/networks"), "editor");
  assert.equal(byKey.get("POST /api/projects/:id/activate"), "viewer");
  assert.equal(byKey.get("DELETE /api/projects/:id"), "admin");
  assert.equal(byKey.get("GET /api/audit"), "admin");
});

test("docs : un seul emplacement de tableau d'API, dans la section « api »", () => {
  for (const docs of [docsFr, docsEn]) {
    const holders = docs.filter((s) => s.blocks.some((b) => b.t === "api"));
    assert.deepEqual(holders.map((s) => s.id), ["api"]);
  }
});

test("docs : les commandes npm citées existent dans package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
  const all = JSON.stringify([...docsFr, ...docsEn]);
  const used = new Set([...all.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  assert.ok(used.has("dev") && used.has("user:reset"));
  for (const name of used) assert.ok(name in pkg.scripts, `npm run ${name} n'existe pas`);
});

test("docs : les codes d'erreur cités existent dans le dictionnaire", () => {
  const errors = dictionaries.fr.errors as Record<string, string>;
  for (const code of ["addressTaken", "networkFull", "vlanInUse", "vlanLocked"]) assert.ok(code in errors, `code d'erreur ${code} inconnu`);
});

test("docs : getDocs renvoie la langue demandée", () => {
  assert.equal(getDocs("fr").sections, docsFr);
  assert.equal(getDocs("en").sections, docsEn);
  assert.notEqual(docsFr[0].title, docsEn[0].title);
});

test("docs : la recherche exige tous les mots, sans tenir compte de la casse, et couvre le tableau de l'API", () => {
  const api = getApiDocs("fr");
  const find = (q: string): string[] => {
    const terms = searchTerms(q);
    return docsFr.filter((s: DocSection) => terms.every((w) => sectionText(s, api).includes(w))).map((s) => s.id);
  };
  assert.deepEqual(searchTerms("  VRF   Sauvegarde "), ["vrf", "sauvegarde"]);
  assert.deepEqual(searchTerms("   "), []);
  assert.equal(searchTerms("a b c d e f g h i j k").length, 8);
  assert.ok(find("sauvegarde").includes("settings"));
  assert.ok(find("SMTP gmail").includes("signup"));
  assert.ok(find("route distinguisher").includes("vrf"));
  assert.ok(find("/api/dhcp/scopes").includes("api"), "le tableau de l'API est cherchable");
  assert.deepEqual(find("zzzqqqxxx"), []);
  // mots présents mais dans des sections différentes : aucune section ne contient les deux
  assert.deepEqual(find("ollama zzzqqqxxx"), []);
});

/* ------------------------------------ OpenAPI ------------------------------------ */

type Op = { operationId: string; security: Record<string, unknown>[]; parameters?: { name: string; in: string; required: boolean; schema: { type: string; enum?: string[] } }[]; responses: Record<string, unknown>; requestBody?: unknown; "x-required-role": string; summary: string };
const spec = (l: "fr" | "en") => buildOpenApi(l, "https://ipam.example.com") as { openapi: string; info: { title: string }; servers: { url: string }[]; paths: Record<string, Record<string, Op>>; components: { securitySchemes: Record<string, { type: string; scheme?: string; in?: string; name?: string; description?: string }> } };

test("openapi : document 3.0 valide dans sa forme, une opération par ligne du tableau, sérialisable", () => {
  for (const l of ["fr", "en"] as const) {
    const d = spec(l);
    assert.equal(d.openapi, "3.0.3");
    assert.equal(d.servers[0].url, "https://ipam.example.com");
    assert.deepEqual(d.components.securitySchemes.bearerAuth, { type: "http", scheme: "bearer", description: d.components.securitySchemes.bearerAuth.description });
    assert.equal(d.components.securitySchemes.cookieAuth.in, "cookie");
    assert.equal(d.components.securitySchemes.cookieAuth.name, "ipa_session");
    const ops = Object.values(d.paths).flatMap((m) => Object.values(m));
    assert.equal(ops.length, API_ENTRIES.length);
    const ids = ops.map((o) => o.operationId);
    assert.equal(new Set(ids).size, ids.length, "operationId uniques");
    for (const id of ids) assert.match(id, /^[a-z]+[A-Za-z0-9_]*$/);
    assert.doesNotThrow(() => JSON.stringify(d));
    // chaque ligne du tableau est une opération, avec la bonne méthode
    for (const e of API_ENTRIES) assert.ok(d.paths[e.path.replace(/:(\w+)/g, "{$1}")]?.[e.method.toLowerCase()], `${e.method} ${e.path}`);
  }
  assert.notEqual(spec("fr").paths["/api/networks"].get.summary, spec("en").paths["/api/networks"].get.summary);
});

test("openapi : paramètres de chemin déclarés, entiers ou énumérés ; réponses d'erreur cohérentes", () => {
  const d = spec("en");
  for (const [path, methods] of Object.entries(d.paths)) {
    const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const op of Object.values(methods)) {
      // l'en-tête X-Project-Id est déclaré par référence sur toutes les opérations non publiques
      const own = (op.parameters ?? []).filter((p) => p.name !== undefined);
      assert.deepEqual(own.map((p) => p.name), names, path);
      for (const p of own) assert.ok(p.in === "path" && p.required);
      if (names.length > 0) assert.ok("404" in op.responses, `${path} : 404 attendu`);
      assert.ok("400" in op.responses && "422" in op.responses);
    }
  }
  const p = d.paths["/api/export/{entity}"].get.parameters![0];
  assert.equal(p.schema.type, "string");
  assert.ok(p.schema.enum!.includes("dhcp_scopes") && p.schema.enum!.length === 7);
  assert.deepEqual(d.paths["/api/simulator/{mode}"].post.parameters![0].schema.enum, ["split", "merge", "free", "fit"]);
  assert.equal(d.paths["/api/networks/{id}"].patch.parameters![0].schema.type, "integer");
});

test("openapi : sécurité = politique d'accès (public / jeton ou cookie / cookie seul pour admin et sessions obligatoires)", () => {
  const d = spec("en");
  const sec = (path: string, m: string) => JSON.stringify(d.paths[path][m].security);
  assert.equal(sec("/api/health", "get"), "[]");
  assert.equal(sec("/api/auth/login", "post"), "[]");
  assert.equal(sec("/api/networks", "get"), '[{"bearerAuth":[]},{"cookieAuth":[]}]');
  assert.equal(sec("/api/networks", "post"), '[{"bearerAuth":[]},{"cookieAuth":[]}]');
  assert.equal(sec("/api/projects/{id}/activate", "post"), '[{"bearerAuth":[]},{"cookieAuth":[]}]', "éditeur : jeton accepté");
  // jamais de jeton pour l'administration, ni pour les routes qui exigent une session
  for (const [path, m] of [["/api/users", "get"], ["/api/audit", "get"], ["/api/settings", "patch"], ["/api/settings/backup", "get"], ["/api/projects", "post"], ["/api/projects/{id}", "delete"], ["/api/assistant/settings", "patch"], ["/api/monitoring/settings", "patch"]] as const) {
    assert.equal(sec(path, m), '[{"cookieAuth":[]}]', `${m} ${path}`);
  }
  for (const sp of SESSION_ONLY_PATHS) {
    const oas = sp.replace(/:(\w+)/g, "{$1}");
    for (const op of Object.values(d.paths[oas])) assert.equal(JSON.stringify(op.security), '[{"cookieAuth":[]}]', sp);
  }
  // cohérence globale : « admin » n'a jamais de jeton ; un rôle non admin sans exception a les deux
  for (const [path, methods] of Object.entries(d.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      const role = op["x-required-role"];
      if (role === "admin") assert.equal(JSON.stringify(op.security), '[{"cookieAuth":[]}]', `${m} ${path}`);
      if (role === "public") assert.deepEqual(op.security, []);
      if (role === "public") assert.ok(!("401" in op.responses));
      else assert.ok("401" in op.responses && "403" in op.responses);
    }
  }
});

test("openapi : les routes « session obligatoire » appellent vraiment requireSessionUser(), et les codes 201 sont ceux des routes", () => {
  const src = (route: string) => fs.readFileSync(path.join(SRC_APP, route.replace(/^\/api/, "api").replace(/:(\w+)/g, "[$1]"), "route.ts"), "utf8");
  for (const sp of SESSION_ONLY_PATHS) {
    const body = src(sp);
    assert.ok(body.includes("requireSessionUser()"), `${sp} : doit exiger une session de navigateur`);
  }
  // les routes d'administration n'ont pas besoin du marqueur : un jeton n'est jamais admin (voir tokens.test.ts)
  const created = new Set<string>();
  for (const file of walk(SRC_APP, "route.ts")) {
    const route = "/" + path.relative(SRC_APP, path.dirname(file)).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    // le 201 d'une route est dans son gestionnaire POST
    const post = text.split(/export async function POST\(/)[1]?.split(/export async function \w+\(/)[0] ?? "";
    if (post.includes("status: 201")) created.add(route);
  }
  const declared = new Set([...CREATED_PATHS].map(toRoutePath));
  assert.deepEqual([...declared].sort(), [...created].sort());
});

test("openapi : le tableau de la documentation et la route /api/openapi existent côté application", () => {
  assert.ok(API_ENTRIES.some((e) => e.path === "/api/openapi" && e.method === "GET"));
  assert.ok(fs.existsSync(path.join(SRC_APP, "api", "openapi", "route.ts")));
  assert.ok(fs.existsSync(path.join(SRC_APP, "jetons-api", "page.tsx")));
});
