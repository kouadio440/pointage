// Cas d'usage de la facturation, executes par le SERVEUR DE PAIEMENT
// (payments.timora.tech, IP fixe) : demarrer un paiement, verifier un
// paiement, traiter un webhook JoonaPay.
//
// Regles tenues ici :
//   - le montant, le plan, l'entreprise et l'environnement sont decides par la
//     base (billing_prepare_checkout_v2), jamais par le navigateur ; le montant
//     est en plus recalcule ici depuis le catalogue ;
//   - l'identite de l'acheteur est celle d'un jeton de session verifie par
//     Supabase Auth (l'appelant la fournit : voir services/payments) ;
//   - un abonnement n'est active que sur un etat LU CHEZ JOONAPAY par le
//     serveur (GET /payments/{uuid}) — ni sur un webhook seul, ni sur un retour
//     de navigateur ;
//   - l'activation est atomique et idempotente (billing_apply_provider_status),
//     le recu est emis dans la meme transaction ;
//   - test de production (montant reduit) : double controle, base ET serveur.

import { createHash } from 'node:crypto';
import { journaliser, traceDev } from './journal.mjs';
import { montantCatalogue } from './catalogue.mjs';
import { rpc, consignerEnBase } from './supabase.mjs';
import { creerPaiement, lirePaiement, paysDePaiement, signatureValide } from './joonapay.mjs';

export const REFERENCE = /^TIMORA-SUB-\d{8}-[0-9A-F]{8}$/;
const PLAN = /^[a-z]{2,20}$/;
const DELAI_ENTRE_VERIFICATIONS_MS = 5000;
const EVENEMENTS_PAIEMENT = new Set(['payment.completed', 'payment.failed']);

const MESSAGE_INDISPONIBLE = 'Le paiement en ligne est momentanément indisponible. Aucun montant n\'a été débité. Réessayez plus tard.';

// Erreurs metier de la base : le message (en francais, destine a l'utilisateur)
// est repris tel quel ; les autres restent generiques.
const ERREURS_PREPARATION = {
  DROITS_INSUFFISANTS: 403,
  ENTREPRISE_SUSPENDUE: 403,
  PAIEMENT_PAS_ENCORE_OUVERT: 403,
  ENTREPRISE_A_PRECISER: 409,
  ONBOARDING_INCOMPLET: 409,
  DEJA_ACTIF: 409,
  PLAN_DOWNGRADE_BLOCKED: 409,
  FORMULE_INDISPONIBLE: 422,
  PERIODE_INVALIDE: 422,
  TROP_DE_TENTATIVES: 429,
};

