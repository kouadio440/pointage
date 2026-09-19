// NETTOYAGE DES DONNEES DE TEST — PRODUCTION TIMORA.
// Demande explicite de l'utilisateur (19/09/2026), APRES sauvegarde verifiee.
//
//   node --env-file=.env scripts/ops/nettoyer-donnees-test.mjs <dossier_sauvegarde>             SIMULATION (annulee)
//   node --env-file=.env scripts/ops/nettoyer-donnees-test.mjs <dossier_sauvegarde> --executer  suppression reelle
//
// Garde : les administrateurs plateforme (compte, profil, droits), les formules,
// billing_settings, les tables, fonctions et politiques. Refuse de s'executer
// si la sauvegarde est absente, alteree, ou si un paiement enregistre existe
// (les transactions financieres ne se suppriment jamais ici).
import { ouvrirBase as ouvrir } from './connexion-base.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dossier = process.argv[2];
const executer = process.argv.includes('--executer');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!dossier || !existsSync(join(dossier, 'MANIFEST.json'))) throw new Error('Sauvegarde introuvable : aucune suppression sans sauvegarde.');
if (!SUPABASE_URL || !SERVICE) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents.');

// 1. La sauvegarde doit etre intacte.
const manifeste = JSON.parse(readFileSync(join(dossier, 'MANIFEST.json'), 'utf8'));
for (const f of manifeste.fichiers) {
  const h = createHash('sha256').update(readFileSync(join(dossier, f.fichier))).digest('hex');
  if (h !== f.sha256) throw new Error(`Sauvegarde alteree (${f.fichier}) : arret.`);
}
const objetsSauvegardes = JSON.parse(readFileSync(join(dossier, 'stockage/objets.json'), 'utf8'));

const c = await ouvrir();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const compter = async () => (await q(`select
    (select count(*) from auth.users)::int as comptes_auth,
    (select count(*) from public.users)::int as profils,
    (select count(*) from public.companies)::int as entreprises,
    (select count(*) from public.company_memberships)::int as adhesions,
    (select count(*) from public.company_memberships_archive)::int as archive_adhesions,
    (select count(*) from public.company_subscriptions)::int as abonnements,
    (select count(*) from public.billing_payments)::int as paiements,
    (select count(*) from public.billing_events)::int as evenements_facturation,
    (select count(*) from public.attendances)::int as pointages,
    (select count(*) from public.attendance_attempts)::int as tentatives_pointage,
    (select count(*) from public.face_templates)::int as modeles_faciaux,
    (select count(*) from public.face_challenges)::int as defis_faciaux,
    (select count(*) from public.geofences)::int as zones,
    (select count(*) from public.work_schedules)::int as horaires,
    (select count(*) from public.leaves)::int as conges,
    (select count(*) from public.overtimes)::int as heures_sup,
    (select count(*) from public.reviews)::int as avis,
    (select count(*) from public.auth_events)::int as evenements_auth,
    (select count(*) from public.platform_admins)::int as admins_plateforme,
    (select count(*) from public.platform_plans)::int as formules,
    (select count(*) from public.billing_settings)::int as parametres_facturation,
    (select count(*) from public.platform_payments)::int as paiements_plateforme,
    (select count(*) from public.platform_invoices)::int as factures_plateforme`))[0];

let journal;
try {
  await c.query('BEGIN');
  const avant = await compter();

  // 2. Aucune transaction financiere enregistree ne doit disparaitre.
  if (avant.paiements > 0 || avant.paiements_plateforme > 0 || avant.factures_plateforme > 0) {
    throw new Error('Des paiements / factures sont enregistres : nettoyage automatique refuse (a traiter a la main).');
  }

  const proteges = (await q(`select user_id from public.platform_admins`)).map((r) => r.user_id);
  if (!proteges.length) throw new Error('Aucun administrateur plateforme identifie : arret par prudence.');
  const comptes = await q(`select id, email from auth.users where id <> all($1::uuid[]) order by created_at`, [proteges]);
  const profils = await q(`select id from public.users where id <> all($1::uuid[])`, [proteges]);
  const entreprises = await q(`select id, name from public.companies order by created_at`);

  // 3. Donnees metier : la suppression des entreprises emporte en cascade
  //    adhesions et demandes, abonnements, pointages, tentatives, visages,
  //    zones, horaires, conges, heures sup. (cles etrangeres ON DELETE CASCADE).
  await c.query(`delete from public.companies where id = any($1::uuid[])`, [entreprises.map((e) => e.id)]);
  await c.query(`delete from public.company_memberships_archive`);
  await c.query(`delete from public.auth_events where user_id is null or user_id <> all($1::uuid[])`, [proteges]);
  await c.query(`delete from public.reviews where user_id <> all($1::uuid[])`, [proteges]);
  await c.query(`delete from public.users where id <> all($1::uuid[])`, [proteges]);

  const apres = await compter();
  journal = {
    mode: executer ? 'EXECUTION' : 'SIMULATION',
    instant: new Date().toISOString(),
    sauvegarde: dossier,
    proteges,
    entreprises_supprimees: entreprises,
    comptes_auth_a_supprimer: comptes.map((u) => u.id),
    profils_supprimes: profils.map((p) => p.id),
    objets_stockage_a_supprimer: objetsSauvegardes.map((o) => `${o.bucket_id}/${o.name}`),
    avant,
    apres_base: apres,
  };
  if (!executer) {
    await c.query('ROLLBACK');
  } else {
    await c.query('COMMIT');
  }
} catch (err) {
  await c.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await c.end();
}

// 4. Comptes Supabase Auth : API d'administration officielle (jamais de DELETE
//    direct dans auth.users). 5. Fichiers du stockage : API Storage.
if (executer) {
  journal.auth = [];
  for (const id of journal.comptes_auth_a_supprimer) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE }, signal: AbortSignal.timeout(20000),
    });
    journal.auth.push({ id, http: r.status });
  }
  journal.stockage = [];
  const parBucket = {};
  for (const o of objetsSauvegardes) (parBucket[o.bucket_id] ||= []).push(o.name);
  for (const [bucket, noms] of Object.entries(parBucket)) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: noms }),
      signal: AbortSignal.timeout(30000),
    });
    const corps = await r.json().catch(() => null);
    journal.stockage.push({ bucket, demandes: noms.length, http: r.status, supprimes: Array.isArray(corps) ? corps.length : null });
  }
  writeFileSync(join(dossier, `journal_nettoyage_${Date.now()}.json`), JSON.stringify(journal, null, 2));
}

console.log(`${journal.mode} — ${journal.instant}`);
console.log(`comptes proteges (admin plateforme) : ${journal.proteges.length}`);
console.log(`entreprises : ${journal.entreprises_supprimees.map((e) => e.name).join(', ')}`);
console.log(`comptes Auth a supprimer : ${journal.comptes_auth_a_supprimer.length} | profils : ${journal.profils_supprimes.length} | fichiers : ${journal.objets_stockage_a_supprimer.length}`);
console.log('');
console.log('                           avant   apres');
for (const k of Object.keys(journal.avant)) {
  const apres = k === 'comptes_auth' ? `${journal.avant[k] - journal.comptes_auth_a_supprimer.length} (via l'API Auth)` : journal.apres_base[k];
  console.log(`  ${k.padEnd(24)} ${String(journal.avant[k]).padStart(5)}   ${apres}`);
}
if (executer) {
  console.log('\nAPI Auth :', journal.auth.map((a) => a.http).join(', '));
  console.log('API Storage :', JSON.stringify(journal.stockage));
} else {
  console.log('\nSIMULATION : transaction annulee, rien n\'a ete supprime.');
}
