#!/usr/bin/env node
/**
 * Verifie que les prix de Timora ont UNE seule valeur partout :
 *
 *   1. le catalogue (apps/web/billing/catalogue.js) est coherent : devise XOF,
 *      montants entiers, annuel = mensuel x (12 - mois offerts), effectifs
 *      croissants, formule Entreprise sur devis ;
 *   2. la migration 031 insere exactement ces valeurs dans platform_plans ;
 *   3. la page d'accueil lit ses prix dans le catalogue (aucun prix en dur) ;
 *   4. si SUPABASE_URL et SUPABASE_ANON_KEY sont definis, la base en ligne
 *      renvoie les memes tarifs (billing_plans_public).
 *
 * Usage : node scripts/check-billing-catalogue.mjs
 *         node --env-file=.env scripts/check-billing-catalogue.mjs   (avec la base)
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = createRequire(import.meta.url)(resolve(RACINE, 'apps/web/billing/catalogue.js'));
const erreurs = [];
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);

// 1. Coherence interne ---------------------------------------------------------
if (catalogue.devise !== 'XOF') erreurs.push(`devise ${catalogue.devise} (XOF attendu)`);
let precedent = 0;
for (const f of catalogue.formules) {
  if (f.enLigne) {
    if (!Number.isInteger(f.mensuel) || f.mensuel < 100) erreurs.push(`${f.code} : mensuel invalide (${f.mensuel})`);
    if (f.annuel !== f.mensuel * (12 - catalogue.moisOffertsAnnuel)) {
      erreurs.push(`${f.code} : annuel ${f.annuel} ≠ mensuel × ${12 - catalogue.moisOffertsAnnuel} (« ${catalogue.moisOffertsAnnuel} mois offerts » serait faux)`);
    }
    if (!(f.maxEmployes > precedent)) erreurs.push(`${f.code} : effectif ${f.maxEmployes} non croissant`);
    precedent = f.maxEmployes;
  } else if (f.mensuel !== null || f.annuel !== null) {
    erreurs.push(`${f.code} : une formule sur devis n'a pas de prix`);
  }
}
if (!erreurs.length) ok(`catalogue coherent — ${catalogue.formules.map((f) => `${f.code} ${f.mensuel ?? 'sur devis'}`).join(', ')}`);

// 2. Migration -----------------------------------------------------------------
const migration = readFileSync(resolve(RACINE, 'services/supabase_migration_031_facturation.sql'), 'utf8');
const nb = erreurs.length;
for (const f of catalogue.formules) {
  const sql = (v) => (v === null ? 'NULL' : String(v));
  const attendu = `('${f.code}', '${f.nom}', ${sql(f.mensuel)}, ${sql(f.annuel)}, ${sql(f.maxEmployes)}, TRUE,`;
  if (!migration.includes(attendu)) erreurs.push(`migration 031 : ligne absente ou differente pour ${f.code} (attendu ${attendu}…)`);
}
if (erreurs.length === nb) ok('migration 031 : tarifs identiques au catalogue');

// 3. Page d'accueil ------------------------------------------------------------
const app = readFileSync(resolve(RACINE, 'apps/web/app.js'), 'utf8');
const nb2 = erreurs.length;
for (const f of catalogue.formules) {
  if (!app.includes(`...prixCatalogue('${f.code}')`)) erreurs.push(`app.js : la formule ${f.code} ne lit pas ses prix dans le catalogue`);
}
const index = readFileSync(resolve(RACINE, 'apps/web/index.html'), 'utf8');
if (index.indexOf('billing/catalogue.js') === -1 || index.indexOf('billing/catalogue.js') > index.indexOf('src="app.js"')) {
  erreurs.push('index.html : billing/catalogue.js doit etre charge avant app.js');
}
if (erreurs.length === nb2) ok('page d\'accueil : prix lus dans le catalogue, charge avant app.js');

// 4. Base en ligne (facultatif) ------------------------------------------------
const url = process.env.SUPABASE_URL;
const cle = process.env.SUPABASE_ANON_KEY;
if (url && cle) {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/billing_plans_public`, {
      method: 'POST',
      headers: { apikey: cle, Authorization: `Bearer ${cle}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) {
      erreurs.push('base en ligne : billing_plans_public introuvable (migration 031 non appliquee)');
    } else {
      const plans = await r.json();
      for (const f of catalogue.formules) {
        const p = plans.find((x) => x.code === f.code);
        if (!p || p.monthly_price !== f.mensuel || p.annual_price !== f.annuel || p.max_employees !== f.maxEmployes) {
          erreurs.push(`base en ligne : ${f.code} differe du catalogue (${JSON.stringify(p)})`);
        }
      }
      if (!erreurs.some((e) => e.startsWith('base en ligne'))) ok('base en ligne : tarifs identiques au catalogue');
    }
  } catch (err) {
    erreurs.push(`base en ligne injoignable : ${err.message}`);
  }
} else {
  console.log('  (base en ligne non verifiee : SUPABASE_URL / SUPABASE_ANON_KEY absents)');
}

if (erreurs.length) {
  erreurs.forEach((e) => console.error(`\x1b[31m✗\x1b[0m ${e}`));
  process.exitCode = 1;
}
