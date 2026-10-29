import type { Config } from "tailwindcss";

/** Chaque couleur pointe vers une variable CSS (triplet RGB) définie dans globals.css pour le thème clair et sombre.
 *  Le format `<alpha-value>` permet d'utiliser les opacités Tailwind (bg-ok/15, border-bad/30…). */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        panel: token("panel"),
        panel2: token("panel2"),
        line: token("line"),
        fg: token("fg"),
        fg2: token("fg2"),
        muted: token("muted"),
        neutral: token("neutral"),
        brand: { DEFAULT: token("brand"), soft: token("brand-soft") },
        ipv4: token("ipv4"),
        ipv6: token("ipv6"),
        ok: token("ok"),
        warn: token("warn"),
        bad: token("bad"),
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
