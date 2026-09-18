// POST /api/billing/checkout
//
// Corps attendu : { "plan": "essentiel" }, et facultativement la periode :
//                 "period": "MONTHLY" | "ANNUAL", ou "billing_cycle": "monthly" | "annual"
// En-tete       : Authorization: Bearer <jeton de session Supabase>
//
// Le navigateur n'envoie NI montant, NI entreprise, NI devise : la base les
// deduit de la session et des tarifs. La reponse contient seulement la
// reference Timora et l'adresse de paiement renvoyee par JoonaPay.

import { lireConfig } from '../../server/facturation/config.mjs';
import { journaliser } from '../../server/facturation/journal.mjs';
import { repondre, jetonDe, origineAutorisee, adresseDeRetour } from '../../server/facturation/http.mjs';
import { demarrerPaiement } from '../../server/facturation/facturation.mjs';

const TAILLE_MAX = 1024;

export async function POST(request) {
  const conf = lireConfig();
  if (!conf.ok) {
    journaliser('BILLING_CONFIGURATION_ERROR', { manquantes: conf.manquantes, erreurs: conf.erreurs });
    return repondre(503, { code: 'PAIEMENT_NON_CONFIGURE', message: 'Le paiement en ligne n\'est pas encore disponible.' });
  }
  if (!origineAutorisee(request, conf)) {
    return repondre(403, { code: 'ORIGINE_REFUSEE', message: 'Requête refusée.' });
  }

  const jeton = jetonDe(request);
  if (!jeton) return repondre(401, { code: 'SESSION_REQUISE', message: 'Connectez-vous pour activer Timora.' });

  const texte = await request.text();
  if (texte.length > TAILLE_MAX) return repondre(413, { code: 'REQUETE_TROP_GRANDE', message: 'Requête invalide.' });
  let corps;
  try {
    corps = JSON.parse(texte || '{}');
  } catch {
    return repondre(400, { code: 'JSON_INVALIDE', message: 'Requête invalide.' });
  }
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) {
    return repondre(400, { code: 'JSON_INVALIDE', message: 'Requête invalide.' });
  }

  // Periode : « period » (MONTHLY / ANNUAL) ou « billing_cycle » (monthly / annual).
  const cycle = typeof corps.billing_cycle === 'string' ? corps.billing_cycle.trim().toLowerCase() : null;
  const periode = typeof corps.period === 'string' ? corps.period
    : cycle === 'monthly' ? 'MONTHLY'
      : cycle === 'annual' || cycle === 'yearly' ? 'ANNUAL'
        : cycle ? 'INVALIDE' : null;

  try {
    const r = await demarrerPaiement(conf, {
      jeton,
      plan: typeof corps.plan === 'string' ? corps.plan.trim().toLowerCase() : '',
      periode,
      adresseRetour: adresseDeRetour(request, conf),
    });
    return repondre(r.status, r.corps);
  } catch (err) {
    journaliser('JOONAPAY_PAYMENT_CREATE_FAILED', { etape: 'inattendue', erreur: err && err.name });
    return repondre(500, { code: 'ERREUR_SERVEUR', message: 'Une erreur est survenue. Aucun montant n\'a été débité.' });
  }
}
