#!/usr/bin/env node
/**
 * Verification du serveur de paiement, SANS ARGENT : aucun paiement n'est cree.
 *
 *   node --env-file=.env scripts/verifier-serveur-paiement.mjs
 *   node scripts/verifier-serveur-paiement.mjs --url https://payments.timora.tech --ip 15.236.1.218
 *
 * Controle : DNS, certificat TLS, redirection HTTP -> HTTPS, /health, en-tetes
 * de securite, absence de CORS, route inconnue, et tous les refus de
 * l'authentification interne (sans signature, mauvais secret, horodatage
 * expire, nonce rejoue, jeton remplace) ainsi que le webhook non signe.
 *
 * INTERNAL_PAYMENT_API_SECRET (meme valeur que sur le serveur) active les
 * controles signes ; sans lui, ils sont annonces comme non verifies.
 * Aucun secret n'est affiche.
 */

import dns from 'node:dns/promises';
import tls from 'node:tls';
import { signer } from '../server/passerelle/signature.mjs';

const args = process.argv.slice(2);
const option = (nom, defaut) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const URL_SERVEUR = (option('url', process.env.PAYMENT_SERVER_URL || 'https://payments.timora.tech')).replace(/\/+$/, '');
const IP_ATTENDUE = option('ip', process.env.PAYMENT_SERVER_IP || '15.236.1.218');
const SECRET = (process.env.INTERNAL_PAYMENT_API_SECRET || '').trim();
const HOTE = new URL(URL_SERVEUR).hostname;
// Jeton de session volontairement invalide : la requete s'arrete a la
// verification du compte, aucun paiement n'est prepare.
const JETON_FACTICE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZXJpZmljYXRpb24ifQ.signature';

let ok = 0;
let ko = 0;
let ignores = 0;
const vert = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const rouge = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const gris = (m) => console.log(`  \x1b[90m•\x1b[0m ${m}`);
const verifier = (condition, message, detail = '') => {
  if (condition) { ok++; vert(message); } else { ko++; rouge(`${message}${detail ? ` — ${detail}` : ''}`); }
};
const ignorer = (message) => { ignores++; gris(message); };

async function appeler(chemin, { methode = 'GET', corps = null, entetes = {}, suivre = 'manual', base = URL_SERVEUR } = {}) {
  try {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: entetes,
      body: corps ?? undefined,
      redirect: suivre,
      signal: AbortSignal.timeout(15000),
    });
    let json = null;
    const texte = await r.text();
    try { json = texte ? JSON.parse(texte) : null; } catch { json = null; }
    return { status: r.status, entetes: r.headers, corps: json, texte };
  } catch (e) {
    return { erreur: e.message };
  }
}

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(HOTE) || URL_SERVEUR.startsWith('http://');
console.log(`\nTIMORA — verification du serveur de paiement ${URL_SERVEUR}\n(aucun paiement n'est cree)\n`);

