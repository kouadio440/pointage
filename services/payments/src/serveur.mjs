// SERVEUR DE PAIEMENT TIMORA — payments.timora.tech
//
// Seule passerelle de Timora vers JoonaPay : il tourne sur un serveur a IPv4
// FIXE (declaree dans la liste blanche JoonaPay), derriere Caddy (HTTPS), et
// detient seul les cles JoonaPay et la cle de service Supabase.
//
//   GET  /health                               public, sans detail
//   POST /api/payments/checkout                interne : signature HMAC (Vercel)
//                                              + jeton de session de l'acheteur
//   GET  /api/payments/:reference/status       interne : idem
//   POST /api/webhooks/joonapay                JoonaPay : signature HMAC JoonaPay
//
// Le navigateur n'appelle jamais ce serveur : il parle a www.timora.tech
// (Vercel), qui signe ses requetes (server/passerelle/signature.mjs). Aucun
// en-tete CORS n'est emis.

import http from 'node:http';
import dns from 'node:dns';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lireConfigServeurPaiement } from '../../../server/facturation/config.mjs';
import { journaliser } from '../../../server/facturation/journal.mjs';
import { verifierSession } from '../../../server/facturation/supabase.mjs';
import { demarrerPaiement, verifierPaiement, traiterWebhook, REFERENCE } from '../../../server/facturation/facturation.mjs';
import { verifier as verifierSignature, RegistreNonces } from '../../../server/passerelle/signature.mjs';
import { Limiteur } from './limiteur.mjs';
import { repondreJson, lireCorps, ipCliente, CorpsTropGrand } from './http-outils.mjs';
import { creerTraitementRecus } from './recus.mjs';
import { creerTaches } from './taches.mjs';

// La liste blanche JoonaPay contient l'IPv4 fixe du serveur : sortie en IPv4.
dns.setDefaultResultOrder('ipv4first');

export const VERSION = '1.0.0';
const TAILLE_MAX_INTERNE = 8 * 1024;
const TAILLE_MAX_WEBHOOK = 64 * 1024;
const FORMAT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const DUREE_CACHE_SESSION_MS = 30 * 1000;

/**
 * Cree le serveur (sans l'ecouter). Tout est injectable pour les tests.
 */
export const LIMITES_PAR_DEFAUT = Object.freeze({
  // Large : Vercel sort par quelques adresses partagees. Les vraies limites
  // sont par compte (ci-dessous) et par entreprise (base : 6 / 10 minutes).
  parIp: { capacite: 300, parMinute: 1200 },
  webhookParIp: { capacite: 60, parMinute: 120 },
  checkoutParCompte: { capacite: 5, parMinute: 5 },
  statutParCompte: { capacite: 30, parMinute: 60 },
});

