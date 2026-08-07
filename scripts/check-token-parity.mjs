#!/usr/bin/env node
/**
 * Controle de parite des tokens de design.
 *
 * Le site vitrine (apps/web/styles.css) est fige et fait autorite visuelle.
 * L'application (packages/design-tokens/src/tokens.css) doit definir EXACTEMENT
 * les memes valeurs pour les 19 tokens partages, sur les 3 themes.
 *
 * Sans ce controle, les deux moities du produit derivent silencieusement et
 * l'utilisateur voit deux identites differentes de part et d'autre du login.
 *
 * Usage : node scripts/check-token-parity.mjs
 * Sortie : code 0 si parite, 1 sinon (avec le detail des divergences).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const VITRINE = join(ROOT, 'apps', 'web', 'styles.css');
const APP = join(ROOT, 'packages', 'design-tokens', 'src', 'tokens.css');

/**
 * Tokens redefinis par CHAQUE theme : ils doivent concorder sur les 3 themes.
 */
const THEMED_TOKENS = [
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
];

/**
 * Tokens declares une seule fois dans :root et HERITES par les autres themes
 * (les polices ne dependent pas du theme). On ne les verifie donc que sur
 * le bloc racine — les exiger sur [data-theme=safari] serait un faux positif.
 */
const GLOBAL_TOKENS = ['--font-sans', '--font-serif', '--font-mono'];

const THEMES = ['terracotta', 'safari', 'light-warm'];

/**
 * Normalise une valeur CSS pour que la comparaison porte sur le rendu,
 * pas sur la mise en forme : casse hexadecimale, guillemets, espaces.
 */
function normalize(value) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/["']/g, "'")
    .replace(/#([0-9a-fA-F]{3,8})\b/g, (_, hex) => `#${hex.toLowerCase()}`)
    .replace(/;$/, '')
    .toLowerCase();
}

/** Retire les commentaires pour ne pas parser des tokens cites en exemple. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extrait, par theme, la table des custom properties definies.
 * Un selecteur contenant `:root` alimente le theme par defaut (terracotta) ;
 * `[data-theme="x"]` alimente le theme x.
 */
function extractThemes(css, label) {
  const clean = stripComments(css);
  const result = Object.fromEntries(THEMES.map((t) => [t, {}]));

  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = blockRe.exec(clean)) !== null) {
    const selector = match[1].trim();
    const body = match[2];

    const targets = new Set();
    if (/(^|,)\s*:root\b/.test(selector)) targets.add('terracotta');
    for (const m of selector.matchAll(/\[data-theme=["']?([a-z-]+)["']?\]/g)) {
      if (THEMES.includes(m[1])) targets.add(m[1]);
    }
    if (targets.size === 0) continue;

    for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      const name = decl[1].trim();
      const value = normalize(decl[2]);
      for (const t of targets) {
        result[t][name] = value;
      }
    }
  }

  const total = THEMES.reduce((n, t) => n + Object.keys(result[t]).length, 0);
  if (total === 0) {
    throw new Error(`Aucun token trouve dans ${label} — le parseur ou le fichier est casse.`);
  }
  return result;
}

function main() {
  let vitrine;
  let app;
  try {
    vitrine = extractThemes(readFileSync(VITRINE, 'utf8'), 'apps/web/styles.css');
    app = extractThemes(readFileSync(APP, 'utf8'), 'packages/design-tokens/src/tokens.css');
  } catch (err) {
    console.error(`\x1b[31m[tokens] ${err.message}\x1b[0m`);
    process.exit(1);
  }

  const problems = [];

  const compare = (theme, token) => {
    const a = vitrine[theme][token];
    const b = app[theme][token];

    if (a === undefined && b === undefined) {
      problems.push(`[${theme}] ${token} : absent des DEUX fichiers`);
    } else if (a === undefined) {
      problems.push(`[${theme}] ${token} : absent du site vitrine, present dans l'app (= ${b})`);
    } else if (b === undefined) {
      problems.push(`[${theme}] ${token} : absent de l'app, present sur le site vitrine (= ${a})`);
    } else if (a !== b) {
      problems.push(`[${theme}] ${token} : vitrine = ${a}   /   app = ${b}`);
    }
  };

  for (const theme of THEMES) {
    for (const token of THEMED_TOKENS) compare(theme, token);
  }
  // Les polices ne sont declarees que dans :root (theme par defaut) et heritees.
  for (const token of GLOBAL_TOKENS) compare('terracotta', token);

  if (problems.length > 0) {
    console.error('\x1b[31m✗ Parite des tokens rompue\x1b[0m');
    console.error(
      "  Le site vitrine et l'application ne partagent plus la meme identite visuelle.\n",
    );
    for (const p of problems) console.error(`  • ${p}`);
    console.error(`\n  ${problems.length} divergence(s).`);
    console.error('  Corrigez packages/design-tokens/src/tokens.css (apps/web/ fait autorite).');
    process.exit(1);
  }

  const checked = THEMED_TOKENS.length * THEMES.length + GLOBAL_TOKENS.length;
  console.log(
    `\x1b[32m✓ Parite des tokens verifiee\x1b[0m — ${THEMED_TOKENS.length} tokens × ${THEMES.length} themes + ${GLOBAL_TOKENS.length} globaux = ${checked} valeurs identiques.`,
  );
}

main();
