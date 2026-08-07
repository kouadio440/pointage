import { describe, expect, it } from 'vitest';
import {
  ACCURACY_CREDIT_CAP_M,
  evaluateFence,
  formatDistance,
  haversineMeters,
  impliedSpeedKmh,
  isImpossibleTravel,
  isValidLatLng,
  type LatLng,
} from './geo.js';

/** Siege de l'entreprise de demonstration, Abidjan. */
const SIEGE: LatLng = { lat: 5.359942, lng: -4.008311 };

describe('haversineMeters', () => {
  it('renvoie 0 pour deux points identiques', () => {
    expect(haversineMeters(SIEGE, SIEGE)).toBe(0);
  });

  it('un degre de latitude vaut environ 111,19 km', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });

  it('est symetrique', () => {
    const a: LatLng = { lat: 5.3197, lng: -4.0236 };
    const b: LatLng = { lat: 5.3376, lng: -4.0708 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('Plateau -> Yopougon donne environ 5,6 km', () => {
    const plateau: LatLng = { lat: 5.3197, lng: -4.0236 };
    const yopougon: LatLng = { lat: 5.3376, lng: -4.0708 };
    const d = haversineMeters(plateau, yopougon);
    expect(d).toBeGreaterThan(5_300);
    expect(d).toBeLessThan(5_900);
  });

  it("un degre de longitude se resserre en s'eloignant de l'equateur", () => {
    const equateur = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const abidjan = haversineMeters({ lat: 5.36, lng: 0 }, { lat: 5.36, lng: 1 });
    expect(abidjan).toBeLessThan(equateur);
  });
});

describe('evaluateFence', () => {
  const base = { siteCenter: SIEGE, siteRadiusM: 150 };

  it('accepte un pointage au centre du site', () => {
    const r = evaluateFence({ ...base, position: SIEGE, accuracyM: 10 });
    expect(r.inside).toBe(true);
    expect(r.distanceM).toBe(0);
    expect(r.overshootM).toBe(0);
  });

  it('refuse un pointage nettement hors du rayon et chiffre le depassement', () => {
    // ~300 m au nord du siege.
    const loin: LatLng = { lat: SIEGE.lat + 0.0027, lng: SIEGE.lng };
    const r = evaluateFence({ ...base, position: loin, accuracyM: 10 });
    expect(r.inside).toBe(false);
    expect(r.distanceM).toBeGreaterThan(250);
    expect(r.overshootM).toBeGreaterThan(0);
  });

  it('plafonne le credit de precision a 100 m : accuracy 5000 ne neutralise pas le geofence', () => {
    const loin: LatLng = { lat: SIEGE.lat + 0.0027, lng: SIEGE.lng }; // ~300 m
    const r = evaluateFence({ ...base, position: loin, accuracyM: 5000 });

    expect(r.accuracyCreditM).toBe(ACCURACY_CREDIT_CAP_M);
    expect(r.inside).toBe(false);
  });

  it('accorde le benefice du doute a hauteur de la precision reelle', () => {
    // ~200 m : hors du rayon de 150 m, mais une precision de 80 m rattrape.
    const limite: LatLng = { lat: SIEGE.lat + 0.0018, lng: SIEGE.lng };
    const strict = evaluateFence({ ...base, position: limite, accuracyM: 0 });
    const tolerant = evaluateFence({ ...base, position: limite, accuracyM: 80 });

    expect(strict.inside).toBe(false);
    expect(tolerant.inside).toBe(true);
    expect(tolerant.effectiveDistanceM).toBe(strict.distanceM - 80);
  });

  it('ne produit jamais une distance effective negative', () => {
    const r = evaluateFence({ ...base, position: SIEGE, accuracyM: 90 });
    expect(r.effectiveDistanceM).toBe(0);
  });

  it('ignore une precision negative envoyee par un client malveillant', () => {
    const r = evaluateFence({ ...base, position: SIEGE, accuracyM: -500 });
    expect(r.accuracyCreditM).toBe(0);
    expect(r.inside).toBe(true);
  });

  it('accepte exactement sur la limite du rayon', () => {
    const r = evaluateFence({
      position: SIEGE,
      accuracyM: 0,
      siteCenter: SIEGE,
      siteRadiusM: 0,
    });
    expect(r.inside).toBe(true);
  });
});

describe('impliedSpeedKmh / isImpossibleTravel', () => {
  const abidjan: LatLng = { lat: 5.3599, lng: -4.0083 };
  const dakar: LatLng = { lat: 14.7167, lng: -17.4677 };

  it('calcule une vitesse coherente', () => {
    // 111 km en 1 heure -> ~111 km/h
    const v = impliedSpeedKmh({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, 3600);
    expect(v).toBeGreaterThan(110);
    expect(v).toBeLessThan(112);
  });

  it('signale Abidjan -> Dakar en 20 minutes comme impossible', () => {
    expect(isImpossibleTravel(abidjan, dakar, 20 * 60)).toBe(true);
  });

  it("n'est pas declenche par un vol Abidjan -> Dakar en 3 heures", () => {
    expect(isImpossibleTravel(abidjan, dakar, 3 * 3600)).toBe(false);
  });

  it('ignore le bruit GPS : deux points a quelques metres ne declenchent rien', () => {
    const voisin: LatLng = { lat: abidjan.lat + 0.0001, lng: abidjan.lng };
    expect(isImpossibleTravel(abidjan, voisin, 1)).toBe(false);
  });

  it('traite un intervalle nul comme une vitesse infinie', () => {
    expect(impliedSpeedKmh(abidjan, dakar, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(isImpossibleTravel(abidjan, dakar, 0)).toBe(true);
  });
});

describe('isValidLatLng', () => {
  it.each([
    [{ lat: 0, lng: 0 }, true],
    [{ lat: 90, lng: 180 }, true],
    [{ lat: -90, lng: -180 }, true],
    [{ lat: 91, lng: 0 }, false],
    [{ lat: 0, lng: 181 }, false],
    [{ lat: Number.NaN, lng: 0 }, false],
    [{ lat: Number.POSITIVE_INFINITY, lng: 0 }, false],
  ])('%o -> %s', (point, expected) => {
    expect(isValidLatLng(point)).toBe(expected);
  });
});

describe('formatDistance', () => {
  it.each([
    [0, '0 m'],
    [412, '412 m'],
    [412.6, '413 m'],
    [999, '999 m'],
    [1000, '1,0 km'],
    [1849, '1,8 km'],
  ])('%d m -> %s', (input, expected) => {
    expect(formatDistance(input)).toBe(expected);
  });
});