export function creerServeurPaiement(config, { recus = null, maintenant = () => Date.now(), limites = {} } = {}) {
  const demarrageS = Math.floor(maintenant() / 1000);
  const registre = new RegistreNonces();
  const l = { ...LIMITES_PAR_DEFAUT, ...limites };
  const parIp = new Limiteur(l.parIp);
  const webhookParIp = new Limiteur(l.webhookParIp);
  const checkoutParCompte = new Limiteur(l.checkoutParCompte);
  const statutParCompte = new Limiteur(l.statutParCompte);
  const sessions = new Map(); // empreinte du jeton -> { utilisateur, expire }

  const traitementRecus = recus || creerTraitementRecus(config);
  // Recu emis pendant une activation : produit tout de suite, hors requete.
  config.surRecuEmis = (id) => {
    setImmediate(() => traitementRecus.traiterUn(id).catch(() => {}));
  };

  async function session(jeton) {
    const cle = createHash('sha256').update(jeton).digest('hex');
    const connue = sessions.get(cle);
    if (connue && connue.expire > maintenant()) return { ok: true, utilisateur: connue.utilisateur };
    const s = await verifierSession(config, jeton);
    if (s.ok) {
      if (sessions.size > 5000) sessions.clear();
      sessions.set(cle, { utilisateur: s.utilisateur, expire: maintenant() + DUREE_CACHE_SESSION_MS });
    }
    return s;
  }

  /** Requete interne : signature Vercel, puis compte de l'acheteur. */
  async function authentifier(req, corpsBrut, trace) {
    const v = verifierSignature({
      secret: config.interne.secret,
      methode: req.method,
      chemin: req.url,
      entetes: req.headers,
      corps: corpsBrut.toString('utf8'),
      registre,
      demarrageS,
      maintenant: maintenant(),
    });
    if (!v.ok) {
      journaliser('INTERNAL_SIGNATURE_REJECTED', { ...trace, code: v.code });
      return { status: 401, corps: { code: 'SIGNATURE_INTERNE_REFUSEE', message: 'Requête refusée.' } };
    }
    if (!v.jeton || v.jeton.length > 4096 || !FORMAT_JWT.test(v.jeton)) {
      return { status: 401, corps: { code: 'SESSION_REQUISE', message: 'Connectez-vous pour continuer.' } };
    }
    const s = await session(v.jeton);
    if (!s.ok) {
      if (s.code === 'SESSION_EXPIREE') return { status: 401, corps: { code: 'SESSION_EXPIREE', message: 'Votre session a expiré. Reconnectez-vous.' } };
      journaliser('SUPABASE_WRITE_FAILED', { ...trace, etape: 'verification_session', code: s.code });
      return { status: 503, corps: { code: 'VERIFICATION_IMPOSSIBLE', message: 'Service momentanément indisponible. Réessayez.' } };
    }
    if (!s.utilisateur.emailVerifie) {
      return { status: 403, corps: { code: 'EMAIL_NON_VERIFIE', message: 'Confirmez votre adresse e-mail pour continuer.' } };
    }
    return { utilisateur: s.utilisateur };
  }

  async function router(req, res, trace) {
    const url = new URL(req.url, 'http://interne');
    const chemin = url.pathname;

    if (chemin === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return repondreJson(res, 405, { code: 'METHODE_REFUSEE' });
      return repondreJson(res, 200, { status: 'ok', service: 'timora-payments', version: VERSION });
    }

    if (chemin === '/api/webhooks/joonapay') {
      if (req.method !== 'POST') return repondreJson(res, 405, { code: 'METHODE_REFUSEE' });
      if (!webhookParIp.autoriser(trace.ip)) return repondreJson(res, 429, { received: false });
      const corpsBrut = await lireCorps(req, TAILLE_MAX_WEBHOOK);
      if (corpsBrut.length === 0) return repondreJson(res, 400, { received: false });
      const r = await traiterWebhook(config, { corpsBrut, signature: req.headers['x-webhook-signature'] || null });
      return repondreJson(res, r.status, r.corps);
    }

    if (chemin === '/api/payments/checkout') {
      if (req.method !== 'POST') return repondreJson(res, 405, { code: 'METHODE_REFUSEE' });
      const corpsBrut = await lireCorps(req, TAILLE_MAX_INTERNE);
      const a = await authentifier(req, corpsBrut, trace);
      if (!a.utilisateur) return repondreJson(res, a.status, a.corps);
      if (!checkoutParCompte.autoriser(a.utilisateur.id)) {
        return repondreJson(res, 429, { code: 'TROP_DE_TENTATIVES', message: 'Trop de tentatives de paiement. Réessayez dans quelques minutes.' });
      }
      let corps;
      try {
        corps = JSON.parse(corpsBrut.toString('utf8') || '{}');
      } catch {
        return repondreJson(res, 400, { code: 'JSON_INVALIDE', message: 'Requête invalide.' });
      }
      if (!corps || typeof corps !== 'object' || Array.isArray(corps)) {
        return repondreJson(res, 400, { code: 'JSON_INVALIDE', message: 'Requête invalide.' });
      }
      // Seuls la formule et la periode sont lues. Tout montant fourni est ignore.
      const r = await demarrerPaiement(config, {
        utilisateur: a.utilisateur,
        plan: typeof corps.plan === 'string' ? corps.plan.trim().toLowerCase() : '',
        periode: typeof corps.period === 'string' ? corps.period : null,
      });
      return repondreJson(res, r.status, r.corps);
    }

    const statut = /^\/api\/payments\/([A-Z0-9-]{10,40})\/status$/.exec(chemin);
    if (statut) {
      if (req.method !== 'GET') return repondreJson(res, 405, { code: 'METHODE_REFUSEE' });
      const corpsBrut = await lireCorps(req, TAILLE_MAX_INTERNE);
      const a = await authentifier(req, corpsBrut, trace);
      if (!a.utilisateur) return repondreJson(res, a.status, a.corps);
      if (!statutParCompte.autoriser(a.utilisateur.id)) {
        return repondreJson(res, 429, { code: 'TROP_DE_REQUETES', message: 'Patientez quelques secondes.' });
      }
      if (!REFERENCE.test(statut[1])) return repondreJson(res, 400, { code: 'REFERENCE_INVALIDE', message: 'Référence de paiement invalide.' });
      const r = await verifierPaiement(config, { utilisateur: a.utilisateur, reference: statut[1] });
      return repondreJson(res, r.status, r.corps);
    }

    return repondreJson(res, 404, { code: 'INTROUVABLE' });
  }

  const serveur = http.createServer(async (req, res) => {
    const debut = maintenant();
    const trace = { requete: randomUUID(), ip: ipCliente(req), methode: req.method, chemin: String(req.url || '').split('?')[0].slice(0, 80) };
    res.setHeader('X-Request-Id', trace.requete);
    try {
      if (!parIp.autoriser(trace.ip)) {
        repondreJson(res, 429, { code: 'TROP_DE_REQUETES' });
      } else {
        await router(req, res, trace);
      }
    } catch (err) {
      if (err instanceof CorpsTropGrand) {
        repondreJson(res, 413, { code: 'REQUETE_TROP_GRANDE' });
      } else {
        journaliser('ERREUR_SERVEUR', { ...trace, erreur: err && err.name });
        repondreJson(res, 500, { code: 'ERREUR_SERVEUR', message: 'Une erreur est survenue. Aucun montant n\'a été débité.' });
      }
    } finally {
      journaliser('HTTP', { ...trace, status: res.statusCode, duree_ms: maintenant() - debut });
    }
  });

  serveur.requestTimeout = 30000;
  serveur.headersTimeout = 15000;
  serveur.keepAliveTimeout = 5000;
  serveur.maxRequestsPerSocket = 100;
  return { serveur, recus: traitementRecus };
}

// -----------------------------------------------------------------------------
// Lancement (systemd : node src/serveur.mjs)
// -----------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = lireConfigServeurPaiement(process.env);
  if (!config.ok) {
    // Seulement les NOMS des variables en cause, jamais leurs valeurs.
    journaliser('CONFIGURATION_INVALIDE', { manquantes: config.manquantes, erreurs: config.erreurs });
    process.exitCode = 78; // EX_CONFIG : systemd ne relance pas en boucle
  } else {
    const { serveur, recus } = creerServeurPaiement(config);
    const taches = creerTaches(config, recus);
    serveur.listen(config.ecoute.port, config.ecoute.hote, () => {
      journaliser('SERVEUR_DEMARRE', {
        version: VERSION,
        environment: config.environnement,
        ecoute: `${config.ecoute.hote}:${config.ecoute.port}`,
        messagerie: recus.messagerie,
        test_production: config.testProduction.active,
      });
      taches.demarrer();
    });
    const arreter = (signal) => {
      journaliser('SERVEUR_ARRET', { signal });
      taches.arreter();
      serveur.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => arreter('SIGTERM'));
    process.on('SIGINT', () => arreter('SIGINT'));
  }
}
