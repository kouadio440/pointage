#!/usr/bin/env node
/**
 * Interdiction de la geolocalisation en arriere-plan.
 *
 * Le cahier des charges proscrit explicitement la surveillance intrusive
 * (l. 1673). Ce produit capte la position UNIQUEMENT lors d'evenements discrets
 * declenches par l'utilisateur : pointage, debut et fin de mission, arrivee et
 * depart d'une visite client.
 *
 * Une politique ecrite dans un document se perd. Ce controle la rend
 * structurelle : le code qui permettrait un suivi continu ne peut pas etre
 * committe. C'est aussi ce qui protege l'entreprise cliente, car un suivi
 * permanent des salaries l'exposerait juridiquement.
 *
 * Usage : node scripts/check-no-background-geolocation.mjs [repertoire...]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Repertoires analyses. apps/web est exclu : prototype fige, sans geolocalisation. */
const DEFAULT_TARGETS = ['apps/api/src', 'apps/app/src', 'packages'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.git']);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']);

/**
 * Motifs interdits. Chacun correspond a une capacite de suivi CONTINU.
 * `getCurrentPosition` reste autorise : c'est une mesure ponctuelle, demandee.
 */
const FORBIDDEN = [
  {
    pattern: /\bwatchPosition\s*\(/,
    what: 'navigator.geolocation.watchPosition',
    why: 'emet la position en continu tant que la page vit',
  },
  {
    pattern: /\bBackgroundGeolocation\b/,
    what: 'BackgroundGeolocation',
    why: 'suivi en arriere-plan, meme application fermee',
  },
  {
    pattern: /@capacitor-community\/background-geolocation/,
    what: 'plugin Capacitor de geolocalisation en arriere-plan',
    why: 'suivi permanent du salarie',
  },
  {
    pattern: /\bstartMonitoringSignificantLocationChanges\b/,
    what: 'significant location changes (iOS)',
    why: 'suivi en arriere-plan',
  },
  {
    pattern: /ACCESS_BACKGROUND_LOCATION/,
    what: 'permission Android ACCESS_BACKGROUND_LOCATION',
    why: 'autorise la localisation application fermee',
  },
  {
    pattern: /\bgeofenceMonitor|\bstartGeofenceMonitoring\b/,
    what: 'surveillance de geofence en continu',
    why: 'equivaut a un suivi permanent de presence',
  },
];

/** Autorise une exception EXPLICITE et justifiee, tracable en revue. */
const ALLOW_MARKER = 'geolocation-exception-approved';

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // repertoire pas encore cree
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, files);
    else if (EXTENSIONS.has(extname(entry))) files.push(full);
  }
  return files;
}

function main() {
  const targets = process.argv.slice(2);
  const dirs = (targets.length > 0 ? targets : DEFAULT_TARGETS).map((d) => join(ROOT, d));

  const files = dirs.flatMap((d) => walk(d));
  const violations = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    if (content.includes(ALLOW_MARKER)) continue;

    const lines = content.split('\n');
    lines.forEach((line, i) => {
      // On ignore les lignes de commentaire : ce fichier lui-meme cite les
      // motifs interdits, et un commentaire ne fait rien s'executer.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          violations.push({
            file: relative(ROOT, file),
            line: i + 1,
            what: rule.what,
            why: rule.why,
          });
        }
      }
    });
  }

  if (violations.length > 0) {
    console.error('\x1b[31m✗ Geolocalisation en arriere-plan detectee\x1b[0m');
    console.error('  Ce produit ne suit jamais un salarie en continu.\n');
    for (const v of violations) {
      console.error(`  • ${v.file}:${v.line}`);
      console.error(`      ${v.what} — ${v.why}`);
    }
    console.error(
      "\n  Captez la position uniquement sur une action de l'utilisateur " +
        '(getCurrentPosition au moment du pointage, de la mission ou de la visite).',
    );
    process.exit(1);
  }

  console.log(
    `\x1b[32m✓ Aucune geolocalisation en arriere-plan\x1b[0m — ${files.length} fichiers analyses, ` +
      "position captee uniquement sur evenement declenche par l'utilisateur.",
  );
}

main();
