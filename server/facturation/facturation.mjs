// Cas d'usage de la facturation : demarrer un paiement, verifier un paiement,
// traiter un webhook JoonaPay.
//
// Regles tenues ici :
//   - le montant, le plan, l'entreprise et l'environnement sont decides par la
//     base (billing_prepare_checkout), jamais par le navigateur ;
//   - un abonnement n'est active que sur un etat LU CHEZ JOONAPAY par le
//     serveur (GET /payments/{uuid}) — ni sur un webhook seul, ni sur un retour
//     de navigateur ;
//   - l'activation est atomique et idempotente (billing_apply_provider_status).

import { journaliser } from './journal.mjs';
import { rpc, consignerEnBase } from './supabase.mjs';
import { creerPaiement, lirePaiement, paysDePaiement, signatureValide } from './joonapay.mjs';

const REFERENCE = /^TIMORA-SUB-\d{8}-[0-9A-F]{8}$/;
const PLAN = /^[a-z]{2,20}$/;
const DELAI_ENTRE_VERIFICATIONS_MS = 5000;
const EVENEMENTS_PAIEMENT = new Set(['payment.completed', 'payment.failed']);

const MESSAGE_INDISPONIBLE = 'Le paiement en ligne est momentanément indisponible. Aucun montant n\'a été débité. Réessayez plus tard.';

// Erreurs metier de la base : le message (en francais, destine a l'utilisateur)
// est repris tel quel ; les autres restent generiques.
const ERREURS_PREPARATION = {
  DROITS_INSUFFISANTS: 403,
  ENTREPRISE_SUSPENDUE: 403,
  // Sandbox reservee aux testeurs declares (billing_settings.testeurs_sandbox).
  PAIEMENT_PAS_ENCORE_OUVERT: 403,
  ENTREPRISE_A_PRECISER: 409,
  ONBOARDING_INCOMPLET: 409,
  DEJA_ACTIF: 409,
  FORMULE_INDISPONIBLE: 422,
  PERIODE_INVALIDE: 422,
  TROP_DE_TENTATIVES: 429,
};

function erreurSession(r) {
  return r.status === 401 || (r.erreur && r.erreur.code === '42501' && !r.erreur.hint)
    || (r.erreur && /^PGRST30/.test(r.erreur.code || ''));
}

