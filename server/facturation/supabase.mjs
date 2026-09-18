// Appels aux fonctions de la base (PostgREST), sans dependance.
//
// Deux identites seulement :
//   - l'acheteur, avec SON jeton de session : la base deduit elle-meme son
//     entreprise et ses droits (auth.uid()), rien n'est cru sur parole ;
//   - le serveur, avec la cle de service : reserve aux fonctions que le
//     navigateur ne peut pas appeler (rattacher un checkout, appliquer un etat
//     confirme par JoonaPay, journal).

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
