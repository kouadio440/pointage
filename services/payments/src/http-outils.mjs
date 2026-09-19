// Outils HTTP du serveur de paiement : lecture bornee du corps, reponses JSON
// avec en-tetes de securite, adresse du client derriere le proxy local.
//
// Aucune route n'est destinee a un navigateur : aucun en-tete CORS n'est
// jamais emis (pas d'Access-Control-Allow-Origin), les pages web ne peuvent
// donc pas lire les reponses.

export const ENTETES_SECURITE = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
});

export function repondreJson(res, status, corps, entetes = {}) {
  if (res.headersSent) return;
  const texte = JSON.stringify(corps ?? {});
  res.writeHead(status, { ...ENTETES_SECURITE, ...entetes, 'Content-Length': Buffer.byteLength(texte) });
  res.end(texte);
}

export class CorpsTropGrand extends Error {}

/** Lit le corps brut, au plus `max` octets (sinon CorpsTropGrand). */
export function lireCorps(req, max) {
  return new Promise((ok, echec) => {
    const annonce = Number(req.headers['content-length'] || 0);
    if (annonce > max) {
      echec(new CorpsTropGrand());
      req.resume();
      return;
    }
    const morceaux = [];
    let taille = 0;
    req.on('data', (m) => {
      taille += m.length;
      if (taille > max) {
        echec(new CorpsTropGrand());
        req.destroy();
        return;
      }
      morceaux.push(m);
    });
    req.on('end', () => ok(Buffer.concat(morceaux)));
    req.on('error', echec);
  });
}

/**
 * Adresse du client. Le service n'ecoute que sur 127.0.0.1 derriere Caddy :
 * l'adresse reelle est la DERNIERE de X-Forwarded-For (celle ajoutee par
 * Caddy) ; un en-tete fourni par le client ne peut pas la remplacer.
 */
export function ipCliente(req) {
  const directe = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  const locale = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(directe);
  const transmise = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (locale && transmise.length ? transmise[transmise.length - 1] : directe).replace(/^::ffff:/, '');
}
