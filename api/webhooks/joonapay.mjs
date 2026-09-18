// POST /api/webhooks/joonapay
//
// Notification de JoonaPay. Le corps BRUT est lu avant tout traitement : la
// signature (x-webhook-signature, HMAC-SHA256 hex prefixe « sha256= ») porte
// sur ces octets exacts. Une signature absente ou fausse ne modifie rien.
// Une notification valide ne fait que declencher la relecture de l'etat du
// paiement chez JoonaPay ; c'est cet etat, et lui seul, qui peut activer un
// abonnement.

import { lireConfig } from '../../server/facturation/config.mjs';
import { journaliser } from '../../server/facturation/journal.mjs';
import { repondre } from '../../server/facturation/http.mjs';
import { traiterWebhook } from '../../server/facturation/facturation.mjs';

const TAILLE_MAX = 64 * 1024;

export async function POST(request) {
  const conf = lireConfig();
  if (!conf.ok) {
    journaliser('BILLING_CONFIGURATION_ERROR', { manquantes: conf.manquantes, erreurs: conf.erreurs });
    return repondre(503, { received: false });
  }

  const corpsBrut = Buffer.from(await request.arrayBuffer());
  if (corpsBrut.length === 0 || corpsBrut.length > TAILLE_MAX) {
    journaliser('JOONAPAY_WEBHOOK_INVALID_SIGNATURE', { raison: 'TAILLE', taille: corpsBrut.length });
    return repondre(400, { received: false });
  }

  try {
    const r = await traiterWebhook(conf, {
      corpsBrut,
      signature: request.headers.get('x-webhook-signature'),
    });
    return repondre(r.status, r.corps);
  } catch (err) {
    journaliser('SUBSCRIPTION_ACTIVATION_FAILED', { etape: 'webhook', erreur: err && err.name });
    return repondre(500, { received: false });
  }
}