// 1. DNS ----------------------------------------------------------------------
console.log('1. DNS');
if (local) {
  ignorer('adresse locale : DNS, certificat et redirection HTTPS non verifies');
} else {
try {
  const adresses = await dns.resolve4(HOTE);
  verifier(adresses.includes(IP_ATTENDUE), `${HOTE} pointe vers ${IP_ATTENDUE}`, `trouve : ${adresses.join(', ')}`);
} catch (e) {
  verifier(false, `${HOTE} resolu`, e.code || e.message);
}

// 2. Certificat TLS -----------------------------------------------------------
console.log('\n2. Certificat TLS');
const cert = await new Promise((resoudre) => {
  const s = tls.connect({ host: HOTE, port: 443, servername: HOTE, timeout: 10000 }, () => {
    const c = s.getPeerCertificate();
    s.destroy();
    resoudre({ ok: s.authorized !== false, cert: c });
  });
  s.on('error', (e) => resoudre({ erreur: e.message }));
  s.on('timeout', () => { s.destroy(); resoudre({ erreur: 'delai depasse' }); });
});
if (cert.erreur) {
  verifier(false, 'certificat valide', cert.erreur);
} else {
  const noms = [cert.cert.subject && cert.cert.subject.CN, ...String(cert.cert.subjectaltname || '').split(/,\s*/).map((s) => s.replace('DNS:', ''))].filter(Boolean);
  verifier(noms.includes(HOTE), `certificat au nom de ${HOTE}`, noms.join(', '));
  verifier(cert.ok, 'certificat reconnu (chaine de confiance)');
  verifier(new Date(cert.cert.valid_to) > new Date(), `certificat valable jusqu'au ${cert.cert.valid_to}`);
}

// 3. HTTP -> HTTPS ------------------------------------------------------------
const enClair = await appeler('/health', { base: `http://${HOTE}` });
verifier(!enClair.erreur && [301, 302, 307, 308].includes(enClair.status)
  && /^https:/.test(enClair.entetes.get('location') || ''), 'HTTP redirige vers HTTPS',
  enClair.erreur || `HTTP ${enClair.status}`);
}

// 4. /health ------------------------------------------------------------------
console.log('\n3. Sante');
const sante = await appeler('/health');
verifier(!sante.erreur && sante.status === 200 && sante.corps && sante.corps.status === 'ok',
  'GET /health repond {"status":"ok"}', sante.erreur || `HTTP ${sante.status}`);
verifier(!/secret|key|supabase|joonapay|token|password/i.test(sante.texte || ''), '/health ne divulgue rien');

// 5. En-tetes de securite -----------------------------------------------------
console.log('\n4. En-tetes de securite');
const e = sante.entetes || new Headers();
verifier(/max-age=\d+/.test(e.get('strict-transport-security') || ''), 'Strict-Transport-Security');
verifier((e.get('x-content-type-options') || '') === 'nosniff', 'X-Content-Type-Options: nosniff');
verifier(/no-referrer|strict-origin/.test(e.get('referrer-policy') || ''), 'Referrer-Policy');
verifier(/DENY|SAMEORIGIN/i.test(e.get('x-frame-options') || '') || /frame-ancestors/.test(e.get('content-security-policy') || ''), 'protection contre l\'inclusion en cadre');
verifier(!e.get('access-control-allow-origin'), 'aucun en-tete CORS');

// 6. Routes -------------------------------------------------------------------
console.log('\n5. Routes');
const inconnue = await appeler('/administration');
verifier(inconnue.status === 404, 'route inconnue : 404', `HTTP ${inconnue.status}`);
const sansSignature = await appeler('/api/payments/checkout', {
  methode: 'POST', corps: JSON.stringify({ plan: 'essentiel' }), entetes: { 'Content-Type': 'application/json' },
});
verifier(sansSignature.status === 401 && sansSignature.corps && sansSignature.corps.code === 'SIGNATURE_INTERNE_REFUSEE',
  'POST /api/payments/checkout sans signature : 401', `HTTP ${sansSignature.status}`);
const webhookNonSigne = await appeler('/api/webhooks/joonapay', {
  methode: 'POST', corps: JSON.stringify({ event: 'payment.completed', data: {} }), entetes: { 'Content-Type': 'application/json' },
});
verifier(webhookNonSigne.status === 401, 'webhook sans signature : 401', `HTTP ${webhookNonSigne.status}`);
const webhookFaux = await appeler('/api/webhooks/joonapay', {
  methode: 'POST', corps: JSON.stringify({ event: 'payment.completed', data: {} }),
  entetes: { 'Content-Type': 'application/json', 'X-Webhook-Signature': `sha256=${'0'.repeat(64)}` },
});
verifier(webhookFaux.status === 401, 'webhook a signature falsifiee : 401', `HTTP ${webhookFaux.status}`);

