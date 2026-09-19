// POST /api/billing/checkout  (www.timora.tech, Vercel)
//
// Corps attendu : { "plan": "essentiel" }, et facultativement la periode :
//                 "period": "MONTHLY" | "ANNUAL", ou "billing_cycle": "monthly" | "annual"
// En-tete       : Authorization: Bearer <jeton de session Supabase>
//
// Relais SIGNE vers le serveur de paiement (payments.timora.tech), seule
// passerelle vers JoonaPay. Le navigateur n'envoie NI montant, NI entreprise,
// NI devise : seuls la formule et la periode sont transmises ; tout autre
// champ (un « amount » par exemple) est ignore. Vercel ne detient aucune cle
// JoonaPay ni la cle de service Supabase.

import { repondre, jetonDe, origineAutorisee } from '../../server/facturation/http.mjs';
import { lireConfigPasserelle, appelerServeurPaiement } from '../../server/passerelle/client.mjs';

const TAILLE_MAX = 1024;
const PLAN = /^[a-z]{2,20}$/;
const CHAMPS_REPONSE = ['reference', 'checkout_url', 'reutilise', 'is_smoke_test', 'montant', 'montant_normal', 'code', 'message'];

function journal(evenement, details) {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), service: 'timora-vercel-billing', evenement, ...details }));
}

export async function POST(request) {
  const conf = lireConfigPasserelle();
  if (!conf.ok) {
    journal('PASSERELLE_NON_CONFIGUREE', { manquantes: conf.manquantes, erreurs: conf.erreurs });
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

  const plan = typeof corps.plan === 'string' ? corps.plan.trim().toLowerCase() : '';
  if (!PLAN.test(plan)) return repondre(422, { code: 'FORMULE_INDISPONIBLE', message: 'Formule inconnue.' });

  // Periode : « period » (MONTHLY / ANNUAL) ou « billing_cycle » (monthly / annual).
  const cycle = typeof corps.billing_cycle === 'string' ? corps.billing_cycle.trim().toLowerCase() : null;
  const periode = typeof corps.period === 'string' ? corps.period.trim().toUpperCase()
    : cycle === 'monthly' ? 'MONTHLY'
      : cycle === 'annual' || cycle === 'yearly' ? 'ANNUAL'
        : cycle ? 'INVALIDE' : 'MONTHLY';
  if (!['MONTHLY', 'ANNUAL'].includes(periode)) return repondre(422, { code: 'PERIODE_INVALIDE', message: 'Période invalide.' });

  const r = await appelerServeurPaiement(conf, {
    methode: 'POST',
    chemin: '/api/payments/checkout',
    corps: { plan, period: periode },
    jeton,
  });

  // Signature interne refusee : configuration (secret different des deux
  // cotes, horloge), jamais la faute du client.
  if (r.status === 401 && r.corps.code === 'SIGNATURE_INTERNE_REFUSEE') {
    journal('SIGNATURE_INTERNE_REFUSEE', { route: 'checkout' });
    return repondre(503, { code: 'PAIEMENT_INDISPONIBLE', message: 'Le paiement en ligne est momentanément indisponible. Aucun montant n\'a été débité.' });
  }
  if (r.injoignable) journal('SERVEUR_PAIEMENT_INJOIGNABLE', { route: 'checkout' });

  const propre = {};
  for (const champ of CHAMPS_REPONSE) if (r.corps[champ] !== undefined) propre[champ] = r.corps[champ];
  return repondre(r.status, propre);
}
