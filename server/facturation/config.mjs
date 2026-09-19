// Configuration serveur de la facturation.
//
// Tout vient des variables d'environnement du SERVEUR DE PAIEMENT
// (payments.timora.tech) : aucune cle n'est ecrite dans le code, aucune
// n'arrive dans le navigateur ni sur Vercel. Ce dossier (server/) est hors de
// api/ : aucun de ses fichiers n'est une route publique.

const REQUISES = [
  'JOONAPAY_CLIENT_KEY',
  'JOONAPAY_PRIVATE_KEY',
  'JOONAPAY_WEBHOOK_SECRET',
  'JOONAPAY_BASE_URL',
  'JOONAPAY_WEBHOOK_URL',
  'JOONAPAY_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

// Hotes JoonaPay connus. Production : docs.joonapay.com et portail JoonaPay.
// Sandbox : adresse affichee par le portail JoonaPay (« Environnement :
// Sandbox », 18/09/2026), puis celle de la documentation publique. Les cles ne
// partent vers aucun autre hote distant.
const HOTE_PRODUCTION_JOONAPAY = 'apis.joonapay.com';
export const HOTES_SANDBOX_JOONAPAY = ['api-counter-demo.wejoona.com', 'api.sandbox.wejoona.com'];
// Le portail affiche « https://…/api » ; les routes marchand sont sous /api/v1/developer.
const CHEMIN_API_JOONAPAY = '/api/v1/developer';

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/;
const PRIVE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

function lireUrl(valeur) {
  try {
    return new URL(valeur);
  } catch {
    return null;
  }
}

/**
 * Lit et controle la configuration. Ne renvoie jamais la valeur d'un secret
 * dans un message : seulement le NOM de la variable en cause.
 */
export function lireConfig(env = process.env) {
  const manquantes = REQUISES.filter((nom) => !String(env[nom] || '').trim());
  const erreurs = [];

  const joonaEnv = String(env.JOONAPAY_ENV || '').trim().toLowerCase();
  if (joonaEnv && !['sandbox', 'production'].includes(joonaEnv)) {
    erreurs.push('JOONAPAY_ENV doit valoir « sandbox » ou « production ».');
  }

  const base = lireUrl(String(env.JOONAPAY_BASE_URL || '').trim());
  if (env.JOONAPAY_BASE_URL && !base) erreurs.push('JOONAPAY_BASE_URL n\'est pas une URL.');
  if (base) {
    const local = LOCAL.test(base.hostname);
    // HTTP n'est accepte que vers un simulateur local, en sandbox : jamais
    // vers un hote distant, jamais en production.
    if (base.protocol !== 'https:' && !(local && joonaEnv === 'sandbox')) {
      erreurs.push('JOONAPAY_BASE_URL doit etre en HTTPS.');
    }
    if (joonaEnv === 'sandbox' && base.hostname === HOTE_PRODUCTION_JOONAPAY) {
      erreurs.push('JOONAPAY_ENV=sandbox mais JOONAPAY_BASE_URL pointe vers la production JoonaPay.');
    } else if (joonaEnv === 'sandbox' && !local && !HOTES_SANDBOX_JOONAPAY.includes(base.hostname)) {
      erreurs.push(`JOONAPAY_BASE_URL ne pointe vers aucun hote sandbox JoonaPay connu (${HOTES_SANDBOX_JOONAPAY.join(', ')}).`);
    }
    // Seul l'hote de production peut activer un abonnement de production : un
    // paiement sandbox ne doit jamais y passer, quel que soit le nom de l'hote.
    if (joonaEnv === 'production' && base.hostname !== HOTE_PRODUCTION_JOONAPAY) {
      erreurs.push(`JOONAPAY_ENV=production mais JOONAPAY_BASE_URL ne pointe pas vers ${HOTE_PRODUCTION_JOONAPAY}.`);
    }
    if (!local && base.pathname.replace(/\/+$/, '') !== CHEMIN_API_JOONAPAY) {
      const exemple = joonaEnv === 'production' ? HOTE_PRODUCTION_JOONAPAY : HOTES_SANDBOX_JOONAPAY[0];
      erreurs.push(`JOONAPAY_BASE_URL doit se terminer par ${CHEMIN_API_JOONAPAY} (ex. https://${exemple}${CHEMIN_API_JOONAPAY}).`);
    }
  }

  const webhook = lireUrl(String(env.JOONAPAY_WEBHOOK_URL || '').trim());
  if (env.JOONAPAY_WEBHOOK_URL && !webhook) erreurs.push('JOONAPAY_WEBHOOK_URL n\'est pas une URL.');
  if (webhook && (webhook.protocol !== 'https:' || LOCAL.test(webhook.hostname) || PRIVE.test(webhook.hostname))) {
    // JoonaPay doit pouvoir joindre cette adresse depuis Internet.
    erreurs.push('JOONAPAY_WEBHOOK_URL doit etre une adresse HTTPS publique (jamais localhost ni une IP privee).');
  }

  const appUrl = String(env.TIMORA_APP_URL || '').trim();
  if (appUrl) {
    const u = lireUrl(appUrl);
    if (!u || (u.protocol !== 'https:' && !LOCAL.test(u.hostname))) {
      erreurs.push('TIMORA_APP_URL doit etre une adresse HTTPS.');
    }
  }

  const supabase = lireUrl(String(env.SUPABASE_URL || '').trim());
  // HTTP seulement vers une instance locale (supabase start, developpement).
  if (env.SUPABASE_URL && (!supabase || (supabase.protocol !== 'https:' && !LOCAL.test(supabase.hostname)))) {
    erreurs.push('SUPABASE_URL doit etre une adresse HTTPS.');
  }

  return {
    ok: manquantes.length === 0 && erreurs.length === 0,
    manquantes,
    erreurs,
    environnement: joonaEnv,
    joonapay: {
      baseUrl: base ? base.href.replace(/\/+$/, '') : '',
      cleClient: String(env.JOONAPAY_CLIENT_KEY || '').trim(),
      clePrivee: String(env.JOONAPAY_PRIVATE_KEY || '').trim(),
      secretWebhook: String(env.JOONAPAY_WEBHOOK_SECRET || '').trim(),
      webhookUrl: webhook ? webhook.href : '',
      // Pays utilise quand celui de l'entreprise n'est pas ouvert au paiement
      // chez JoonaPay (code ISO 3166-1 alpha-2).
      paysParDefaut: String(env.JOONAPAY_DEFAULT_COUNTRY || 'CI').trim().toUpperCase(),
    },
    supabase: {
      url: supabase ? supabase.href.replace(/\/+$/, '') : '',
      cleAnonyme: String(env.SUPABASE_ANON_KEY || '').trim(),
      cleService: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    },
    appUrl: appUrl.replace(/\/+$/, ''),
  };
}

const EMPREINTE = /^[0-9a-f]{64}$/;
const VRAI = /^(true|1|oui|yes)$/i;

/**
 * Configuration du serveur de paiement (payments.timora.tech) : celle de la
 * facturation, plus l'authentification interne, le test de production, la
 * messagerie et les mentions du recu. Ne renvoie jamais une valeur secrete
 * dans un message : seulement des NOMS de variables.
 */
export function lireConfigServeurPaiement(env = process.env) {
  const base = lireConfig(env);
  const manquantes = [...base.manquantes];
  const erreurs = [...base.erreurs];

  const secretInterne = String(env.INTERNAL_PAYMENT_API_SECRET || '').trim();
  if (!secretInterne) manquantes.push('INTERNAL_PAYMENT_API_SECRET');
  else if (secretInterne.length < 32) erreurs.push('INTERNAL_PAYMENT_API_SECRET doit faire au moins 32 caracteres.');

  // Adresses de retour apres paiement : le serveur ne les deduit pas de la
  // requete (elle vient de Vercel), elles sont configurees.
  if (!base.appUrl) manquantes.push('TIMORA_APP_URL');
  else if (base.environnement === 'production' && !base.appUrl.startsWith('https://')) {
    erreurs.push('TIMORA_APP_URL doit etre en HTTPS en production.');
  }

  // Test de production unique (montant reduit). Jamais hors production.
  const testActif = VRAI.test(String(env.PRODUCTION_SMOKE_TEST_ENABLED || '').trim());
  const testMontant = Number(String(env.PRODUCTION_SMOKE_TEST_AMOUNT || '100').trim());
  const testMax = Number(String(env.PRODUCTION_SMOKE_TEST_MAX_USES || '1').trim());
  const testEmpreinte = String(env.PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH || '').trim().toLowerCase();
  if (testActif) {
    if (base.environnement !== 'production') erreurs.push('PRODUCTION_SMOKE_TEST_ENABLED suppose JOONAPAY_ENV=production.');
    if (!Number.isInteger(testMontant) || testMontant < 100 || testMontant > 999) {
      erreurs.push('PRODUCTION_SMOKE_TEST_AMOUNT doit etre un entier entre 100 et 999.');
    }
    if (testMax !== 1) erreurs.push('PRODUCTION_SMOKE_TEST_MAX_USES doit valoir 1 (usage unique).');
    if (testEmpreinte && !EMPREINTE.test(testEmpreinte)) {
      erreurs.push('PRODUCTION_SMOKE_TEST_ALLOWED_EMAIL_HASH doit etre un SHA-256 hexadecimal.');
    }
  }

  // Messagerie (facultative) : sans elle, les recus sont crees et les e-mails
  // restent en attente, envoyes des qu'elle est configuree.
  const smtpHote = String(env.SMTP_HOST || '').trim();
  const expediteur = String(env.EMAIL_FROM || '').trim();
  if (smtpHote && !expediteur) manquantes.push('EMAIL_FROM');
  if (smtpHote && ['localhost', '127.0.0.1'].includes(smtpHote) && base.environnement === 'production') {
    erreurs.push('SMTP_HOST ne peut pas etre local en production.');
  }

  const port = Number(String(env.PORT || '8787').trim());
  return {
    ...base,
    ok: manquantes.length === 0 && erreurs.length === 0,
    manquantes,
    erreurs,
    ecoute: { hote: String(env.HOST || '127.0.0.1').trim(), port: Number.isInteger(port) ? port : 8787 },
    interne: { secret: secretInterne },
    testProduction: {
      active: testActif && base.environnement === 'production',
      montant: testMontant,
      maxUtilisations: testMax,
      empreinteEmail: EMPREINTE.test(testEmpreinte) ? testEmpreinte : null,
    },
    courriel: smtpHote ? {
      hote: smtpHote,
      port: Number(String(env.SMTP_PORT || '587').trim()) || 587,
      securise: VRAI.test(String(env.SMTP_SECURE || '').trim()),
      utilisateur: String(env.SMTP_USER || '').trim(),
      motDePasse: String(env.SMTP_PASSWORD || ''),
      expediteur,
      repondreA: String(env.EMAIL_REPLY_TO || '').trim() || null,
    } : null,
    // Mentions de l'editeur sur le recu : affichees seulement si fournies,
    // jamais inventees.
    editeur: {
      nom: String(env.TIMORA_LEGAL_NAME || '').trim() || null,
      adresse: String(env.TIMORA_LEGAL_ADDRESS || '').trim() || null,
      identifiants: String(env.TIMORA_LEGAL_IDS || '').trim() || null,
      contact: String(env.TIMORA_BILLING_CONTACT || '').trim() || null,
    },
  };
}
