// Appels a Supabase (PostgREST, Auth, Storage), sans dependance.
//
// Le serveur de paiement appelle les fonctions de paiement avec la cle de
// service, et seulement elles peuvent l'etre (droits de la migration 033).
// L'identite de l'acheteur n'est jamais crue sur parole : son jeton de session
// est verifie aupres de Supabase Auth (verifierSession), puis la base relit le
// compte et deduit elle-meme son entreprise et ses droits.

const DELAI_MS = 10000;

/**
 * Appelle public.<fonction>(args).
 * Renvoie { ok, status, data } ou { ok: false, status, erreur: { code, hint, message } }.
 */
export async function rpc(config, fonction, args, { jeton = null } = {}) {
  const { url, cleAnonyme, cleService } = config.supabase;
  const cle = jeton ? cleAnonyme : cleService;
  let reponse;
  try {
    reponse = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(fonction)}`, {
      method: 'POST',
      headers: {
        apikey: cle,
        Authorization: `Bearer ${jeton || cleService}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      erreur: { code: 'BASE_INJOIGNABLE', hint: 'BASE_INJOIGNABLE', message: err && err.name === 'TimeoutError' ? 'Délai dépassé' : 'Base injoignable' },
    };
  }

  const texte = await reponse.text();
  let corps = null;
  try {
    corps = texte ? JSON.parse(texte) : null;
  } catch {
    corps = null;
  }

  if (!reponse.ok) {
    return {
      ok: false,
      status: reponse.status,
      erreur: {
        code: (corps && corps.code) || String(reponse.status),
        hint: (corps && corps.hint) || null,
        message: (corps && corps.message) || 'Erreur de la base',
      },
    };
  }
  return { ok: true, status: reponse.status, data: corps };
}

/**
 * Verifie un jeton de session aupres de Supabase Auth : signature, expiration
 * et existence du compte sont controlees par Supabase lui-meme.
 * Renvoie { ok: true, utilisateur: { id, email, emailVerifie } }
 *      ou { ok: false, status, code }.
 */
export async function verifierSession(config, jeton) {
  const { url, cleService } = config.supabase;
  let reponse;
  try {
    reponse = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: cleService, Authorization: `Bearer ${jeton}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(DELAI_MS),
    });
  } catch {
    return { ok: false, status: 0, code: 'AUTH_INJOIGNABLE' };
  }
  if (reponse.status === 401 || reponse.status === 403) return { ok: false, status: 401, code: 'SESSION_EXPIREE' };
  if (!reponse.ok) return { ok: false, status: reponse.status, code: 'AUTH_INDISPONIBLE' };
  const u = await reponse.json().catch(() => null);
  if (!u || typeof u.id !== 'string') return { ok: false, status: 502, code: 'AUTH_REPONSE_INATTENDUE' };
  return {
    ok: true,
    utilisateur: { id: u.id, email: typeof u.email === 'string' ? u.email : null, emailVerifie: Boolean(u.email_confirmed_at) },
  };
}

/**
 * Depose un fichier dans un bucket PRIVE (cle de service). Remplace un depot
 * precedent interrompu : le fichier n'est reference en base qu'apres ce depot.
 */
export async function deposerFichier(config, bucket, chemin, octets, type) {
  const { url, cleService } = config.supabase;
  const cible = `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${chemin.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const r = await fetch(cible, {
      method: 'POST',
      headers: {
        apikey: cleService,
        Authorization: `Bearer ${cleService}`,
        'Content-Type': type,
        'x-upsert': 'true',
        'Cache-Control': 'no-store',
      },
      body: octets,
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return { ok: true };
    return { ok: false, status: r.status, code: 'STOCKAGE_REFUSE' };
  } catch {
    return { ok: false, status: 0, code: 'STOCKAGE_INJOIGNABLE' };
  }
}

/** Copie en base d'un evenement de facturation (au mieux : n'interrompt jamais le parcours). */
export async function consignerEnBase(config, evenement, { reference = null, details = {} } = {}) {
  const r = await rpc(config, 'billing_log', {
    p_event: evenement,
    p_environment: config.environnement || null,
    p_reference: reference,
    p_detail: details,
  });
  return r.ok;
}
