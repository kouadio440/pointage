#!/usr/bin/env node
// Deploie le serveur de paiement depuis votre poste (Windows, macOS ou Linux) :
//
//   node services/payments/deploy/deployer.mjs <utilisateur>@<IPv4 du serveur>
//   node services/payments/deploy/deployer.mjs --simulation      (archive seule, contenu affiche)
//
// Assemble UNIQUEMENT les fichiers necessaires (aucun .env, aucune cle),
// les envoie par scp, puis lance cote serveur installer-version.sh :
// dependances exactes, tests, bascule, controle de sante, retour arriere
// automatique en cas d'echec. Les secrets restent dans /etc/timora-payments/env.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const simulation = process.argv.includes('--simulation');
const cible = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
if (!simulation && !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$/.test(cible)) {
  console.error('Usage : node services/payments/deploy/deployer.mjs utilisateur@IPv4   (ou --simulation)');
  process.exit(1);
}

const RACINE = fileURLToPath(new URL('../../../', import.meta.url));
const FICHIERS = [
  'services/payments/package.json',
  'services/payments/package-lock.json',
  'services/payments/.npmrc',
  'services/payments/LISEZMOI.md',
  'services/payments/src',
  'services/payments/scripts',
  'services/payments/test',
  'server/facturation',
  'server/passerelle',
  'apps/web/billing/catalogue.js',
  'apps/web/assets/marque/timora-logo-fond-clair.png',
];
const INTERDIT = /(^|[\\/])\.env($|\.)|node_modules|\.pem$|\.key$/;

function assembler(assemblage, nom) {
  for (const f of FICHIERS) {
    const source = join(RACINE, f);
    if (!existsSync(source)) throw new Error(`Fichier manquant : ${f}`);
    cpSync(source, join(assemblage, f), { recursive: true, filter: (s) => !INTERDIT.test(s) });
  }
  execFileSync('tar', ['-czf', nom, '-C', assemblage, '.'], { cwd: tmpdir(), stdio: 'inherit' });
  const contenu = execFileSync('tar', ['-tzf', nom], { cwd: tmpdir(), encoding: 'utf8' })
    .split('\n').filter((l) => l && !l.endsWith('/'));
  const interdits = contenu.filter((l) => INTERDIT.test(l));
  if (interdits.length) throw new Error(`Fichiers interdits dans l'archive : ${interdits.join(', ')}`);
  return contenu;
}

const assemblage = mkdtempSync(join(tmpdir(), 'timora-payments-'));
const nom = `timora-payments-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.tgz`;
try {
  const contenu = assembler(assemblage, nom);
  console.log(`Archive ${nom} : ${contenu.length} fichiers, aucun secret ni node_modules.`);
  if (simulation) {
    console.log(`  ${contenu.join('\n  ')}`);
  } else {
    execFileSync('scp', [join(tmpdir(), nom), `${cible}:/tmp/${nom}`], { stdio: 'inherit' });
    execFileSync('ssh', ['-t', cible, `sudo /opt/timora-payments/bin/installer-version.sh /tmp/${nom}; code=$?; rm -f /tmp/${nom}; exit $code`], { stdio: 'inherit' });
    console.log('Deploiement termine.');
  }
} catch (e) {
  console.error(`Echec : ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(assemblage, { recursive: true, force: true });
  rmSync(join(tmpdir(), nom), { force: true });
}
