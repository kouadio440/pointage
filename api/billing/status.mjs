// GET /api/billing/status?ref=TIMORA-SUB-AAAAMMJJ-XXXXXXXX
// En-tete : Authorization: Bearer <jeton de session Supabase>
//
// Etat d'un paiement pour la page de retour. Si le paiement est encore en
// attente, le serveur relit son etat chez JoonaPay (au plus toutes les 5
// secondes) : le retour du navigateur n'active jamais rien par lui-meme.

import { lireConfig } from '../../server/facturation/config.mjs';
import { journaliser } from '../../server/facturation/journal.mjs';
import { repondre, jetonDe, origineAutorisee } from '../../server/facturation/http.mjs';
import { verifierPaiement } from '../../server/facturation/facturation.mjs';

export async function GET(request) {
  const conf = lireConfig();
  if (!conf.ok) {
    journaliser('BILLING_CONFIGURATION_ERROR', { manquantes: conf.manquantes, erreurs: conf.erreurs });
    return repondre(503, { code: 'PAIEMENT_NON_CONFIGURE', message: 'La vérification est momentanément impossible.' });
  }
  if (!origineAutorisee(request, conf)) {
    return repondre(403, { code: 'ORIGINE_REFUSEE', message: 'Requête refusée.' });
  }

  const jeton = jetonDe(request);
  if (!jeton) return repondre(401, { code: 'SESSION_REQUISE', message: 'Connectez-vous pour suivre votre paiement.' });

  try {
    const reference = new URL(request.url).searchParams.get('ref');
    const r = await verifierPaiement(conf, { jeton, reference });
    return repondre(r.status, r.corps);
  } catch (err) {
    journaliser('JOONAPAY_PAYMENT_STATUS_CHECK_FAILED', { etape: 'inattendue', erreur: err && err.name });
    return repondre(500, { code: 'ERREUR_SERVEUR', message: 'La vérification est momentanément impossible.' });
  }
}
