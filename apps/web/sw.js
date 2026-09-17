/* =============================================================================
 *  TIMORA — SERVICE WORKER
 * =============================================================================
 *
 *  CE QUE CE FICHIER MET EN CACHE, ET CE QU'IL NE TOUCHE JAMAIS
 *  ------------------------------------------------------------
 *  Timora manipule des selfies, des empreintes faciales, des positions GPS et
 *  des donnees RH. Toutes transitent par Supabase, sur une AUTRE origine que
 *  le site. Ce service worker ne s'interpose que sur deux familles de requetes :
 *
 *    1. les fichiers du site lui-meme (page, app.js, styles.css, icones) ;
 *    2. une liste FERMEE de bibliotheques publiques a version figee (CDN).
 *
 *  Tout le reste passe tel quel, sans jamais etre lu ni stocke : Supabase
 *  (authentification, base, stockage des selfies), Google, les images tierces,
 *  et toute requete autre que GET — un pointage ou un envoi de selfie n'est
 *  donc jamais intercepte.
 *
 *  POURQUOI LE CODE DU SITE EST EN « RESEAU D'ABORD »
 *  --------------------------------------------------
 *  app.js et styles.css n'ont pas de nom versionne. Servis depuis le cache en
 *  priorite, ils resteraient figes sur une ancienne version jusqu'a la
 *  prochaine modification de CE fichier. En ligne, la version servie est donc
 *  toujours la derniere ; le cache ne sert qu'en l'absence de reseau. La veille
 *  de mise a jour existante (empreinte d'app.js) continue de fonctionner.
 *
 *  QUAND MODIFIER « VERSION »
 *  --------------------------
 *  Uniquement quand la logique de ce fichier ou la liste de prechargement
 *  change. Un deploiement ordinaire du site n'exige rien ici.
 * ========================================================================== */

const VERSION = 'timora-2026-09-17-1';

const CACHE_SITE = `${VERSION}-site`;
const CACHE_CDN = `${VERSION}-cdn`;

/** Precharges a l'installation : de quoi ouvrir l'application sans reseau. */
const PRECHARGEMENT = [
  '/',
  '/app.js',
  '/auth/auth-flow.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/pwa/install-manager.js',
  '/pwa/sw-registration.js',
  '/favicon.ico',
  '/assets/marque/favicon-32.png',
  '/assets/marque/timora-logo-fond-sombre.png',
  '/assets/marque/timora-logo-fond-clair.png',
  '/assets/marque/timora-icone.png',
  '/assets/marque/pwa-192.png',
  '/assets/marque/apple-touch-icon.png',
];

/** Fichiers du site servis « reseau d'abord ». */
const CODE_DU_SITE = new Set([
  '/app.js',
  '/auth/auth-flow.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/pwa/install-manager.js',
  '/pwa/sw-registration.js',
]);

/**
 * Bibliotheques tierces autorisees en cache.
 *
 * Toutes ont une version FIGEE dans leur adresse : le contenu d'une URL donnee
 * ne change jamais, le cache ne peut donc pas servir un fichier perime. Une
 * adresse absente de cette liste n'est jamais mise en cache.
 */
const CDN_VERSIONNES = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0',
  'https://unpkg.com/lucide@0.344.0/',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/',
  'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/',
  // Moteur et modeles de reconnaissance faciale : des poids de reseau de
  // neurones PUBLICS, identiques pour tous. Aucune donnee d'un utilisateur.
  // Les garder en cache evite de retelecharger 7 Mo a chaque pointage.
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/',
  'https://fonts.gstatic.com/',
];

/**
 * Tailwind : seul CDN sans en-tete CORS. Sa reponse est « opaque » — statut
 * illisible — et ne peut donc pas etre verifiee avant stockage. On l'accepte
 * pour ce seul fichier, en « perime pendant revalidation » : une reponse
 * defectueuse serait remplacee des la requete suivante. Sans lui, l'interface
 * hors ligne s'afficherait sans mise en forme.
 */