function nombre(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function telephoneE164(tel) {
  const t = String(tel || '').replace(/[\s.-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : undefined;
}

function urlHttps(u) {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// DEMARRER UN PAIEMENT
// -----------------------------------------------------------------------------

async function echecCreation(config, reference, echec) {
  await rpc(config, 'billing_mark_create_failed', {
    p_reference: reference,
    p_environment: config.environnement,
    p_code: echec.code,
  });
  journaliser('JOONAPAY_PAYMENT_CREATE_FAILED', {
    reference,
    environment: config.environnement,
    code: echec.code,
    http_status: echec.status ?? null,
    provider_code: echec.codeFournisseur ?? null,
    request_id: echec.requestId ?? null,
    champs: echec.champs ?? [],
  });

  if (echec.code === 'LIMITE_DE_DEBIT') {
    return { status: 503, corps: { code: 'PAIEMENT_SATURE', message: 'Le service de paiement est très sollicité. Aucun montant n\'a été débité. Réessayez dans une minute.' } };
  }
  if (['DELAI_DEPASSE', 'INJOIGNABLE', 'ERREUR_FOURNISSEUR'].includes(echec.code)) {
    return { status: 503, corps: { code: 'PAIEMENT_INJOIGNABLE', message: 'Le service de paiement ne répond pas. Aucun montant n\'a été débité. Réessayez dans quelques minutes.' } };
  }
  return { status: 502, corps: { code: 'PAIEMENT_INDISPONIBLE', message: MESSAGE_INDISPONIBLE } };
}

export async function demarrerPaiement(config, { jeton, plan, periode, adresseRetour }) {
  if (!PLAN.test(String(plan || ''))) {
    return { status: 422, corps: { code: 'FORMULE_INDISPONIBLE', message: 'Formule inconnue.' } };
  }
  const per = periode ? String(periode).toUpperCase() : 'MONTHLY';

  const prep = await rpc(config, 'billing_prepare_checkout', {
    p_plan: plan,
    p_period: per,
    p_environment: config.environnement,
    p_company: null,
  }, { jeton });

  if (!prep.ok) {
    if (erreurSession(prep)) {
      return { status: 401, corps: { code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Reconnectez-vous.' } };
    }
    const hint = prep.erreur && prep.erreur.hint;
    if (hint && ERREURS_PREPARATION[hint]) {
      return { status: ERREURS_PREPARATION[hint], corps: { code: hint, message: prep.erreur.message } };
    }
    // Mode de la plateforme et du serveur de paiement differents, base
    // injoignable : un probleme de configuration, jamais la faute du client.
    journaliser('JOONAPAY_PAYMENT_CREATE_FAILED', { etape: 'preparation', code: hint || prep.erreur.code, http_status: prep.status });
    return { status: 503, corps: { code: 'PAIEMENT_INDISPONIBLE', message: MESSAGE_INDISPONIBLE } };
  }

  const p = prep.data || {};
  if (p.action === 'REDIRECT') {
    journaliser('JOONAPAY_CHECKOUT_REUSED', { reference: p.reference, environment: config.environnement });
    return { status: 200, corps: { reference: p.reference, checkout_url: p.checkout_url, reutilise: true } };
  }
  if (p.action === 'IN_PROGRESS') {
    return { status: 409, corps: { code: 'PAIEMENT_EN_PREPARATION', reference: p.reference, message: 'Votre paiement est en cours de préparation.' } };
  }

  journaliser('JOONAPAY_PAYMENT_CREATE_STARTED', {
    reference: p.reference, environment: config.environnement, plan: p.plan, period: p.period, amount: p.amount,
  });

  const pays = await paysDePaiement(config, p.company_country);
  if (!pays.ok) return echecCreation(config, p.reference, pays);

  const retour = `${adresseRetour}/?paiement=retour&ref=${encodeURIComponent(p.reference)}`;
  const client = p.customer || {};
  const corps = {
    amount: p.amount,
    currency: 'XOF',
    country_uuid: pays.uuid,
    due_date: new Date().toISOString().slice(0, 10),
    customer_name: String(client.name || 'Client Timora').slice(0, 100),
    customer_email: client.email || undefined,
    customer_phone: telephoneE164(client.phone),
    description: `Abonnement Timora ${p.plan_name} — ${p.period === 'ANNUAL' ? '12 mois' : '1 mois'} — ${p.company_name}`.slice(0, 500),
    merchant_transaction_id: p.reference,
    webhook_url: config.joonapay.webhookUrl,
    success_url: retour,
    cancel_url: `${retour}&issue=annule`,
    failure_url: `${retour}&issue=echec`,
    allow_partial_payment: false,
  };

  const cree = await creerPaiement(config, corps);
  if (!cree.ok) return echecCreation(config, p.reference, cree);

  const d = cree.data || {};
  const montantRecu = nombre(d.amount);
  const incoherent = typeof d.uuid !== 'string' || !d.uuid || d.uuid.length > 64
    || !urlHttps(d.payment_link)
    || (montantRecu !== null && montantRecu !== p.amount)
    || (d.currency && String(d.currency).toUpperCase() !== 'XOF');
  if (incoherent) {
    return echecCreation(config, p.reference, { code: 'REPONSE_INCOHERENTE', status: cree.status, requestId: cree.requestId });
  }

  const rattache = await rpc(config, 'billing_attach_checkout', {
    p_reference: p.reference,
    p_environment: config.environnement,
    p_provider_payment_id: d.uuid,
    p_provider_reference: d.reference || null,
    p_checkout_url: d.payment_link,
    p_provider_status: d.status || null,
  });
  if (!rattache.ok || !rattache.data || rattache.data.ok !== true) {
    journaliser('JOONAPAY_PAYMENT_CREATE_FAILED', { reference: p.reference, etape: 'rattachement', code: rattache.ok ? rattache.data.status : rattache.erreur.code });
    return { status: 409, corps: { code: 'PAIEMENT_REMPLACE', message: 'Ce paiement a été remplacé. Relancez l\'activation.' } };
  }

  journaliser('JOONAPAY_PAYMENT_CREATED', {
    reference: p.reference, environment: config.environnement, provider_reference: d.reference || null, request_id: cree.requestId,
  });
  return { status: 200, corps: { reference: p.reference, checkout_url: d.payment_link, reutilise: false } };
}

// -----------------------------------------------------------------------------
// LIRE L'ETAT CHEZ JOONAPAY ET L'APPLIQUER
// -----------------------------------------------------------------------------

export async function synchroniser(config, uuid, source) {
  const lu = await lirePaiement(config, uuid);
  if (!lu.ok) {
    journaliser('JOONAPAY_PAYMENT_STATUS_CHECK_FAILED', {
      source, environment: config.environnement, code: lu.code, http_status: lu.status, request_id: lu.requestId,
    });
    return { ok: false, code: lu.code };
  }

  const d = lu.data || {};
  if (String(d.uuid || '') !== uuid) {
    journaliser('JOONAPAY_PAYMENT_STATUS_CHECK_FAILED', { source, code: 'REPONSE_INCOHERENTE' });
    return { ok: false, code: 'REPONSE_INCOHERENTE' };
  }

  const applique = await rpc(config, 'billing_apply_provider_status', {
    p_environment: config.environnement,
    p_provider_payment_id: uuid,
    p_merchant_reference: d.merchant_transaction_id || null,
    p_status: d.status || null,
    p_payment_status: d.payment_status || null,
    p_amount: nombre(d.amount),
    p_paid_amount: nombre(d.paid_amount),
    p_currency: d.currency || null,
    p_source: source,
  });
  if (!applique.ok) {
    journaliser('SUBSCRIPTION_ACTIVATION_FAILED', { source, code: applique.erreur.code, http_status: applique.status });
    return { ok: false, code: 'BASE_INDISPONIBLE' };
  }

  const r = applique.data || {};
  const trace = { source, reference: r.reference || d.merchant_transaction_id || null, environment: config.environnement };
  if (r.ok === false) {
    journaliser('SUBSCRIPTION_ACTIVATION_FAILED', { ...trace, code: r.code });
  } else if (r.status === 'COMPLETED' && r.deja_traite === false) {
    journaliser('JOONAPAY_PAYMENT_CONFIRMED', { ...trace, provider_status: d.status, payment_status: d.payment_status });
    journaliser('SUBSCRIPTION_ACTIVATED', { ...trace, plan: r.subscription && r.subscription.plan, fin: r.subscription && r.subscription.fin });
  } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(r.status)) {
    journaliser('JOONAPAY_PAYMENT_FAILED', { ...trace, status: r.status, provider_status: d.status });
  }
  return { ok: r.ok !== false, resultat: r };
}

// -----------------------------------------------------------------------------
// VERIFIER UN PAIEMENT (page de retour)
// -----------------------------------------------------------------------------

async function lireEtat(config, jeton, reference) {
  return rpc(config, 'billing_payment_status', { p_reference: reference }, { jeton });
}

export async function verifierPaiement(config, { jeton, reference }) {
  if (!REFERENCE.test(String(reference || ''))) {
    return { status: 400, corps: { code: 'REFERENCE_INVALIDE', message: 'Référence de paiement invalide.' } };
  }

  let etat = await lireEtat(config, jeton, reference);
  if (!etat.ok) {
    if (erreurSession(etat)) return { status: 401, corps: { code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Reconnectez-vous.' } };
    if (etat.erreur.hint === 'PAIEMENT_INCONNU') return { status: 404, corps: { code: 'PAIEMENT_INCONNU', message: 'Paiement introuvable.' } };
    return { status: 503, corps: { code: 'VERIFICATION_IMPOSSIBLE', message: 'La vérification est momentanément impossible.' } };
  }

  let p = etat.data;
  const derniere = p.last_provider_check_at ? Date.parse(p.last_provider_check_at) : 0;
  if (['PENDING', 'PROCESSING'].includes(p.status) && p.provider_payment_id
      && Date.now() - derniere > DELAI_ENTRE_VERIFICATIONS_MS) {
    // Le retour du navigateur ne prouve rien : il declenche seulement une
    // lecture de l'etat chez JoonaPay, par le serveur.
    await synchroniser(config, p.provider_payment_id, 'retour_navigateur');
    etat = await lireEtat(config, jeton, reference);
    if (etat.ok) p = etat.data;
  }

  const abo = p.subscription || {};
  return {
    status: 200,
    corps: {
      reference: p.reference,
      status: p.status,
      plan: p.plan,
      period: p.period,
      amount: p.amount,
      currency: p.currency,
      environment: p.environment,
      company_name: p.company_name,
      failure_code: p.failure_code,
      checkout_url: p.checkout_url || null,
      verifie_le: p.last_provider_check_at,
      subscription: { etat: abo.etat || null, fin: abo.fin || null, plan: abo.plan || null },
    },
  };
}

// -----------------------------------------------------------------------------
// WEBHOOK
// -----------------------------------------------------------------------------

export async function traiterWebhook(config, { corpsBrut, signature }) {
  journaliser('JOONAPAY_WEBHOOK_RECEIVED', { environment: config.environnement, taille: corpsBrut.length });

  if (!signatureValide(corpsBrut, signature, config.joonapay.secretWebhook)) {
    // Rien n'est modifie. Pas de copie en base : un robot pourrait sinon
    // remplir le journal en envoyant des requetes non signees.
    journaliser('JOONAPAY_WEBHOOK_INVALID_SIGNATURE', {
      environment: config.environnement, signature_presente: Boolean(signature), taille: corpsBrut.length,
    });
    return { status: 401, corps: { received: false } };
  }

  let evenement;
  try {
    evenement = JSON.parse(corpsBrut.toString('utf8'));
  } catch {
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { raison: 'JSON_INVALIDE' });
    return { status: 400, corps: { received: false } };
  }

  const type = typeof evenement.event === 'string' ? evenement.event.slice(0, 60) : null;
  const donnees = evenement && typeof evenement.data === 'object' && evenement.data ? evenement.data : {};
  const reference = typeof donnees.merchant_transaction_id === 'string' ? donnees.merchant_transaction_id.slice(0, 64) : null;

  journaliser('JOONAPAY_WEBHOOK_VERIFIED', { environment: config.environnement, event: type, reference });
  await consignerEnBase(config, 'JOONAPAY_WEBHOOK_VERIFIED', { reference, details: { event: type } });

  if (!EVENEMENTS_PAIEMENT.has(type)) {
    // Evenement documente mais sans objet pour Timora (payout.*), ou inconnu :
    // accuse de reception, aucune action.
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { event: type });
    await consignerEnBase(config, 'JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { reference, details: { event: type } });
    return { status: 200, corps: { received: true, ignored: true } };
  }

  const uuid = typeof donnees.uuid === 'string' && donnees.uuid.length <= 64 ? donnees.uuid : null;
  if (!uuid) {
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { event: type, raison: 'UUID_ABSENT' });
    return { status: 200, corps: { received: true, ignored: true } };
  }

  // Le contenu du webhook n'est pas cru : l'etat est relu chez JoonaPay.
  const s = await synchroniser(config, uuid, `webhook:${type}`);
  if (s.ok) return { status: 200, corps: { received: true } };
  // Paiement inconnu de Timora, ou que JoonaPay lui-meme ne connait pas (autre
  // cle, autre environnement) : rien a faire, et rien a renvoyer.
  if (s.code === 'INTROUVABLE' || (s.resultat && s.resultat.code === 'PAIEMENT_INCONNU')) {
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { event: type, raison: 'PAIEMENT_INCONNU' });
    return { status: 200, corps: { received: true, ignored: true } };
  }
  if (s.resultat && s.resultat.ok === false) {
    // Incoherence constatee (montant, devise, environnement...) : consignee,
    // rien n'est active ; renvoyer une erreur ne changerait rien au resultat.
    return { status: 200, corps: { received: true } };
  }
  // JoonaPay injoignable ou base indisponible : erreur, pour que la
  // notification puisse etre renvoyee. La page de retour reverifie aussi.
  return { status: 503, corps: { received: false } };
}
