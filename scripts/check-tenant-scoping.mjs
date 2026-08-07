#!/usr/bin/env node
/**
 * Controle d'isolation multi-entreprises, au niveau du SCHEMA.
 *
 * Deux regles, verifiees sur chaque modele Prisma hors liste blanche :
 *
 *   1. Le modele possede un champ `companyId`.
 *      Sans lui, l'extension Prisma ne peut pas filtrer, et une requete
 *      renverrait les lignes de TOUTES les entreprises.
 *
 *   2. Il existe au moins un index (ou une contrainte d'unicite) dont la
 *      PREMIERE colonne est `companyId`.
 *      Sans lui, le filtre tenant provoque un balayage complet de table : ce
 *      qui fonctionne sur le jeu de demonstration s'effondre au premier client
 *      a 5 000 employes. C'est une regle de performance autant que de securite.
 *
 * Ce controle tourne a chaque commit. Ajouter un modele tenant sans companyId
 * casse le build immediatement, plutot que six mois plus tard en production.
 *
 * Usage : node scripts/check-tenant-scoping.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Chemin du schema. Surchargeable en argument pour que le garde-fou soit
 * lui-meme testable sur des fixtures : un controle de securite jamais mis en
 * echec n'apporte aucune garantie.
 */
const SCHEMA = process.argv[2] ?? join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma');

/**
 * Modeles legitimement HORS perimetre tenant.
 *
 * Toute entree ici est une decision de securite : elle affirme que le modele
 * ne contient aucune donnee appartenant a un client. Ajouter une ligne a cette
 * liste doit etre discute en revue, jamais fait pour faire passer la CI.
 */
const GLOBAL_MODELS = new Set([
  // Catalogue d'offres : tarifs publics, identiques pour tous.
  'Plan',
  // La racine du tenant elle-meme : son `id` EST le companyId.
  'Company',
  // Journal des actions de la plateforme (super admin). Volontairement separe
  // du journal des entreprises : un super admin n'ecrit pas dans l'audit client.
  'PlatformAuditLog',
]);

const TENANT_KEY = 'companyId';

function parseModels(schema) {
  const models = [];
  // Capture le nom et le corps de chaque bloc `model X { ... }`.
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(schema)) !== null) {
    models.push({ name: m[1], body: m[2] });
  }
  return models;
}

/** Retire les commentaires pour ne pas lire un exemple comme du code. */
function stripComments(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\/\/.*$/, ''))
    .join('\n');
}

function hasTenantField(body) {
  return new RegExp(`^\\s*${TENANT_KEY}\\s+String`, 'm').test(body);
}

/** Premiere colonne de chaque @@index / @@unique du modele. */
function indexLeadColumns(body) {
  const leads = [];
  for (const m of body.matchAll(/@@(?:index|unique)\(\s*\[([^\]]+)\]/g)) {
    const first = m[1].split(',')[0]?.trim();
    if (first) leads.push(first);
  }
  // Forme scalaire : @@unique(companyId)
  for (const m of body.matchAll(/@@(?:index|unique)\(\s*(\w+)\s*[,)]/g)) {
    leads.push(m[1]);
  }
  return leads;
}

/** Un champ marque @unique agit comme un index a colonne unique. */
function hasUniqueTenantField(body) {
  return new RegExp(`^\\s*${TENANT_KEY}\\s+String[^\\n]*@unique`, 'm').test(body);
}

function main() {
  let schema;
  try {
    schema = readFileSync(SCHEMA, 'utf8');
  } catch {
    console.error(`\x1b[31m[tenant] Schema introuvable : ${SCHEMA}\x1b[0m`);
    process.exit(1);
  }

  const models = parseModels(schema);
  if (models.length === 0) {
    console.error('\x1b[31m[tenant] Aucun modele trouve - le parseur est casse.\x1b[0m');
    process.exit(1);
  }

  const missingField = [];
  const missingIndex = [];
  let checked = 0;

  for (const { name, body } of models) {
    if (GLOBAL_MODELS.has(name)) continue;
    checked += 1;

    const clean = stripComments(body);

    if (!hasTenantField(clean)) {
      missingField.push(name);
      continue; // sans le champ, l'index n'a pas de sens
    }

    const leads = indexLeadColumns(clean);
    if (!leads.includes(TENANT_KEY) && !hasUniqueTenantField(clean)) {
      missingIndex.push(name);
    }
  }

  // Detecte une liste blanche devenue obsolete : un modele retire du schema
  // mais laisse dans GLOBAL_MODELS masquerait une future erreur.
  const known = new Set(models.map((m) => m.name));
  const staleAllowlist = [...GLOBAL_MODELS].filter((n) => !known.has(n));

  const failed = missingField.length + missingIndex.length + staleAllowlist.length > 0;

  if (failed) {
    console.error('\x1b[31m✗ Isolation multi-entreprises non garantie\x1b[0m\n');

    if (missingField.length > 0) {
      console.error(`  Modeles sans champ ${TENANT_KEY} (fuite de donnees entre clients) :`);
      for (const n of missingField) console.error(`    • ${n}`);
      console.error(`\n    Ajoutez « ${TENANT_KEY} String @db.Uuid » et la relation vers Company,`);
      console.error('    ou inscrivez le modele dans GLOBAL_MODELS si, et seulement si,');
      console.error('    il ne contient aucune donnee appartenant a un client.\n');
    }

    if (missingIndex.length > 0) {
      console.error(`  Modeles sans index commencant par ${TENANT_KEY} (balayage de table) :`);
      for (const n of missingIndex) console.error(`    • ${n}`);
      console.error(`\n    Ajoutez « @@index([${TENANT_KEY}, ...]) » au modele.\n`);
    }

    if (staleAllowlist.length > 0) {
      console.error('  Entrees obsoletes dans GLOBAL_MODELS (modeles disparus) :');
      for (const n of staleAllowlist) console.error(`    • ${n}`);
      console.error('\n    Retirez-les de scripts/check-tenant-scoping.mjs.\n');
    }

    process.exit(1);
  }

  console.log(
    `\x1b[32m✓ Isolation multi-entreprises verifiee\x1b[0m — ${checked} modeles cloisonnes, ` +
      `${GLOBAL_MODELS.size} globaux declares, ${models.length} au total.`,
  );
}

main();
