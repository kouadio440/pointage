// Client JoonaPay — cote serveur uniquement.
//
// Contrat tire de la documentation officielle (docs.joonapay.com/fr/api) :
//   Authentification  en-tetes X-Client-Key et X-Private-Key
//   Donnees de ref.   GET  /misc                  -> data.countries[] (uuid, code, currency, payment_enabled)
//   Creation          POST /payments              -> 201, data.uuid, data.reference, data.payment_link
//   Detail            GET  /payments/{uuid}       -> data.status, data.payment_status, data.amount,
//                                                    data.paid_amount, data.currency, data.merchant_transaction_id
//   Webhook           en-tete x-webhook-signature = « sha256= » + HMAC-SHA256 hex du corps brut
//   Enveloppe         { success, message, data, errors: { code, details }, metadata: { request_id } }
//   Limite            60 requetes par minute (HTTP 429)
//
// Les statuts sont traites comme des chaines libres (la documentation le
// demande) : un statut inconnu n'active jamais rien.

import { createHmac, timingSafeEqual } from 'node:crypto';

const DELAI_MS = 15000;
const DUREE_CACHE_PAYS_MS = 60 * 60 * 1000;
let cachePays = { expire: 0, base: '', pays: [] };

/**
 * Classe une reponse non conforme en un code stable pour Timora.
 *
 * Constate sur l'API reelle (2026-09-18) : JoonaPay repond 401 dans les deux
 * cas « cles inconnues de cet environnement » (« Invalid API credentials ») et
 * « cles valides, adresse IP hors liste blanche » (« IP address not
 * authorized »). Seul le message les distingue.
 */
function classer(status, message) {
  if (status === 401 && /ip address not authori[sz]ed/i.test(message || '')) return 'IP_NON_AUTORISEE';
  if (status === 401) return 'AUTHENTIFICATION';
  if (status === 403) return 'ACCES_REFUSE';
  if (status === 404) return 'INTROUVABLE';
  if (status === 400 || status === 422) return 'REQUETE_REFUSEE';
  if (status === 429) return 'LIMITE_DE_DEBIT';
  if (status >= 500) return 'ERREUR_FOURNISSEUR';
  return 'REPONSE_INATTENDUE';
}

async function appeler(config, methode, chemin, corps) {
  const { baseUrl, cleClient, clePrivee } = config.joonapay;
  let reponse;
  try {
    reponse = await fetch(`${baseUrl}${chemin}`, {
      method: methode,
      headers: {
        'X-Client-Key': cleClient,
        'X-Private-Key': clePrivee,
        Accept: 'application/json',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: err && err.name === 'TimeoutError' ? 'DELAI_DEPASSE' : 'INJOIGNABLE',
      message: 'JoonaPay ne répond pas.',
    };
  }

  const texte = await reponse.text();
  let json = null;
  try {
    json = texte ? JSON.parse(texte) : null;
  } catch {
    json = null;
  }

  const requestId = json && json.metadata ? json.metadata.request_id || null : null;
  if (!reponse.ok || !json || json.success === false) {
    const champs = json && json.errors && json.errors.details && typeof json.errors.details === 'object'
      ? Object.keys(json.errors.details).slice(0, 10)
      : [];
    return {
      ok: false,
      status: reponse.status,
      code: reponse.ok ? 'REPONSE_INATTENDUE' : classer(reponse.status, json && json.message),
      codeFournisseur: json && json.errors ? json.errors.code || null : null,
      message: json && typeof json.message === 'string' ? json.message.slice(0, 200) : null,
      champs,
      requestId,
    };
  }
  return { ok: true, status: reponse.status, data: json.data, requestId };
}

const normaliser = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z]/g, '');

/**
 * UUID JoonaPay du pays de paiement. Le pays de l'entreprise est retenu s'il
 * est ouvert au paiement en XOF ; sinon le pays par defaut de la configuration.
 */
export async function paysDePaiement(config, paysEntreprise) {
  const { baseUrl, paysParDefaut } = config.joonapay;
  if (cachePays.expire < Date.now() || cachePays.base !== baseUrl) {
    const r = await appeler(config, 'GET', '/misc?payment_enabled=true');
    if (!r.ok) return { ok: false, code: r.code, status: r.status, requestId: r.requestId };
    const liste = r.data && Array.isArray(r.data.countries) ? r.data.countries : [];
    cachePays = {
      expire: Date.now() + DUREE_CACHE_PAYS_MS,
      base: baseUrl,
      pays: liste.filter((p) => p && p.uuid && p.payment_enabled !== false && String(p.currency || '').toUpperCase() === 'XOF'),
    };
  }

  const cible = normaliser(paysEntreprise);
  const trouve = (cible && cachePays.pays.find((p) => normaliser(p.name) === cible || normaliser(p.code) === cible))
    || cachePays.pays.find((p) => String(p.code || '').toUpperCase() === paysParDefaut);
  if (!trouve) return { ok: false, code: 'PAYS_INDISPONIBLE', status: 0 };
  return { ok: true, uuid: trouve.uuid, code: trouve.code };
}

export function creerPaiement(config, corps) {
  return appeler(config, 'POST', '/payments', corps);
}

export function lirePaiement(config, uuid) {
  return appeler(config, 'GET', `/payments/${encodeURIComponent(uuid)}`);
}

/**
 * Signature d'un webhook : HMAC-SHA256 (hex) du corps BRUT, avec le secret
 * webhook, transmis dans x-webhook-signature sous la forme « sha256=<hex> ».
 * Comparaison a temps constant.
 */
export function signatureValide(corpsBrut, entete, secret) {
  if (!entete || !secret || !corpsBrut) return false;
  const recue = String(entete).trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recue)) return false;
  const attendue = createHmac('sha256', secret).update(corpsBrut).digest();
  return timingSafeEqual(attendue, Buffer.from(recue, 'hex'));
}
