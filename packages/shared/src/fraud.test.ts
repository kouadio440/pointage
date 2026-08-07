import { describe, expect, it } from 'vitest';
import {
  evaluateFraud,
  FRAUD_POLICY_VERSION,
  FRAUD_SIGNALS,
  NATIVE_ONLY_SIGNALS,
  SCORE_THRESHOLDS,
  SIGNAL_SPECS,
  type FraudSignalCode,
  type RaisedSignal,
} from './fraud.js';

const sig = (...codes: FraudSignalCode[]): RaisedSignal[] => codes.map((code) => ({ code }));

describe('coherence de la table des signaux', () => {
  it('decrit chaque signal declare', () => {
    for (const code of FRAUD_SIGNALS) {
      expect(SIGNAL_SPECS[code], `signal ${code} non decrit`).toBeDefined();
      expect(SIGNAL_SPECS[code].label.length).toBeGreaterThan(3);
    }
  });

  it('donne un poids a tout signal non bloquant, et aucun aux vetos', () => {
    for (const code of FRAUD_SIGNALS) {
      const spec = SIGNAL_SPECS[code];
      if (spec.veto) expect(spec.weight).toBeNull();
      else expect(spec.weight).toBeGreaterThan(0);
    }
  });

  it('reserve les signaux mock location, root, emulateur et balise au natif', () => {
    expect(NATIVE_ONLY_SIGNALS).toEqual(
      expect.arrayContaining(['MOCK_LOCATION', 'ROOTED_DEVICE', 'EMULATOR', 'BEACON_ABSENT']),
    );
  });
});

describe('evaluateFraud - cas nominal', () => {
  it('accepte un pointage sans aucun signal', () => {
    const v = evaluateFraud([]);
    expect(v.decision).toBe('ACCEPTED');
    expect(v.score).toBe(0);
    expect(v.vetoedBy).toBeNull();
    expect(v.policyVersion).toBe(FRAUD_POLICY_VERSION);
  });

  it('accepte encore sous le seuil de revue', () => {
    // UNKNOWN_DEVICE (15) seul = 15 < 30
    const v = evaluateFraud(sig('UNKNOWN_DEVICE'));
    expect(v.score).toBe(15);
    expect(v.decision).toBe('ACCEPTED');
  });
});

describe('evaluateFraud - seuils', () => {
  it('met en revue a partir de 30', () => {
    // GPS_IMPRECISE (25) + UNKNOWN_DEVICE (15) = 40
    const v = evaluateFraud(sig('GPS_IMPRECISE', 'UNKNOWN_DEVICE'));
    expect(v.score).toBe(40);
    expect(v.decision).toBe('PENDING_REVIEW');
  });

  it('refuse a partir de 60', () => {
    // IMPOSSIBLE_TRAVEL (40) + GPS_IMPRECISE (25) = 65
    const v = evaluateFraud(sig('IMPOSSIBLE_TRAVEL', 'GPS_IMPRECISE'));
    expect(v.score).toBe(65);
    expect(v.decision).toBe('REJECTED');
  });

  it('accepte exactement sous le seuil de revue et le declenche a la valeur pile', () => {
    const sous = evaluateFraud(sig('CLOCK_SKEW')); // 20
    expect(sous.decision).toBe('ACCEPTED');

    // CLOCK_SKEW (20) + OFFLINE_BACKDATED (10) = 30 exactement
    const pile = evaluateFraud(sig('CLOCK_SKEW', 'OFFLINE_BACKDATED'));
    expect(pile.score).toBe(SCORE_THRESHOLDS.REVIEW);
    expect(pile.decision).toBe('PENDING_REVIEW');
  });
});

