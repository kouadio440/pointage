// Cote Vercel : relais signe vers le serveur de paiement (payments.timora.tech).
//
// Vercel ne detient AUCUNE cle JoonaPay ni la cle de service Supabase : il
// verifie la forme de la requete du navigateur, puis la transmet, signee
// (HMAC, INTERNAL_PAYMENT_API_SECRET), avec le jeton de session de l'acheteur.
// Le serveur de paiement verifie la signature, puis le jeton aupres de
// Supabase Auth, puis decide de tout (montant compris).

import { signer } from './signature.mjs';

const DELAI_MS = 25000;
const LOCAL = /^(localhost|127\.0\.0\.1)$/;

export function lireConfigPasserelle(env = process.env) {
  const url = String(env.PAYMENT_SERVER_URL || '').trim().replace(/\/+$/, '');
  const secret = String(env.INTERNAL_PAYMENT_API_SECRET || '').trim();
  const manquantes = [];
  const erreurs = [];
  if (!url) manquantes.push('PAYMENT_SERVER_URL');
  if (!secret) manquantes.push('INTERNAL_PAYMENT_API_SECRET');
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && !LOCAL.test(u.hostname)) erreurs.push('PAYMENT_SERVER_URL doit etre en HTTPS.');
    } catch {
      erreurs.push('PAYMENT_SERVER_URL n\'est pas une URL.');
    }
  }
  if (secret && secret.length < 32) erreurs.push('INTERNAL_PAYMENT_API_SECRET doit faire au moins 32 caracteres.');
  const appUrl = String(env.TIMORA_APP_URL || '').trim().replace(/\/+$/, '');
  return { ok: manquantes.length === 0 && erreurs.length === 0, manquantes, erreurs, url, secret, appUrl };
}

/**
 * Appel signe. Renvoie { status, corps } ; un serveur injoignable donne 503.
 * Les redirections ne sont jamais suivies (un corps signe ne part pas ailleurs).
 */
export async function appelerServeurPaiement(conf, { methode, chemin, corps = null, jeton = null }) {
  const texte = corps === null ? '' : JSON.stringify(corps);
  const entetes = { Accept: 'application/json', ...signer({ secret: conf.secret, methode, chemin, corps: texte, jeton }) };
  if (texte) entetes['Content-Type'] = 'application/json';
  let reponse;
  try {
    reponse = await fetch(`${conf.url}${chemin}`, {
      method: methode,
      headers: entetes,
      body: texte || undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch {
    return { status: 503, injoignable: true, corps: { code: 'SERVEUR_PAIEMENT_INJOIGNABLE', message: 'Le paiement en ligne est momentanément indisponible. Aucun montant n\'a été débité. Réessayez dans quelques minutes.' } };
  }
  let json = null;
  try {
    json = await reponse.json();
  } catch {
    json = null;
  }
  return { status: reponse.status, corps: json && typeof json === 'object' ? json : {} };
}
