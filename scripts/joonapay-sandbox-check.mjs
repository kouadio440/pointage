#!/usr/bin/env node
/**
 * Verification de l'integration JoonaPay SANDBOX, depuis une machine dont
 * l'adresse IP est dans la liste blanche de la cle API.
 *
 *   node --env-file=.env scripts/joonapay-sandbox-check.mjs            controles sans ecriture
 *   node --env-file=.env scripts/joonapay-sandbox-check.mjs --creer    + cree puis annule un
 *                                                                      paiement de test de 100 XOF
 *
 * Ce script n'affiche JAMAIS une cle, un secret ni un en-tete d'authentification.
 * Il n'ecrit rien dans la base Timora.
 */

import { lireConfig } from '../server/facturation/config.mjs';
import { creerPaiement, lirePaiement, paysDePaiement } from '../server/facturation/joonapay.mjs';

const creer = process.argv.includes('--creer');
const ok = (m) => console.log(`  ✓ ${m}`);
const ko = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

const EXPLICATIONS = {
  AUTHENTIFICATION: 'Cles refusees : verifiez JOONAPAY_CLIENT_KEY / JOONAPAY_PRIVATE_KEY (et qu\'il s\'agit de cles SANDBOX).',
  ACCES_REFUSE: 'Acces refuse : l\'adresse IP de cette machine n\'est probablement pas dans la liste blanche de la cle.',
  LIMITE_DE_DEBIT: 'Limite de 60 requetes par minute atteinte : reessayez dans une minute.',
  INJOIGNABLE: 'JoonaPay injoignable depuis cette machine (reseau, DNS, pare-feu).',
  DELAI_DEPASSE: 'JoonaPay n\'a pas repondu dans le delai.',
};

async function ipPublique() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    return (await r.json()).ip;
  } catch {
    return 'inconnue';
  }
}

console.log('\nTIMORA — verification JoonaPay\n');

const config = lireConfig();
console.log('1. Configuration');
if (!config.ok) {
  config.manquantes.forEach((n) => ko(`variable absente : ${n}`));
  config.erreurs.forEach((e) => ko(e));
  process.exit(1);
}
ok(`environnement : ${config.environnement}`);
ok(`API : ${config.joonapay.baseUrl}`);
ok(`webhook declare : ${config.joonapay.webhookUrl}`);
if (config.environnement !== 'sandbox') {
  ko('Ce script ne sert qu\'en sandbox. Arret.');
  process.exit(1);
}

console.log('\n2. Authentification et liste blanche IP');
info(`adresse IP publique de cette machine : ${await ipPublique()}`);
const pays = await paysDePaiement(config, "Côte d'Ivoire");
if (!pays.ok) {
  ko(`GET /misc : ${pays.code}${pays.status ? ` (HTTP ${pays.status})` : ''}`);
  if (EXPLICATIONS[pays.code]) info(EXPLICATIONS[pays.code]);
  process.exit(1);
}
ok(`cles acceptees, IP autorisee (GET /misc) — pays de paiement ${pays.code}`);

console.log('\n3. Webhook deploye');
try {
  const r = await fetch(config.joonapay.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"event":"verification"}',
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 401) ok('en ligne, et refuse une notification non signee (HTTP 401)');
  else if (r.status === 503) ko('en ligne mais NON CONFIGURE (HTTP 503) : variables JOONAPAY_* / SUPABASE_* absentes sur Vercel');
  else if (r.status === 404) ko('introuvable (HTTP 404) : la route n\'est pas deployee a cette adresse');
  else ko(`reponse inattendue : HTTP ${r.status}`);
} catch {
  ko('injoignable depuis Internet');
}

if (!creer) {
  console.log('\n(Ajoutez --creer pour tester la creation, la lecture et l\'annulation d\'un paiement de 100 XOF en sandbox.)\n');
  process.exit(0);
}

console.log('\n4. Paiement de test (sandbox, 100 XOF)');
const reference = `TIMORA-CHECK-${Date.now()}`;
const cree = await creerPaiement(config, {
  amount: 100,
  currency: 'XOF',
  country_uuid: pays.uuid,
  due_date: new Date().toISOString().slice(0, 10),
  customer_name: 'Verification Timora',
  description: 'Verification technique Timora (sandbox)',
  merchant_transaction_id: reference,
  webhook_url: config.joonapay.webhookUrl,
  allow_partial_payment: false,
});
if (!cree.ok) {
  ko(`POST /payments : ${cree.code} (HTTP ${cree.status})${cree.champs && cree.champs.length ? ` — champs : ${cree.champs.join(', ')}` : ''}`);
  if (cree.message) info(`message JoonaPay : ${cree.message}`);
  process.exit(1);
}
const d = cree.data || {};
ok(`cree : uuid ${d.uuid}, reference ${d.reference}, statut ${d.status}/${d.payment_status}`);
info(`lien de paiement : ${d.payment_link}`);
info(`champs recus : ${Object.keys(d).sort().join(', ')}`);

const lu = await lirePaiement(config, d.uuid);
if (!lu.ok) {
  ko(`GET /payments/{uuid} : ${lu.code} (HTTP ${lu.status})`);
} else {
  const p = lu.data || {};
  ok(`relu : statut ${p.status}/${p.payment_status}, montant ${p.amount} ${p.currency}, merchant_transaction_id ${p.merchant_transaction_id === reference ? 'conforme' : `DIFFERENT (${p.merchant_transaction_id})`}`);
  info(`champs recus : ${Object.keys(p).sort().join(', ')}`);
}

try {
  const r = await fetch(`${config.joonapay.baseUrl}/payments/${encodeURIComponent(d.uuid)}/cancel`, {
    method: 'POST',
    headers: {
      'X-Client-Key': config.joonapay.cleClient,
      'X-Private-Key': config.joonapay.clePrivee,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (r.ok) ok('paiement de test annule');
  else ko(`annulation : HTTP ${r.status} (le paiement expirera de lui-meme)`);
} catch {
  ko('annulation impossible (le paiement expirera de lui-meme)');
}
console.log('');