// Resultats de billing_apply_provider_status qui meritent une alerte.
const ALERTES_ACTIVATION = new Set(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DUPLICATE_PAYMENT']);

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

const empreinte = (texte) => createHash('sha256').update(texte).digest('hex');

function sessionInvalide(r) {
  return r.erreur && (r.erreur.hint === 'SESSION_INVALIDE' || (r.erreur.code === '42501' && !r.erreur.hint));
}

/**
 * Le serveur autorise-t-il le test de production pour ce compte ? La base
 * applique ensuite TOUTES ses propres conditions (compte autorise, entreprise
 * en attente, Essentiel mensuel, usage unique).
 */
export function testProductionAutorise(config, utilisateur) {
  const t = config.testProduction;
  if (!t || !t.active || config.environnement !== 'production') return false;
  if (!utilisateur || !utilisateur.email) return false;
  if (t.empreinteEmail) {
    return empreinte(String(utilisateur.email).trim().toLowerCase()) === t.empreinteEmail;
  }
  return true;
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
  const indisponible = ['DELAI_DEPASSE', 'INJOIGNABLE', 'ERREUR_FOURNISSEUR', 'LIMITE_DE_DEBIT', 'IP_NON_AUTORISEE', 'AUTHENTIFICATION'].includes(echec.code);
  journaliser(indisponible ? 'JOONAPAY_UNAVAILABLE' : 'JOONAPAY_PAYMENT_CREATE_FAILED', {
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

/**
 * utilisateur : { id, email } — issu d'un jeton verifie par Supabase Auth.
 * periode : 'MONTHLY' | 'ANNUAL'. Aucun montant n'est accepte en entree.
 */
export async function demarrerPaiement(config, { utilisateur, plan, periode }) {
  if (!PLAN.test(String(plan || ''))) {
    return { status: 422, corps: { code: 'FORMULE_INDISPONIBLE', message: 'Formule inconnue.' } };
  }
  const per = periode ? String(periode).toUpperCase() : 'MONTHLY';
  if (!['MONTHLY', 'ANNUAL'].includes(per)) {
    return { status: 422, corps: { code: 'PERIODE_INVALIDE', message: 'Période invalide.' } };
  }
  journaliser('PAYMENT_CHECKOUT_REQUESTED', { plan, period: per, user_id: utilisateur.id, environment: config.environnement });

  // Montant attendu : recalcule ici a partir du CODE de la formule, dans le
  // catalogue partage avec la page d'accueil. Aucun montant envoye par un
  // navigateur n'est lu.
  const attendu = montantCatalogue(plan, per);
  if (attendu === null) {
    return { status: 422, corps: { code: 'FORMULE_INDISPONIBLE', message: 'Cette formule ne se souscrit pas en ligne.' } };
  }

  const testDemande = testProductionAutorise(config, utilisateur);
  const prep = await rpc(config, 'billing_prepare_checkout_v2', {
    p_user: utilisateur.id,
    p_plan: plan,
    p_period: per,
    p_environment: config.environnement,
    p_allow_smoke: testDemande,
    p_company: null,
  });

  if (!prep.ok) {
    if (sessionInvalide(prep)) {
      return { status: 401, corps: { code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Reconnectez-vous.' } };
    }
    const hint = prep.erreur && prep.erreur.hint;
    if (hint && ERREURS_PREPARATION[hint]) {
      return { status: ERREURS_PREPARATION[hint], corps: { code: hint, message: prep.erreur.message } };
    }
    // Mode de la plateforme et du serveur differents, base injoignable : un
    // probleme de configuration, jamais la faute du client.
    journaliser(prep.status === 0 ? 'SUPABASE_WRITE_FAILED' : 'JOONAPAY_PAYMENT_CREATE_FAILED', {
      etape: 'preparation', code: hint || prep.erreur.code, http_status: prep.status,
    });
    return { status: 503, corps: { code: 'PAIEMENT_INDISPONIBLE', message: MESSAGE_INDISPONIBLE } };
  }

  const p = prep.data || {};
  traceDev('billing status', { action: p.action, reference: p.reference || null });
  const resume = (reutilise) => ({
    reference: p.reference,
    checkout_url: p.checkout_url,
    reutilise,
    is_smoke_test: Boolean(p.is_smoke_test),
    montant: p.amount,
    montant_normal: p.normal_amount,
  });

  if (p.action === 'REDIRECT') {
    journaliser('JOONAPAY_CHECKOUT_REUSED', { reference: p.reference, environment: config.environnement, smoke_test: Boolean(p.is_smoke_test) });
    return { status: 200, corps: resume(true) };
  }
  if (p.action === 'IN_PROGRESS') {
    return { status: 409, corps: { code: 'PAIEMENT_EN_PREPARATION', reference: p.reference, message: 'Votre paiement est en cours de préparation.' } };
  }

  // Double controle du montant. Paiement normal : montant = tarif catalogue.
  // Test de production : montant = montant de test configure SUR CE SERVEUR,
  // tarif normal = catalogue, et le serveur l'avait demande pour ce compte.
  const t = config.testProduction || {};
  const conforme = p.currency === 'XOF' && p.normal_amount === attendu && (p.is_smoke_test
    ? testDemande && per === 'MONTHLY' && plan === 'essentiel' && p.amount === t.montant && p.amount < attendu
    : p.amount === attendu);
  if (!conforme) {
    journaliser('AMOUNT_MISMATCH', {
      reference: p.reference, etape: 'tarif', attendu, base: p.amount, normal: p.normal_amount, smoke_test: Boolean(p.is_smoke_test),
    });
    await rpc(config, 'billing_mark_create_failed', {
      p_reference: p.reference, p_environment: config.environnement, p_code: p.is_smoke_test ? 'TEST_INCOHERENT' : 'TARIF_INCOHERENT',
    });
    return { status: 503, corps: { code: 'TARIF_EN_MISE_A_JOUR', message: 'Nos tarifs sont en cours de mise à jour. Aucun montant n\'a été débité. Réessayez dans quelques minutes.' } };
  }
  journaliser('PAYMENT_AMOUNT_RESOLVED', {
    reference: p.reference, plan: p.plan, period: p.period, amount: p.amount, normal_amount: p.normal_amount,
    smoke_test: Boolean(p.is_smoke_test),
  });

  const pays = await paysDePaiement(config, p.company_country);
  if (!pays.ok) return echecCreation(config, p.reference, pays);

  const retour = `${config.appUrl}/?paiement=retour&ref=${encodeURIComponent(p.reference)}`;
  // JoonaPay n'accepte que des adresses de retour HTTPS. En developpement
  // local (http://localhost), elles ne sont pas transmises : JoonaPay garde
  // alors le client sur sa page, et le paiement est verifie a son retour.
  const retourHttps = urlHttps(retour);
  const client = p.customer || {};
  const periodeLisible = p.period === 'ANNUAL' ? '12 mois' : '1 mois';
  const description = p.is_smoke_test
    ? `Timora — test de production contrôlé — formule ${p.plan_name} (tarif normal ${p.normal_amount} XOF / mois) — ${p.company_name}`
    : `Abonnement Timora ${p.plan_name} — ${periodeLisible} — ${p.company_name}`;
  const corps = {
    amount: p.amount,
    currency: 'XOF',
    country_uuid: pays.uuid,
    due_date: new Date().toISOString().slice(0, 10),
    customer_name: String(client.name || 'Client Timora').slice(0, 100),
    customer_email: client.email || undefined,
    customer_phone: telephoneE164(client.phone),
    description: description.slice(0, 500),
    merchant_transaction_id: p.reference,
    webhook_url: config.joonapay.webhookUrl,
    success_url: retourHttps ? retour : undefined,
    cancel_url: retourHttps ? `${retour}&issue=annule` : undefined,
    failure_url: retourHttps ? `${retour}&issue=echec` : undefined,
    allow_partial_payment: false,
  };

  traceDev('JoonaPay request started', { reference: p.reference, amount: corps.amount, currency: corps.currency, retour_https: retourHttps });
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
    journaliser(rattache.ok ? 'JOONAPAY_PAYMENT_CREATE_FAILED' : 'SUPABASE_WRITE_FAILED', {
      reference: p.reference, etape: 'rattachement', code: rattache.ok ? rattache.data.status : rattache.erreur.code,
    });
    return { status: 409, corps: { code: 'PAIEMENT_REMPLACE', message: 'Ce paiement a été remplacé. Relancez l\'activation.' } };
  }

  journaliser('JOONAPAY_PAYMENT_CREATED', {
    reference: p.reference, environment: config.environnement, provider_reference: d.reference || null,
    amount: p.amount, smoke_test: Boolean(p.is_smoke_test), request_id: cree.requestId,
  });
  return { status: 200, corps: { ...resume(false), checkout_url: d.payment_link } };
}

// -----------------------------------------------------------------------------
// LIRE L'ETAT CHEZ JOONAPAY ET L'APPLIQUER
// -----------------------------------------------------------------------------

/** Moyen de la tentative reussie (ex. WAVE_CI), sans donnee personnelle. */
function moyenDePaiement(d) {
  const tentatives = Array.isArray(d.payments) ? d.payments : [];
  const reussie = tentatives.find((t) => t && String(t.status || '').toUpperCase() === 'SUCCESS');
  const moyen = reussie && typeof reussie.payment_method === 'string' ? reussie.payment_method.toUpperCase() : null;
  return moyen && /^[A-Z0-9_]{2,40}$/.test(moyen) ? moyen : null;
}

export async function synchroniser(config, uuid, source) {
  const lu = await lirePaiement(config, uuid);
  if (!lu.ok) {
    journaliser(['INJOIGNABLE', 'DELAI_DEPASSE', 'ERREUR_FOURNISSEUR', 'IP_NON_AUTORISEE', 'AUTHENTIFICATION'].includes(lu.code)
      ? 'JOONAPAY_UNAVAILABLE' : 'JOONAPAY_PAYMENT_STATUS_CHECK_FAILED', {
      source, environment: config.environnement, code: lu.code, http_status: lu.status, request_id: lu.requestId,
    });
    return { ok: false, code: lu.code };
  }

  const d = lu.data || {};
  if (String(d.uuid || '') !== uuid) {
    journaliser('JOONAPAY_PAYMENT_STATUS_CHECK_FAILED', { source, code: 'REPONSE_INCOHERENTE' });
    return { ok: false, code: 'REPONSE_INCOHERENTE' };
  }
  journaliser('JOONAPAY_PAYMENT_VERIFIED', {
    source, reference: d.merchant_transaction_id || null, provider_status: d.status || null, payment_status: d.payment_status || null,
  });

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
    p_payment_method: moyenDePaiement(d),
  });
  if (!applique.ok) {
    journaliser(applique.status === 0 ? 'SUPABASE_WRITE_FAILED' : 'ACTIVATION_FAILED', {
      source, code: applique.erreur.code, http_status: applique.status,
    });
    return { ok: false, code: 'BASE_INDISPONIBLE' };
  }

  const r = applique.data || {};
  const trace = { source, reference: r.reference || d.merchant_transaction_id || null, environment: config.environnement };
  if (r.ok === false) {
    const alerte = ALERTES_ACTIVATION.has(r.code) ? r.code : r.code === 'PAIEMENT_INCONNU' ? 'UNKNOWN_PAYMENT' : 'ACTIVATION_FAILED';
    journaliser(alerte, { ...trace, code: r.code });
  } else if (r.status === 'COMPLETED' && r.deja_traite === false) {
    journaliser('SUBSCRIPTION_ACTIVATED', {
      ...trace, plan: r.subscription && r.subscription.plan, fin: r.subscription && r.subscription.fin,
      smoke_test: Boolean(r.is_smoke_test),
    });
    if (r.receipt_number) journaliser('PAYMENT_RECEIPT_CREATED', { ...trace, receipt: r.receipt_number });
  } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(r.status)) {
    journaliser('PAYMENT_FAILED', { ...trace, status: r.status, provider_status: d.status });
  }

  // Recu emis (activation, ou second paiement de test encaisse) : document
  // PDF et e-mail sont produits par le serveur de paiement, hors transaction.
  if (r.receipt_id && typeof config.surRecuEmis === 'function') {
    try {
      config.surRecuEmis(r.receipt_id);
    } catch {
      /* Le traitement periodique des recus prendra le relais. */
    }
  }
  return { ok: r.ok !== false, resultat: r };
}

// -----------------------------------------------------------------------------
// VERIFIER UN PAIEMENT (page de retour)
// -----------------------------------------------------------------------------

async function lireEtat(config, utilisateur, reference) {
  return rpc(config, 'billing_payment_status_v2', { p_user: utilisateur.id, p_reference: reference });
}

export async function verifierPaiement(config, { utilisateur, reference }) {
  if (!REFERENCE.test(String(reference || ''))) {
    return { status: 400, corps: { code: 'REFERENCE_INVALIDE', message: 'Référence de paiement invalide.' } };
  }

  let etat = await lireEtat(config, utilisateur, reference);
  if (!etat.ok) {
    if (sessionInvalide(etat)) return { status: 401, corps: { code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Reconnectez-vous.' } };
    // Reference inconnue et paiement d'une autre entreprise : meme reponse.
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
    etat = await lireEtat(config, utilisateur, reference);
    if (etat.ok) p = etat.data;
  }

  const abo = p.subscription || {};
  const recu = p.receipt || null;
  return {
    status: 200,
    corps: {
      reference: p.reference,
      status: p.status,
      plan: p.plan,
      period: p.period,
      amount: p.amount,
      normal_amount: p.normal_amount,
      is_smoke_test: Boolean(p.is_smoke_test),
      currency: p.currency,
      environment: p.environment,
      company_name: p.company_name,
      failure_code: p.failure_code,
      checkout_url: p.checkout_url || null,
      verifie_le: p.last_provider_check_at,
      receipt: recu ? { number: recu.number, ready: Boolean(recu.ready) } : null,
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
    // Rien n'est modifie, rien n'est ecrit en base : un robot pourrait sinon
    // remplir le journal en envoyant des requetes non signees.
    journaliser('WEBHOOK_SIGNATURE_INVALID', {
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

  const type = evenement && typeof evenement.event === 'string' ? evenement.event.slice(0, 60) : null;
  const donnees = evenement && typeof evenement.data === 'object' && evenement.data ? evenement.data : {};
  const reference = typeof donnees.merchant_transaction_id === 'string' ? donnees.merchant_transaction_id.slice(0, 64) : null;
  const uuid = typeof donnees.uuid === 'string' && donnees.uuid.length <= 64 ? donnees.uuid : null;

  // Anti-rejeu : un evenement signe deja traite n'est pas retraite.
  const cle = empreinte(corpsBrut);
  const enregistre = await rpc(config, 'billing_webhook_register', {
    p_sha256: cle, p_event: type, p_provider_payment_id: uuid, p_reference: reference,
  });
  if (!enregistre.ok) {
    journaliser('SUPABASE_WRITE_FAILED', { etape: 'webhook_anti_rejeu', code: enregistre.erreur.code });
    return { status: 503, corps: { received: false } };
  }
  if (enregistre.data && enregistre.data.deja_traite) {
    journaliser('JOONAPAY_WEBHOOK_DUPLICATE', { event: type, reference, tentatives: enregistre.data.tentatives });
    return { status: 200, corps: { received: true, duplicate: true } };
  }
  const clore = (resultat) => rpc(config, 'billing_webhook_mark_processed', { p_sha256: cle, p_result: resultat });

  journaliser('JOONAPAY_WEBHOOK_VERIFIED', { environment: config.environnement, event: type, reference });
  await consignerEnBase(config, 'WEBHOOK_VERIFIED', { reference, details: { event: type } });

  if (!EVENEMENTS_PAIEMENT.has(type)) {
    // Evenement documente mais sans objet pour Timora (payout.*), ou inconnu.
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { event: type });
    await clore('IGNORE');
    return { status: 200, corps: { received: true, ignored: true } };
  }
  if (!uuid) {
    journaliser('JOONAPAY_WEBHOOK_UNKNOWN_EVENT', { event: type, raison: 'UUID_ABSENT' });
    await clore('IGNORE');
    return { status: 200, corps: { received: true, ignored: true } };
  }

  // Le contenu du webhook n'est pas cru : l'etat est relu chez JoonaPay.
  const s = await synchroniser(config, uuid, `webhook:${type}`);
  if (s.ok) {
    await clore(s.resultat && s.resultat.status ? s.resultat.status : 'OK');
    return { status: 200, corps: { received: true } };
  }
  // Paiement inconnu de Timora, ou que JoonaPay lui-meme ne connait pas.
  if (s.code === 'INTROUVABLE' || (s.resultat && s.resultat.code === 'PAIEMENT_INCONNU')) {
    await clore('PAIEMENT_INCONNU');
    return { status: 200, corps: { received: true, ignored: true } };
  }
  if (s.resultat && s.resultat.ok === false) {
    // Incoherence constatee (montant, devise, environnement, doublon...) :
    // consignee, rien n'est active ; renvoyer une erreur ne changerait rien.
    await clore(s.resultat.code || 'INCOHERENCE');
    return { status: 200, corps: { received: true } };
  }
  // JoonaPay injoignable ou base indisponible : erreur, pour que la
  // notification soit renvoyee (le traitement pourra reprendre).
  return { status: 503, corps: { received: false } };
}
