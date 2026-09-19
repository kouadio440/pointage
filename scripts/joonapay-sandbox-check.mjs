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

import dns from 'node:dns';
import { lireConfig, HOTES_SANDBOX_JOONAPAY } from '../server/facturation/config.mjs';
import { creerPaiement, lirePaiement, paysDePaiement } from '../server/facturation/joonapay.mjs';

const HOTE_PRODUCTION = 'https://apis.joonapay.com/api/v1/developer';

// La liste blanche JoonaPay contient des adresses IPv4. Sur une connexion qui
// dispose aussi d'IPv6, Node joindrait JoonaPay en IPv6 et serait refuse
// (« IP address not authorized ») : on sort en IPv4 en priorite.
dns.setDefaultResultOrder('ipv4first');
const creer = process.argv.includes('--creer');
const ok = (m) => console.log(`  ✓ ${m}`);
const ko = (m) => console.log(`  ✗ ${m}`);
const info = (m) => console.log(`    ${m}`);

const EXPLICATIONS = {
  AUTHENTIFICATION: 'JoonaPay ne reconnait pas ces cles dans cet environnement (« Invalid API credentials »).',
  IP_NON_AUTORISEE: 'Les cles sont reconnues, mais l\'adresse IP de cette machine n\'est pas dans la liste blanche de la cle.',
  ACCES_REFUSE: 'Requete refusee par JoonaPay (droits de la cle).',
  LIMITE_DE_DEBIT: 'Limite de 60 requetes par minute atteinte : reessayez dans une minute.',
  INJOIGNABLE: 'JoonaPay injoignable depuis cette machine (reseau, DNS, pare-feu).',
  DELAI_DEPASSE: 'JoonaPay n\'a pas repondu dans le delai.',
};

async function ipPublique(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return (await r.json()).ip;
  } catch {
    return 'aucune';
  }
}

/**
 * Les cles sont refusees : un autre hote JoonaPay les reconnait-il ?
 * Une seule requete de LECTURE (donnees de reference) par hote ; aucun
 * paiement n'est cree.
 */
async function reconnues(base, config) {
  try {
    const r = await fetch(`${base}/misc`, {
      headers: { 'X-Client-Key': config.joonapay.cleClient, 'X-Private-Key': config.joonapay.clePrivee, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => null);
    return r.ok || /ip address not authori[sz]ed/i.test((j && j.message) || '');
  } catch {
    return false;
  }
}

async function verifier() {
  console.log('\nTIMORA — verification JoonaPay\n');

  const config = lireConfig();
  console.log('1. Configuration');
  if (!config.ok) {
    config.manquantes.forEach((n) => ko(`variable absente : ${n}`));
    config.erreurs.forEach((e) => ko(e));
    return 1;
  }
  ok(`environnement : ${config.environnement}`);
  ok(`API : ${config.joonapay.baseUrl}`);
  ok(`webhook declare : ${config.joonapay.webhookUrl}`);
  if (config.environnement !== 'sandbox') {
    ko('Ce script ne sert qu\'en sandbox. Arret.');
    return 1;
  }

  console.log('\n2. Authentification et liste blanche IP');
  // Adresse que la machine utilise d'elle-meme (souvent IPv6), puis retour a
  // IPv4 pour tous les appels a JoonaPay.
  dns.setDefaultResultOrder('verbatim');
  const prefere = await ipPublique('https://api64.ipify.org?format=json');
  dns.setDefaultResultOrder('ipv4first');
  const ipv4 = await ipPublique('https://api.ipify.org?format=json');
  info(`adresse IPv4 publique de cette machine : ${ipv4} (a declarer sur la cle JoonaPay)`);
  if (prefere.includes(':')) info(`cette machine a aussi l'IPv6 ${prefere} : les appels de ce script partent en IPv4`);
  const pays = await paysDePaiement(config, "Côte d'Ivoire");
  if (!pays.ok) {
    ko(`GET /misc : ${pays.code}${pays.status ? ` (HTTP ${pays.status})` : ''}`);
    if (EXPLICATIONS[pays.code]) info(EXPLICATIONS[pays.code]);
    if (pays.code === 'AUTHENTIFICATION') {
      // Deux hotes sandbox existent (portail et documentation) : les cles
      // fournies par JoonaPay peuvent viser l'autre.
      const autres = HOTES_SANDBOX_JOONAPAY.map((h) => `https://${h}/api/v1/developer`).filter((b) => b !== config.joonapay.baseUrl);
      let autre = null;
      for (const b of autres) if (!autre && await reconnues(b, config)) autre = b;
      if (autre) {
        info(`Ces cles sont reconnues par l'autre sandbox JoonaPay : mettez JOONAPAY_BASE_URL=${autre}`);
      } else if (await reconnues(HOTE_PRODUCTION, config)) {
        info('Ces cles sont reconnues par la PRODUCTION JoonaPay : ce sont des cles de production, pas de sandbox.');
        info('Le portail JoonaPay ne cree que des cles de production. Les cles sandbox sont fournies par JoonaPay :');
        info('« demandez-les a votre contact Joonapay » (docs.joonapay.com/fr/introduction, section Environnements).');
      }
    }
    return 1;
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
    return 0;
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
    return 1;
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
  return 0;
}

// Code de sortie pose sans process.exit() : sous Windows, quitter pendant la
// fermeture d'une connexion fetch provoque une assertion de libuv.
process.exitCode = await verifier();
