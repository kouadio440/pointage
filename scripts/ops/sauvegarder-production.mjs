// SAUVEGARDE DE LA BASE DE PRODUCTION TIMORA — LECTURE SEULE.
// A faire avant tout nettoyage ou toute operation sensible.
//
// Exporte hors du depot Git :
//   - toutes les tables public non vides (JSON), et la liste des tables vides ;
//   - auth.users (sans mot de passe chiffre ni jeton), auth.identities,
//     un resume des sessions (jamais les jetons) ;
//   - les metadonnees ET les fichiers du stockage Supabase ;
//   - la definition des fonctions, politiques RLS et declencheurs (retour arriere) ;
//   - un MANIFEST.json (comptes + empreinte SHA-256 de chaque fichier).
//
//   node --env-file=.env scripts/ops/sauvegarder-production.mjs [dossier]
//   (par defaut : ../sauvegardes-timora/<date>, HORS du depot Git)
import { ouvrirBase as ouvrir } from './connexion-base.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const horodatage = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = process.argv[2] || fileURLToPath(new URL(`../../../sauvegardes-timora/${horodatage}/`, import.meta.url));
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SUPABASE_URL || !SERVICE) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents.');

const fichiers = [];
function ecrire(relatif, contenu) {
  const chemin = join(dest, relatif);
  mkdirSync(dirname(chemin), { recursive: true });
  const donnees = typeof contenu === 'string' || Buffer.isBuffer(contenu) ? contenu : JSON.stringify(contenu, null, 2);
  writeFileSync(chemin, donnees);
  const octets = Buffer.isBuffer(donnees) ? donnees : Buffer.from(donnees);
  fichiers.push({ fichier: relatif.replace(/\\/g, '/'), octets: octets.length, sha256: createHash('sha256').update(octets).digest('hex') });
}

const c = await ouvrir();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const comptes = {};
const vides = [];
try {
  // Instantane coherent : une seule transaction en lecture seule.
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const [{ now }] = await q('select now()::text as now');

  // 1. Tables public
  const tables = (await q(`select table_name from information_schema.tables
                            where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((r) => r.table_name);
  for (const t of tables) {
    const lignes = await q(`select * from public."${t}"`);
    comptes[`public.${t}`] = lignes.length;
    if (lignes.length) ecrire(`tables/${t}.json`, lignes);
    else vides.push(t);
  }

  // 2. Comptes Supabase Auth : aucune donnee secrete (mot de passe chiffre, jetons).
  const utilisateurs = await q(`select id, aud, role, email, phone, email_confirmed_at, phone_confirmed_at, confirmed_at,
                                       last_sign_in_at, created_at, updated_at, banned_until, deleted_at, is_anonymous,
                                       is_sso_user, raw_app_meta_data, raw_user_meta_data
                                  from auth.users order by created_at`);
  comptes['auth.users'] = utilisateurs.length;
  ecrire('auth/users.json', utilisateurs);
  const identites = await q(`select id, user_id, provider, provider_id, email, created_at, updated_at, last_sign_in_at, identity_data
                               from auth.identities order by created_at`);
  comptes['auth.identities'] = identites.length;
  ecrire('auth/identities.json', identites);
  const sessions = await q(`select user_id, count(*)::int as sessions, max(created_at) as derniere
                              from auth.sessions group by 1 order by 1`);
  comptes['auth.sessions'] = sessions.reduce((s, r) => s + r.sessions, 0);
  ecrire('auth/sessions_resume.json', sessions);

  // 3. Stockage : metadonnees
  const objets = await q(`select id, bucket_id, name, owner, owner_id, created_at, updated_at, metadata
                            from storage.objects order by bucket_id, name`);
  const buckets = await q(`select id, name, public, file_size_limit, allowed_mime_types, created_at from storage.buckets order by 1`);
  comptes['storage.buckets'] = buckets.length;
  comptes['storage.objects'] = objets.length;
  ecrire('stockage/buckets.json', buckets);
  ecrire('stockage/objets.json', objets);

  // 4. Schema utile a un retour arriere
  const fonctions = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
                               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind = 'f' order by 1, 2`);
  ecrire('schema/fonctions.sql', fonctions.map((f) => `-- ${f.proname}(${f.args})\n${f.def};\n`).join('\n'));
  ecrire('schema/politiques_rls.json', await q(`select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
                                                  from pg_policies where schemaname in ('public', 'storage') order by 1, 2, 3`));
  ecrire('schema/declencheurs.json', await q(`select event_object_table as table, trigger_name, action_timing, event_manipulation, action_statement
                                                 from information_schema.triggers where trigger_schema = 'public' order by 1, 2`));
  comptes.instant_de_la_sauvegarde = now;
  await c.query('ROLLBACK');
} finally {
  await c.end();
}

// 5. Stockage : fichiers (API Storage, cle service lue dans l'environnement, jamais ecrite)
const objets = JSON.parse(readFileSync(join(dest, 'stockage/objets.json'), 'utf8'));
let telecharges = 0;
for (const o of objets) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${o.name.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) {
    console.log(`  fichier non telecharge : ${o.bucket_id}/${o.name} (HTTP ${r.status})`);
    continue;
  }
  ecrire(join('stockage', 'fichiers', o.bucket_id, ...o.name.split('/')), Buffer.from(await r.arrayBuffer()));
  telecharges++;
}
comptes.fichiers_stockage_telecharges = telecharges;

// 6. Copie du script et manifeste
copyFileSync(fileURLToPath(import.meta.url), join(dest, 'script_de_sauvegarde.mjs'));
ecrire('LISEZMOI.txt', [
  'SAUVEGARDE TIMORA — DONNEES PERSONNELLES ET BIOMETRIQUES',
  '',
  'Contenu : tables Supabase (public), comptes Auth (sans mot de passe ni jeton),',
  'fichiers du stockage (photos de pointage, avatars), modeles faciaux,',
  'definitions des fonctions / politiques / declencheurs.',
  '',
  'Ne jamais committer ce dossier, ne pas le partager, le conserver chiffre',
  '(ex. archive protegee) et le supprimer quand il n\'est plus necessaire.',
  'MANIFEST.json : nombre de lignes par table et empreinte SHA-256 de chaque fichier.',
].join('\n'));
writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ comptes, tables_vides: vides, fichiers }, null, 2));

console.log(`Sauvegarde ecrite dans : ${dest}`);
console.log(`Instant : ${comptes.instant_de_la_sauvegarde}`);
for (const [k, v] of Object.entries(comptes)) if (typeof v === 'number' && v > 0) console.log(`  ${k.padEnd(40)} ${v}`);
console.log(`  tables vides (non exportees) : ${vides.length}`);
console.log(`  fichiers ecrits : ${fichiers.length + 1} (dont MANIFEST.json)`);
