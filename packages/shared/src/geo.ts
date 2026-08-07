/**
 * Geometrie du geofencing.
 *
 * Partage entre l'API (qui DECIDE) et le front (qui donne un retour immediat
 * a l'employe, meme hors ligne : "vous etes a 412 m"). Le front n'a jamais
 * autorite : il informe, l'API tranche.
 */

/** Rayon moyen de la Terre en metres (WGS-84). */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  lat: number;
  lng: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Distance orthodromique entre deux points, en metres.
 *
 * La formule de haversine suffit largement ici : l'erreur face a un modele
 * ellipsoidal reste sous le metre aux distances d'un geofence (< 1 km), soit
 * bien en dessous de la precision d'un GPS de telephone.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Plafond du credit de precision, en metres.
 *
 * On accorde le benefice du doute a hauteur de la precision annoncee par le GPS,
 * MAIS plafonnee : sans ce plafond, un appareil declarant `accuracy: 5000`
 * neutraliserait n'importe quel geofence. C'est l'attaque la plus simple
 * contre un pointage geolocalise, et elle ne coute rien a l'attaquant.
 */
export const ACCURACY_CREDIT_CAP_M = 100;

export interface FenceInput {
  /** Position rapportee par le client. */
  position: LatLng;
  /** Precision annoncee par le GPS, en metres. */
  accuracyM: number;
  /** Centre du site. */
  siteCenter: LatLng;
  /** Rayon autorise du site, en metres. */
  siteRadiusM: number;
}

export interface FenceResult {
  /** Distance brute au centre du site, arrondie au metre. */
  distanceM: number;
  /** Credit reellement accorde (precision plafonnee). */
  accuracyCreditM: number;
  /** Distance apres credit : c'est elle qui decide. */
  effectiveDistanceM: number;
  inside: boolean;
  /** Depassement en metres quand `inside` est faux, 0 sinon. */
  overshootM: number;
}

/**
 * Evalue l'appartenance au geofence.
 *
 * `effectiveDistance = distance - min(accuracy, 100)`, compare au rayon du site.
 */
export function evaluateFence(input: FenceInput): FenceResult {
  const distanceM = Math.round(haversineMeters(input.position, input.siteCenter));
  const accuracyCreditM = Math.min(Math.max(input.accuracyM, 0), ACCURACY_CREDIT_CAP_M);
  const effectiveDistanceM = Math.max(0, distanceM - accuracyCreditM);
  const inside = effectiveDistanceM <= input.siteRadiusM;

  return {
    distanceM,
    accuracyCreditM,
    effectiveDistanceM,
    inside,
    overshootM: inside ? 0 : effectiveDistanceM - input.siteRadiusM,
  };
}

/**
 * Vitesse implicite entre deux pointages, en km/h.
 * Sert a la detection de deplacement impossible.
 */
export function impliedSpeedKmh(from: LatLng, to: LatLng, elapsedSeconds: number): number {
  if (elapsedSeconds <= 0) return Number.POSITIVE_INFINITY;
  const km = haversineMeters(from, to) / 1000;
  return km / (elapsedSeconds / 3600);
}

/**
 * Seuil de deplacement impossible.
 *
 * 900 km/h correspond a un vol commercial : au-dela, aucun deplacement terrestre
 * ou aerien plausible n'explique les deux pointages. On reste volontairement
 * tres permissif pour ne pas penaliser un commercial qui prend l'avion
 * Abidjan-Dakar entre deux visites.
 */
export const IMPOSSIBLE_TRAVEL_KMH = 900;

/** Distance minimale sous laquelle on n'evalue pas la vitesse (bruit GPS). */
export const IMPOSSIBLE_TRAVEL_MIN_DISTANCE_M = 1000;

export function isImpossibleTravel(from: LatLng, to: LatLng, elapsedSeconds: number): boolean {
  if (haversineMeters(from, to) < IMPOSSIBLE_TRAVEL_MIN_DISTANCE_M) return false;
  return impliedSpeedKmh(from, to, elapsedSeconds) > IMPOSSIBLE_TRAVEL_KMH;
}

/** Bornes de validite d'une coordonnee. */
export function isValidLatLng(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/** Formate une distance pour l'affichage francais : "412 m", "1,8 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}
