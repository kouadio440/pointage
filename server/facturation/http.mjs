// Reponses HTTP communes aux routes de facturation.

export function repondre(status, corps) {
  return new Response(JSON.stringify(corps), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const FORMAT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Jeton de session Supabase transmis par le navigateur (Authorization: Bearer). */
export function jetonDe(request) {
  const entete = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(entete.trim());
  if (!m) return null;
  const jeton = m[1].trim();
  return jeton.length < 4096 && FORMAT_JWT.test(jeton) ? jeton : null;
}

/**
 * Une requete emise par une page d'un autre site est refusee. Le jeton de
 * session protege deja la route ; ce controle ferme la porte aux integrations
 * non prevues.
 */
export function origineAutorisee(request, config) {
  const origine = request.headers.get('origin');
  if (!origine) return true; // appel serveur a serveur ou navigation directe
  const permises = new Set([new URL(request.url).origin]);
  if (config.appUrl) permises.add(new URL(config.appUrl).origin);
  return permises.has(origine);
}

/** Adresse publique ou JoonaPay renverra le client apres paiement. */
export function adresseDeRetour(request, config) {
  return config.appUrl || new URL(request.url).origin;
}
