#!/usr/bin/env node
// Test de production unique (montant reduit) : etat, activation, desactivation.
//
//   node --env-file=/etc/timora-payments/env scripts/test-production.mjs etat
//   node --env-file=/etc/timora-payments/env scripts/test-production.mjs activer premier@client.ci
//   node --env-file=/etc/timora-payments/env scripts/test-production.mjs desactiver
//
// L'adresse n'est jamais stockee : seule son empreinte SHA-256 (adresse en
// minuscules, sans espaces) part en base. Le script affiche aussi cette
// empreinte, a recopier (facultatif) dans PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH.
// Une fois le paiement de test confirme, le test est consomme : il ne se
// reactive plus jamais (la base le refuse).

import { createHash } from 'node:crypto';
import { lireConfigServeurPaiement } from '../../../server/facturation/config.mjs';
import { rpc } from '../../../server/facturation/supabase.mjs';

const [action, adresse] = process.argv.slice(2);
const config = lireConfigServeurPaiement(process.env);
if (!config.supabase.url || !config.supabase.cleService) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.');
  process.exit(1);
}

function afficherEtat(e) {
  console.log(`  actif               : ${e.enabled ? 'OUI' : 'non'}`);
  console.log(`  consomme            : ${e.consumed ? 'OUI (definitif)' : 'non'}  (${e.uses}/${e.max_uses})`);
  console.log(`  montant de test     : ${e.amount} XOF`);
  console.log(`  mode de facturation : ${e.mode_facturation}`);
  console.log(`  compte autorise     : ${e.compte_autorise_configure ? 'configure (empreinte)' : 'aucun'}`);
  console.log(`  entreprise liee     : ${e.bound_company_id || '-'}`);
  console.log(`  paiement reserve    : ${e.reserved_payment_reference || '-'}`);
  console.log(`  paiement consomme   : ${e.consumed_payment_reference || '-'}${e.consumed_at ? ` le ${e.consumed_at}` : ''}`);
}

async function principal() {
  if (action === 'etat') {
    const r = await rpc(config, 'billing_smoke_test_state', {});
    if (!r.ok) throw new Error(r.erreur.message);
    console.log('Test de production :');
    afficherEtat(r.data);
    console.log(`  serveur (variables) : ${config.testProduction.active ? 'ACTIVE' : 'desactive'}${config.testProduction.empreinteEmail ? ', empreinte imposee' : ''}`);
    return 0;
  }

  if (action === 'activer') {
    const normalisee = String(adresse || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalisee)) {
      console.error('Usage : activer <adresse e-mail du compte de test>');
      return 1;
    }
    const empreinte = createHash('sha256').update(normalisee).digest('hex');
    const r = await rpc(config, 'billing_smoke_test_configure', { p_email_sha256: empreinte, p_amount: config.testProduction.montant || 100 });
    if (!r.ok) {
      console.error(`Refuse : ${r.erreur.message}${r.erreur.hint ? ` (${r.erreur.hint})` : ''}`);
      return 1;
    }
    console.log('Test de production ACTIVE en base :');
    afficherEtat(r.data);
    console.log(`\nEmpreinte du compte autorise : ${empreinte}`);
    console.log('Sur ce serveur, dans le fichier d\'environnement : PRODUCTION_SMOKE_TEST_ENABLED=true');
    console.log(`(facultatif, double controle) PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH=${empreinte}`);
    console.log('puis : sudo systemctl restart timora-payments');
    return 0;
  }

  if (action === 'desactiver') {
    const r = await rpc(config, 'billing_smoke_test_disable', {});
    if (!r.ok) throw new Error(r.erreur.message);
    console.log('Test de production DESACTIVE en base :');
    afficherEtat(r.data);
    console.log('\nSur ce serveur : PRODUCTION_SMOKE_TEST_ENABLED=false, puis sudo systemctl restart timora-payments');
    return 0;
  }

  console.error('Usage : etat | activer <email> | desactiver');
  return 1;
}

process.exitCode = await principal().catch((e) => {
  console.error(`Erreur : ${e.message}`);
  return 1;
});