const TAILWIND = 'https://cdn.tailwindcss.com/3.4.17';

/** Feuille de styles des polices : contenu variable selon le navigateur. */
const POLICES_CSS = 'https://fonts.googleapis.com/css2';

// -----------------------------------------------------------------------------
//  CYCLE DE VIE
// -----------------------------------------------------------------------------

self.addEventListener('install', (evenement) => {
  evenement.waitUntil((async () => {
    const cache = await caches.open(CACHE_SITE);
    // `cache: 'reload'` contourne le cache HTTP : on precharge ce qui est
    // reellement en ligne, pas une copie locale deja ancienne.
    await cache.addAll(PRECHARGEMENT.map((url) => new Request(url, { cache: 'reload' })));
  })());
  // PAS de skipWaiting() ici : une nouvelle version attend que l'utilisateur
  // accepte la mise a jour. La basculer d'office rechargerait des pages
  // ouvertes, peut-etre en plein pointage.
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms
      .filter((nom) => nom.startsWith('timora-') && !nom.startsWith(VERSION))
      .map((nom) => caches.delete(nom)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (evenement) => {
  const donnees = evenement.data || {};
  if (donnees.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (donnees.type === 'VERSION' && evenement.ports && evenement.ports[0]) {
    evenement.ports[0].postMessage({ version: VERSION });
  }
});

// -----------------------------------------------------------------------------
//  AIGUILLAGE DES REQUETES
// -----------------------------------------------------------------------------

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  // Ecritures (pointage, selfie, formulaires) : jamais interceptees.
  if (requete.method !== 'GET') return;

  // Contournement d'un defaut connu de Chrome (outils de developpement).
  if (requete.cache === 'only-if-cached' && requete.mode !== 'same-origin') return;

  let url;
  try {
    url = new URL(requete.url);
  } catch (err) {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  if (url.origin === self.location.origin) {
    aiguillerMemeOrigine(evenement, requete, url);
    return;
  }

  if (requete.url === TAILWIND) {
    evenement.respondWith(perimePendantRevalidation(requete, CACHE_CDN, { accepterOpaque: true }));
    return;
  }

  if (requete.url.startsWith(POLICES_CSS)) {
    evenement.respondWith(perimePendantRevalidation(requete, CACHE_CDN));
    return;
  }

  if (CDN_VERSIONNES.some((prefixe) => requete.url.startsWith(prefixe))) {
    evenement.respondWith(cacheDAbord(requete, CACHE_CDN));
  }

  // Toute autre origine — Supabase en premier lieu — passe sans interception.
});

function aiguillerMemeOrigine(evenement, requete, url) {
  // L'espace client React (/app/) a son propre cycle de construction et de
  // versionnement : on ne s'y interpose pas.
  if (url.pathname.startsWith('/app/') || url.pathname === '/app') return;

  // Le service worker lui-meme est toujours recupere par le navigateur.
  if (url.pathname === '/sw.js') return;

  if (requete.mode === 'navigate') {
    evenement.respondWith(navigation(requete, url));
    return;
  }

  if (CODE_DU_SITE.has(url.pathname)) {
    evenement.respondWith(reseauDAbord(requete, CACHE_SITE));
    return;
  }

  if (url.pathname.startsWith('/assets/marque/') || url.pathname === '/favicon.ico') {
    evenement.respondWith(perimePendantRevalidation(requete, CACHE_SITE));
  }

  // Tout autre fichier du site n'est pas mis en cache.
}

// -----------------------------------------------------------------------------
//  STRATEGIES
// -----------------------------------------------------------------------------

/** Une reponse ne va en cache que si elle est complete, lisible et cachable. */
function peutEtreStockee(reponse, { accepterOpaque = false } = {}) {
  if (!reponse) return false;
  if (reponse.type === 'opaque') return accepterOpaque;
  if (!reponse.ok || reponse.status !== 200) return false;
  if (reponse.type !== 'basic' && reponse.type !== 'cors') return false;
  // Une reponse marquee « no-store » par le serveur ne doit jamais etre copiee.
  const cc = (reponse.headers.get('Cache-Control') || '').toLowerCase();
  return !cc.includes('no-store');
}

/**
 * Navigation vers une page du site : reseau d'abord.
 *
 * Seule la page d'accueil (`/` ou `/index.html`) est enregistree, et seulement
 * si son adresse ne porte AUCUN parametre. Un retour de connexion Google
 * (`?oauth=google&code=...`) ou tout autre lien portant un jeton n'est ainsi
 * jamais conserve, et une autre page du site ne peut pas remplacer l'accueil
 * en cache. Le fragment (#dashboard, #employee) n'est jamais envoye au
 * reseau : toutes les vues de l'application partagent cette meme page.
 */
async function navigation(requete, url) {
  const estAccueil = url.pathname === '/' || url.pathname === '/index.html';
  try {
    const reponse = await fetch(requete);
    if (estAccueil && !url.search && peutEtreStockee(reponse)) {
      const cache = await caches.open(CACHE_SITE);
      await cache.put('/', reponse.clone());
    }
    return reponse;
  } catch (err) {
    if (estAccueil) {
      const enCache = await caches.match('/', { cacheName: CACHE_SITE });
      if (enCache) return enCache;
    }
    return pageHorsLigne();
  }
}

async function reseauDAbord(requete, nomCache) {
  try {
    const reponse = await fetch(requete);
    if (peutEtreStockee(reponse)) {
      const cache = await caches.open(nomCache);
      await cache.put(requete, reponse.clone());
    }
    return reponse;
  } catch (err) {
    const enCache = await caches.match(requete, { cacheName: nomCache, ignoreSearch: true });
    if (enCache) return enCache;
    throw err;
  }
}

async function cacheDAbord(requete, nomCache) {
  const enCache = await caches.match(requete, { cacheName: nomCache });
  if (enCache) return enCache;

  const reponse = await fetch(requete);
  if (peutEtreStockee(reponse)) {
    const cache = await caches.open(nomCache);
    await cache.put(requete, reponse.clone());
  }
  return reponse;
}

async function perimePendantRevalidation(requete, nomCache, options = {}) {
  const cache = await caches.open(nomCache);
  const enCache = await cache.match(requete);

  const rafraichissement = fetch(requete)
    .then(async (reponse) => {
      if (peutEtreStockee(reponse, options)) await cache.put(requete, reponse.clone());
      return reponse;
    })
    .catch(() => null);

  if (enCache) return enCache;
  const reponse = await rafraichissement;
  if (reponse) return reponse;
  return Response.error();
}

/**
 * Page de secours, entierement autonome (aucune ressource externe).
 *
 * Servie seulement si la page d'accueil n'a jamais pu etre mise en cache.
 * Elle ne pretend rien : sans reseau, aucun pointage n'est possible.
 */
function pageHorsLigne() {
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#181310">
<title>Timora — Hors connexion</title>
<style>
  html,body{margin:0;height:100%;background:#181310;color:#FFFBF5;font-family:system-ui,-apple-system,sans-serif}
  main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;
       padding:2rem 1.5rem calc(2rem + env(safe-area-inset-bottom));text-align:center;box-sizing:border-box}
  h1{font-size:1.25rem;margin:0}
  p{margin:0;max-width:22rem;color:#D5C4B5;line-height:1.5;font-size:.9375rem}
  button{min-height:44px;padding:0 1.5rem;border:0;border-radius:.75rem;font-weight:700;font-size:.9375rem;
         background:linear-gradient(90deg,#F59E0B,#EA580C);color:#1a1207;cursor:pointer}
  button:focus-visible{outline:2px solid #F59E0B;outline-offset:3px}
</style></head>
<body><main>
  <h1>Connexion indisponible</h1>
  <p>Timora a besoin d'Internet pour vérifier votre identité et votre position. Aucun pointage n'a été enregistré.</p>
  <button type="button" onclick="location.reload()">Réessayer</button>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
