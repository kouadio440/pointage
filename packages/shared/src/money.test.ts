import { describe, expect, it } from 'vitest';
import { costOfMinutes, formatFcfa, formatFcfaCompact } from './money.js';

/** Separateur de milliers attendu : espace ASCII ordinaire (code 32). */
const NB = String.fromCharCode(32);

/** Caracteres invisibles qui cassent les exports Excel / PDF / SMS. */
const INVISIBLES = [
  String.fromCharCode(0x202f), // espace insecable etroite
  String.fromCharCode(0x00a0), // espace insecable
  String.fromCharCode(0x2009), // espace fine
];

describe('formatFcfa', () => {
  it.each([
    [0, `0${NB}FCFA`],
    [500, `500${NB}FCFA`],
    [25000, `25${NB}000${NB}FCFA`],
    [65000, `65${NB}000${NB}FCFA`],
    [718750, `718${NB}750${NB}FCFA`],
    [1234567, `1${NB}234${NB}567${NB}FCFA`],
    [-25000, `-25${NB}000${NB}FCFA`],
  ])('%d -> %s', (input, expected) => {
    expect(formatFcfa(input)).toBe(expected);
  });

  it('omet le libelle sur demande', () => {
    expect(formatFcfa(25000, { withLabel: false })).toBe(`25${NB}000`);
  });

  it("arrondit au franc : le XOF n'a pas de subdivision utilisee", () => {
    expect(formatFcfa(1234.7)).toBe(`1${NB}235${NB}FCFA`);
  });

  it('unifie les deux formats incoherents du prototype', () => {
    // Le prototype affichait "25.000 FCFA" dans les tarifs et "718 750 FCFA"
    // via toLocaleString. Un seul format desormais.
    expect(formatFcfa(25000)).not.toContain('.');
    expect(formatFcfa(718750)).not.toContain('.');
  });
});

describe('robustesse des exports', () => {
  it("n'introduit aucun caractere invisible dans un montant", () => {
    // U+202F et consorts cassent le parsing numerique d'Excel et s'affichent
    // en losange dans plusieurs lecteurs PDF. Ce test verrouille le choix.
    const echantillons = [0, 500, 25_000, 718_750, 1_234_567, -25_000];
    for (const montant of echantillons) {
      const rendu = formatFcfa(montant);
      for (const invisible of INVISIBLES) {
        expect(
          rendu.includes(invisible),
          `${rendu} contient U+${invisible.charCodeAt(0).toString(16).toUpperCase()}`,
        ).toBe(false);
      }
    }
  });

  it("n'introduit aucun caractere invisible dans un montant compact", () => {
    for (const montant of [450, 45_000, 1_200_000]) {
      const rendu = formatFcfaCompact(montant);
      for (const invisible of INVISIBLES) {
        expect(rendu.includes(invisible), `${rendu} contient un caractere invisible`).toBe(false);
      }
    }
  });
});

describe('formatFcfaCompact', () => {
  it.each([
    [450, `450${NB}FCFA`],
    [45000, `45${NB}k${NB}FCFA`],
    [1200000, `1,2${NB}M${NB}FCFA`],
    [-1200000, `-1,2${NB}M${NB}FCFA`],
  ])('%d -> %s', (input, expected) => {
    expect(formatFcfaCompact(input)).toBe(expected);
  });
});

describe('costOfMinutes', () => {
  it("chiffre le cout d'un retard sur la base du salaire mensuel", () => {
    // 150 000 FCFA / 173,33 h = 865,4 FCFA/h. 30 min -> ~433 FCFA.
    const cout = costOfMinutes(30, 150_000);
    expect(cout).toBeGreaterThan(420);
    expect(cout).toBeLessThan(445);
  });

  it('est proportionnel a la duree', () => {
    expect(costOfMinutes(60, 150_000)).toBeCloseTo(costOfMinutes(30, 150_000) * 2, -1);
  });

  it("renvoie 0 pour un volume horaire nul plutot qu'une division par zero", () => {
    expect(costOfMinutes(60, 150_000, 0)).toBe(0);
  });

  it('renvoie un entier', () => {
    expect(Number.isInteger(costOfMinutes(37, 233_333))).toBe(true);
  });
});