// 7. Authentification interne -------------------------------------------------
console.log('\n6. Authentification interne (signature HMAC)');
if (!SECRET || SECRET.length < 32) {
  ignorer('INTERNAL_PAYMENT_API_SECRET absent : controles signes non effectues');
} else {
  const chemin = '/api/payments/checkout';
  const corps = JSON.stringify({ plan: 'essentiel', period: 'MONTHLY' });
  const envoyer = (entetes) => appeler(chemin, { methode: 'POST', corps, entetes: { 'Content-Type': 'application/json', ...entetes } });

  const mauvais = await envoyer(signer({ secret: 'x'.repeat(48), methode: 'POST', chemin, corps, jeton: JETON_FACTICE }));
  verifier(mauvais.status === 401 && mauvais.corps && mauvais.corps.code === 'SIGNATURE_INTERNE_REFUSEE',
    'mauvais secret : 401', `HTTP ${mauvais.status}`);

  const vieux = await envoyer(signer({ secret: SECRET, methode: 'POST', chemin, corps, jeton: JETON_FACTICE, maintenant: Date.now() - 6 * 60 * 1000 }));
  verifier(vieux.status === 401 && vieux.corps && vieux.corps.code === 'SIGNATURE_INTERNE_REFUSEE',
    'horodatage de plus de 5 minutes : 401', `HTTP ${vieux.status}`);

  const entetesBonnes = signer({ secret: SECRET, methode: 'POST', chemin, corps, jeton: JETON_FACTICE });
  const modifie = await appeler(chemin, {
    methode: 'POST', corps: JSON.stringify({ plan: 'pro', period: 'MONTHLY' }),
    entetes: { 'Content-Type': 'application/json', ...entetesBonnes },
  });
  verifier(modifie.status === 401 && modifie.corps && modifie.corps.code === 'SIGNATURE_INTERNE_REFUSEE',
    'corps modifie apres signature : 401', `HTTP ${modifie.status}`);

  // Signature valide : la requete est acceptee, puis REFUSEE a la verification
  // du compte (jeton factice). Aucun paiement n'est prepare.
  const valides = signer({ secret: SECRET, methode: 'POST', chemin, corps, jeton: JETON_FACTICE });
  const premier = await envoyer(valides);
  const codePremier = premier.corps && premier.corps.code;
  if (premier.status === 503 && codePremier === 'VERIFICATION_IMPOSSIBLE') {
    verifier(false, 'signature valide acceptee, mais SUPABASE INJOIGNABLE depuis le serveur',
      'verifiez SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY et la sortie Internet du serveur');
  } else {
    verifier(premier.status === 401 && ['SESSION_EXPIREE', 'SESSION_REQUISE'].includes(codePremier),
      'signature valide acceptee, puis session refusee (aucun paiement cree)', `HTTP ${premier.status} ${codePremier}`);
  }
  const rejoue = await envoyer(valides);
  verifier(rejoue.status === 401 && rejoue.corps && rejoue.corps.code === 'SIGNATURE_INTERNE_REFUSEE',
    'meme requete rejouee (nonce deja vu) : 401', `HTTP ${rejoue.status} ${rejoue.corps && rejoue.corps.code}`);

  const statut = await appeler('/api/payments/TIMORA-SUB-20260101-AAAAAAAA/status', {
    methode: 'GET',
    entetes: signer({ secret: SECRET, methode: 'GET', chemin: '/api/payments/TIMORA-SUB-20260101-AAAAAAAA/status', corps: '', jeton: JETON_FACTICE }),
  });
  verifier(statut.status === 401 || (statut.status === 503 && premier.status === 503),
    'consultation d\'un paiement sans session valide : refusee', `HTTP ${statut.status}`);
}

console.log(`\n${ko === 0 ? 'SERVEUR CONFORME' : `${ko} POINT(S) A CORRIGER`} — ${ok} controle(s) reussi(s)${ignores ? `, ${ignores} non verifie(s)` : ''}\n`);
process.exitCode = ko ? 1 : 0;
