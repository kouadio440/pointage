#!/usr/bin/env node
// Diagnostic du serveur de paiement, a lancer SUR le serveur :
//   node --env-file=/etc/timora-payments/env scripts/diagnostic.mjs
//
// N'affiche jamais une cle ni un secret : seulement des noms de variables et
// des resultats (OK / echec). Ne cree aucun paiement.

import dns from 'node:dns';
import { lireConfigServeurPaiement } from '../../../server/facturation/config.mjs';
import { rpc } from '../../../server/facturation/supabase.mjs';
import { paysDePaiement } from '../../../server/facturation/joonapay.mjs';
import { creerTransport } from '../src/courriel.mjs';

dns.setDefaultResultOrder('ipv4first');
const ok = (m) => console.log(`  ✓ ${m}`);
const ko = (m) => console.log(`  ✗ ${m}`);

async function ip(url) {
  try {
    return (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json()).ip;
  } catch {
    return null;
  }
}

async function principal() {
  let echecs = 0;
  console.log('\nTIMORA — diagnostic du serveur de paiement\n');

  console.log('1. Configuration');
  const config = lireConfigServeurPaiement(process.env);
  if (!config.ok) {
    config.manquantes.forEach((n) => ko(`variable absente : ${n}`));
    config.erreurs.forEach((e) => ko(e));
    return 1;
  }
  ok(`environnement JoonaPay : ${config.environnement} (${config.joonapay.baseUrl})`);
  ok(`webhook declare : ${config.joonapay.webhookUrl}`);
  ok(`retours apres paiement : ${config.appUrl}`);
  ok(`ecoute locale : ${config.ecoute.hote}:${config.ecoute.port}`);
  console.log(`    test de production (serveur) : ${config.testProduction.active ? 'ACTIVE' : 'desactive'}`);

  console.log('\n2. Adresse IP publique (a declarer dans la liste blanche JoonaPay)');
  const v4 = await ip('https://api.ipify.org?format=json');
  if (v4) ok(`IPv4 publique : ${v4}`);
  else { ko('IPv4 publique introuvable'); echecs++; }

  console.log('\n3. Supabase (cle de service)');
  const etat = await rpc(config, 'billing_smoke_test_state', {});
  if (etat.ok) ok(`base joignable, migration 033 presente, facturation en mode ${etat.data.mode_facturation}`);
  else { ko(`base : ${etat.erreur.code} (migration 033 appliquee ? cle de service ?)`); echecs++; }
  if (etat.ok && etat.data.mode_facturation !== config.environnement) {
    ko(`mode de la base (${etat.data.mode_facturation}) different du serveur (${config.environnement}) : aucun paiement ne demarrera`);
    echecs++;
  }

  console.log('\n4. JoonaPay (lecture seule, aucun paiement cree)');
  const pays = await paysDePaiement(config, "Côte d'Ivoire");
  if (pays.ok) ok(`cles acceptees, IP autorisee — pays de paiement ${pays.code}`);
  else {
    ko(`GET /misc : ${pays.code}${pays.status ? ` (HTTP ${pays.status})` : ''}`);
    if (pays.code === 'IP_NON_AUTORISEE') console.log(`    Declarez ${v4 || 'l\'IPv4 de ce serveur'} dans la liste blanche de la cle JoonaPay.`);
    if (pays.code === 'AUTHENTIFICATION') console.log('    Cles refusees : cles de production ? bien copiees ?');
    echecs++;
  }

  console.log('\n5. Messagerie');
  if (!config.courriel) {
    ko('SMTP non configure : les recus sont crees, les e-mails attendent');
  } else {
    try {
      await creerTransport(config.courriel).verify();
      ok(`serveur SMTP joignable et identifiants acceptes (${config.courriel.hote}:${config.courriel.port})`);
    } catch (e) {
      ko(`SMTP : ${e && e.code ? e.code : 'echec'}`);
      echecs++;
    }
  }

  console.log('\n6. Adresse publique du serveur');
  try {
    const r = await fetch(new URL('/health', config.joonapay.webhookUrl), { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.status === 'ok') ok(`${new URL(config.joonapay.webhookUrl).origin}/health repond en HTTPS`);
    else { ko(`/health : HTTP ${r.status}`); echecs++; }
  } catch {
    ko('adresse publique injoignable (DNS ? Caddy ? pare-feu 443 ?)');
    echecs++;
  }

  console.log(echecs ? `\n${echecs} point(s) a corriger.\n` : '\nTout est pret.\n');
  return echecs ? 1 : 0;
}

process.exitCode = await principal();
