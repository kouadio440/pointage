import type { Config } from 'tailwindcss';

/**
 * Preset Tailwind « Chaleur d'Afrique ».
 *
 * Chaque couleur pointe vers une custom property, jamais vers une valeur figee :
 * c'est ce qui fait que les 3 themes ([data-theme]) fonctionnent au runtime sans
 * recompilation. Le prototype actuel code `slate-*` en dur dans tout le dashboard
 * et casse donc le theme clair — le lint `no-raw-tailwind-colors` empeche
 * la reproduction de cette erreur dans apps/app.
 *
 * Tailwind reste en v3.4.x, comme exige par le cahier des charges, ce qui garantit
 * en prime la parite des utilitaires avec le CDN v3 du site vitrine.
 */
export const pointagePreset = {
  content: [],
  theme: {
    extend: {
      colors: {
        // Surfaces
        surface: {
          DEFAULT: 'var(--bg-dark)',
          card: 'var(--bg-card)',
          hover: 'var(--bg-card-hover)',
          elevated: 'var(--bg-card-elevated)',
        },
        // Bordures (utilisables aussi en fond translucide, comme sur la landing)
        subtle: 'var(--border-subtle)',
        accent: 'var(--border-accent)',
        // Palette de marque
        gold: 'var(--color-gold)',
        'gold-glow': 'var(--color-gold-glow)',
        green: 'var(--color-green)',
        'green-glow': 'var(--color-green-glow)',
        orange: 'var(--color-orange)',
        steel: 'var(--color-steel)',
        offwhite: 'var(--color-offwhite)',
        muted: 'var(--color-muted)',
        red: 'var(--color-red)',
        cyan: 'var(--color-cyan)',
        // Etats metier du pointage — a preferer aux couleurs brutes dans les vues
        state: {
          present: 'var(--state-present)',
          late: 'var(--state-late)',
          absent: 'var(--state-absent)',
          leave: 'var(--state-leave)',
          mission: 'var(--state-mission)',
          pending: 'var(--state-pending)',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['Playfair Display', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        panel: 'var(--radius-panel)',
        'panel-elevated': 'var(--radius-panel-elevated)',
      },
      minHeight: {
        tap: 'var(--tap-target-min)',
      },
      minWidth: {
        tap: 'var(--tap-target-min)',
      },
      transitionTimingFunction: {
        brand: 'var(--ease-brand)',
      },
    },
  },
} satisfies Config;

export default pointagePreset;
