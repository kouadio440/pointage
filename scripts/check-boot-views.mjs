#!/usr/bin/env node
/**
 * Coherence de l'aiguillage de vue au demarrage.
 *
 * Le site vitrine est une application a vues multiples ou UNE SEULE section
 * doit etre visible a la fois. Le probleme : les sections sont masquees par une
 * classe Tailwind « hidden » dans le corps du document, et deux d'entre elles
 * ne l'avaient pas. Le navigateur les peignait donc integralement avant que
 * app.js ne s'execute, et l'utilisateur voyait defiler l'accueil, puis le
 * tableau de bord SaaS, avant d'atteindre le sien.
 *
 * Le bloc <style data-boot-view> du <head> corrige cela AVANT le premier rendu.
 * Ce controle verifie qu'il reste exhaustif : ajouter une section sans
 * l'inscrire dans l'aiguillage reintroduirait le defaut, silencieusement et
 * uniquement chez les utilisateurs au reseau lent.
 *
 * Le defaut s'est produit deux fois (view-hero, puis view-saas). D'ou ce garde-fou.
 *
 * Usage : node scripts/check-boot-views.mjs [chemin/vers/index.html]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] ?? join(ROOT, 'apps', 'web', 'index.html');

function main() {
  let html;
  try {
    html = readFileSync(TARGET, 'utf8');
  } catch {
    console.error(`\x1b[31m[vues] Fichier introuvable : ${TARGET}\x1b[0m`);
    process.exit(1);
  }

  const sections = [...html.matchAll(/<section id="(view-[a-z-]+)" class="view-section([^"]*)"/g)].map(
    (m) => ({ id: m[1], hidden: m[2].includes('hidden') }),
  );

  if (sections.length === 0) {
    console.error('\x1b[31m[vues] Aucune section .view-section trouvee - le parseur est casse.\x1b[0m');
    process.exit(1);
  }

  const styleBlock = (html.match(/html\[data-boot-view\][\s\S]*?<\/style>/) || [''])[0];

  if (!styleBlock) {
    console.error('\x1b[31m✗ Aiguillage de demarrage absent du <head>\x1b[0m');
    console.error("  Sans lui, toutes les sections sans classe « hidden » sont peintes au chargement.");
    process.exit(1);
  }

  // Regle generale attendue : tout masquer, puis ne reveler qu'une section.
  const masqueTout = /html\[data-boot-view\]\s+\.view-section\s*\{\s*display:\s*none/.test(styleBlock);
  const revelees = new Set([...styleBlock.matchAll(/#(view-[a-z-]+)/g)].map((m) => m[1]));

  const problemes = [];

  if (!masqueTout) {
    problemes.push(
      'La regle « html[data-boot-view] .view-section { display: none } » est absente.\n' +
        '      Masquer les sections nommement est fragile : la prochaine section ajoutee\n' +
        '      sans « hidden » sera peinte au chargement.',
    );
  }

  for (const s of sections) {
    if (!revelees.has(s.id)) {
      problemes.push(
        `Section « ${s.id} » absente de l'aiguillage de demarrage` +
          (s.hidden ? '.' : ' — et elle n\'a pas la classe « hidden », donc elle SERA peinte au chargement.'),
      );
    }
  }

  if (problemes.length > 0) {
    console.error('\x1b[31m✗ Aiguillage de vue au demarrage incomplet\x1b[0m\n');
    for (const p of problemes) console.error(`  • ${p}`);
    console.error(
      `\n  Completez le bloc <style> du <head> de ${TARGET.replace(ROOT + '\\', '').replace(ROOT + '/', '')}.`,
    );
    process.exit(1);
  }

  const exposees = sections.filter((s) => !s.hidden).length;
  console.log(
    `\x1b[32m✓ Aiguillage de vue coherent\x1b[0m — ${sections.length} sections couvertes ` +
      `(dont ${exposees} sans classe « hidden », neutralisees avant le premier rendu).`,
  );
}

main();