describe('evaluateFraud - vetos', () => {
  it.each(FRAUD_SIGNALS.filter((c) => SIGNAL_SPECS[c].veto))(
    '%s refuse le pointage a lui seul, avec un score de 0',
    (code) => {
      const v = evaluateFraud(sig(code));
      expect(v.decision).toBe('REJECTED');
      expect(v.score).toBe(0);
      expect(v.vetoedBy).toBe(code);
    },
  );

  it('un veto prime sur un score par ailleurs acceptable', () => {
    const v = evaluateFraud(sig('OUTSIDE_FENCE'));
    expect(v.score).toBeLessThan(SCORE_THRESHOLDS.REVIEW);
    expect(v.decision).toBe('REJECTED');
  });

  it('hors zone + appareil inconnu + position imprecise est refuse', () => {
    const v = evaluateFraud(sig('OUTSIDE_FENCE', 'UNKNOWN_DEVICE', 'GPS_IMPRECISE'));
    expect(v.decision).toBe('REJECTED');
    expect(v.vetoedBy).toBe('OUTSIDE_FENCE');
    // Les signaux ponderes restent tracables pour l'audit, meme sous veto.
    expect(v.contributors.map((c) => c.code)).toEqual(['GPS_IMPRECISE', 'UNKNOWN_DEVICE']);
  });
});

describe('evaluateFraud - determinisme', () => {
  it("ne depend pas de l'ordre d'arrivee des signaux", () => {
    const a = evaluateFraud(sig('GPS_IMPRECISE', 'UNKNOWN_DEVICE', 'CLOCK_SKEW'));
    const b = evaluateFraud(sig('CLOCK_SKEW', 'UNKNOWN_DEVICE', 'GPS_IMPRECISE'));
    expect(a).toEqual(b);
  });

  it("retient le meme veto quel que soit l'ordre", () => {
    const a = evaluateFraud(sig('QR_REPLAY', 'OUTSIDE_FENCE'));
    const b = evaluateFraud(sig('OUTSIDE_FENCE', 'QR_REPLAY'));
    expect(a.vetoedBy).toBe(b.vetoedBy);
  });

  it('ne compte pas deux fois un signal duplique', () => {
    const simple = evaluateFraud(sig('IMPOSSIBLE_TRAVEL'));
    const double = evaluateFraud(sig('IMPOSSIBLE_TRAVEL', 'IMPOSSIBLE_TRAVEL'));
    expect(double.score).toBe(simple.score);
    expect(double.decision).toBe(simple.decision);
  });

  it('rejouer les signaux archives reproduit exactement la decision', () => {
    // Simule la relecture des lignes FraudSignal persistees pour un pointage.
    const archive: RaisedSignal[] = [
      { code: 'GPS_IMPRECISE', value: '180' },
      { code: 'UNKNOWN_DEVICE', value: 'Chrome/Android' },
      { code: 'CLOCK_SKEW', value: '22' },
    ];
    const original = evaluateFraud(archive);
    const rejeu = evaluateFraud([...archive].reverse());

    expect(rejeu.decision).toBe(original.decision);
    expect(rejeu.score).toBe(original.score);
    expect(rejeu.policyVersion).toBe(original.policyVersion);
    expect(rejeu).toEqual(original);
  });

  it('est une fonction pure : appels repetes, resultats identiques', () => {
    const input = sig('VPN_OR_DATACENTER_IP', 'COUNTRY_MISMATCH');
    const results = Array.from({ length: 5 }, () => evaluateFraud(input));
    for (const r of results) expect(r).toEqual(results[0]);
  });
});

describe('evaluateFraud - tracabilite', () => {
  it('classe les contributeurs par poids decroissant', () => {
    const v = evaluateFraud(sig('UNKNOWN_DEVICE', 'IMPOSSIBLE_TRAVEL', 'GPS_IMPRECISE'));
    expect(v.contributors).toEqual([
      { code: 'IMPOSSIBLE_TRAVEL', weight: 40 },
      { code: 'GPS_IMPRECISE', weight: 25 },
      { code: 'UNKNOWN_DEVICE', weight: 15 },
    ]);
  });

  it('estampille chaque verdict avec la version de politique', () => {
    expect(evaluateFraud([]).policyVersion).toBe('v1');
  });
});
