export { pointagePreset } from './tailwind-preset.js';

/**
 * Les 17 tokens partages avec le site vitrine (apps/web/styles.css).
 * `scripts/check-token-parity.mjs` verifie que ces noms existent, avec des
 * valeurs identiques, dans les deux fichiers CSS — pour les 3 themes.
 */
export const SHARED_TOKENS = [
  '--bg-dark',
  '--bg-card',
  '--bg-card-hover',
  '--bg-card-elevated',
  '--border-subtle',
  '--border-accent',
  '--color-green',
  '--color-green-glow',
  '--color-gold',
  '--color-gold-glow',
  '--color-orange',
  '--color-steel',
  '--color-offwhite',
  '--color-muted',
  '--color-red',
  '--color-cyan',
  '--font-sans',
  '--font-serif',
  '--font-mono',
] as const;

export type SharedToken = (typeof SHARED_TOKENS)[number];

export const THEMES = ['terracotta', 'safari', 'light-warm'] as const;
export type ThemeName = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeName = 'terracotta';

/** Fuseau officiel de la plateforme. Toute heure affichee y est convertie. */
export const APP_TIMEZONE = 'Africa/Abidjan';
