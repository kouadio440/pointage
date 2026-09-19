// GET /api/billing/status?ref=TIMORA-SUB-AAAAMMJJ-XXXXXXXX  (www.timora.tech, Vercel)
// En-tete : Authorization: Bearer <jeton de session Supabase>
//
// Etat d'un paiement pour la page de retour, via le serveur de paiement
// (relais signe). Si le paiement est encore en attente, le serveur de paiement
// relit son etat chez JoonaPay : le retour du navigateur n'active jamais rien
// par lui-meme. Un paiement d'une autre entreprise repond « introuvable ».

import { repondre, jetonDe, origineAutorisee } from '../../server/facturation/http.mjs';
import { lireConfigPasserelle, appelerServeurPaiement } from '../../server/passerelle/client.mjs';

const REFERENCE = /^TIMORA-SUB-\d{8}-[0-9A-F]{8}$/;

export async function GET(request) {
  const conf = lireConfigPasserelle();
  if (!conf.ok) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), service: 'timora-vercel-billing', evenement: 'PASSERELLE_NON_CONFIGUREE', manquantes: conf.manquantes }));
    return repondre(503, { code: 'PAIEMENT_NON_CONFIGURE', message: 'La vérification est momentanément impossible.' });
  }
  if (!origineAutorisee(request, conf)) {
    return repondre(403, { code: 'ORIGINE_REFUSEE', message: 'Requête refusée.' });
  }

  const jeton = jetonDe(request);
  if (!jeton) return repondre(401, { code: 'SESSION_REQUISE', message: 'Connectez-vous pour suivre votre paiement.' });

  const reference = new URL(request.url).searchParams.get('ref') || '';
  if (!REFERENCE.test(reference)) return repondre(400, { code: 'REFERENCE_INVALIDE', message: 'Référence de paiement invalide.' });

  const r = await appelerServeurPaiement(conf, {
    methode: 'GET',
    chemin: `/api/payments/${reference}/status`,
    jeton,
  });
  if (r.status === 401 && r.corps.code === 'SIGNATURE_INTERNE_REFUSEE') {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), service: 'timora-vercel-billing', evenement: 'SIGNATURE_INTERNE_REFUSEE', route: 'status' }));
    return repondre(503, { code: 'VERIFICATION_IMPOSSIBLE', message: 'La vérification est momentanément impossible.' });
  }
  return repondre(r.status, r.corps);
}
