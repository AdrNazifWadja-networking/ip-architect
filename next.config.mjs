import { securityHeaders } from "./src/lib/securityHeaders.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // en-têtes de sécurité sur toutes les routes (voir src/lib/securityHeaders.mjs)
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  // Pas de configuration ESLint dans ce projet : on évite l'étape lint pendant `next build`.
  eslint: { ignoreDuringBuilds: true },
  // better-sqlite3 est un module natif : il ne doit pas être empaqueté par webpack.
  // (src/instrumentation.ts — planificateur des alertes e-mail — est chargé automatiquement depuis Next 15.)
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
