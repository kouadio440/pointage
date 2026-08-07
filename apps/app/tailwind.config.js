import { pointagePreset } from '@pointage/design-tokens/tailwind-preset';
/**
 * Tailwind v3.4.17, comme exige par le cahier des charges.
 *
 * Le choix n'est pas seulement de conformite : le site vitrine tourne sur le
 * CDN Tailwind v3, et garder la meme version majeure garantit que les memes
 * classes utilitaires produisent le meme rendu de part et d'autre du login.
 */
export default {
    presets: [pointagePreset],
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {},
    },
    plugins: [],
};
//# sourceMappingURL=tailwind.config.js.map