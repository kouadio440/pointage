import { describe, expect, it } from 'vitest';
import {
  businessDate,
  clockSkewMinutes,
  durationMinutes,
  formatClock,
  formatDate,
  formatDuration,
  formatHourMinute,
  formatTime,
  minutesToHourMinute,
  parseHourMinute,
} from './time.js';

/** 6 aout 2026, 08:02:14 UTC. Abidjan etant en UTC+0, c'est aussi l'heure locale. */
const T = new Date('2026-08-06T08:02:14.000Z');

describe('formatage a Abidjan', () => {
  it('formate une heure complete', () => {
    expect(formatTime(T)).toBe('08:02:14');
  });

  it('formate une heure courte', () => {
    expect(formatHourMinute(T)).toBe('08:02');
  });

  it('formate une date a la francaise', () => {
    expect(formatDate(T)).toBe('06/08/2026');
  });

  it("reproduit le format de l'horloge du site vitrine", () => {
    expect(formatClock(T)).toBe('08:02:14 GMT (Abidjan)');
  });

  it('respecte un fuseau explicite (entreprise hors Abidjan)', () => {
    // Douala est en UTC+1 : 08:02 UTC devient 09:02 local.
    expect(formatHourMinute(T, 'Africa/Douala')).toBe('09:02');
  });
});

describe('businessDate', () => {
  it('produit une date ISO courte', () => {
    expect(businessDate(T)).toBe('2026-08-06');
  });

  it('rattache un pointage de 23h30 a Abidjan au bon jour, meme si le serveur est deja au lendemain', () => {
    // 23:30 a Abidjan (UTC+0) = 01:30 le 7 aout a Paris (UTC+2).
    const tard = new Date('2026-08-06T23:30:00.000Z');
    expect(businessDate(tard, 'Africa/Abidjan')).toBe('2026-08-06');
    expect(businessDate(tard, 'Europe/Paris')).toBe('2026-08-07');
  });

  it('rattache un pointage de 00h30 a Douala au jour local, pas au jour UTC', () => {
    // 23:30 UTC le 6 = 00:30 le 7 a Douala (UTC+1).
    const nuit = new Date('2026-08-06T23:30:00.000Z');
    expect(businessDate(nuit, 'Africa/Douala')).toBe('2026-08-07');
  });
});

describe('parseHourMinute', () => {
  it.each([
    ['08:00', 480],
    ['00:00', 0],
    ['23:59', 1439],
    ['17:30', 1050],
    [' 08:00 ', 480],
  ])('%s -> %d', (input, expected) => {
    expect(parseHourMinute(input)).toBe(expected);
  });

  it.each(['24:00', '8:00', '08:60', 'abc', '', '08h00'])('rejette %s', (input) => {
    expect(parseHourMinute(input)).toBeNull();
  });
});

describe('minutesToHourMinute', () => {
  it.each([
    [480, '08:00'],
    [0, '00:00'],
    [1439, '23:59'],
    [1440, '00:00'],
    [1500, '01:00'],
    [-60, '23:00'],
  ])('%d -> %s', (input, expected) => {
    expect(minutesToHourMinute(input)).toBe(expected);
  });
});

describe('durationMinutes', () => {
  it('calcule une journee ordinaire', () => {
    expect(durationMinutes(480, 1020)).toBe(540); // 08:00 -> 17:00
  });

  it('gere une equipe de nuit qui passe minuit', () => {
    // 22:00 -> 06:00 doit valoir 8 h, pas -16 h.
    expect(durationMinutes(1320, 360)).toBe(480);
  });

  it('renvoie 0 pour deux heures identiques', () => {
    expect(durationMinutes(480, 480)).toBe(0);
  });
});

describe('formatDuration', () => {
  it.each([
    [450, '7 h 30'],
    [480, '8 h'],
    [45, '45 min'],
    [0, '0 min'],
    [-30, '-30 min'],
    [605, '10 h 05'],
  ])('%d min -> %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe('clockSkewMinutes', () => {
  it('detecte une horloge en avance', () => {
    const serveur = new Date('2026-08-06T08:00:00.000Z');
    const client = new Date('2026-08-06T08:22:00.000Z');
    expect(clockSkewMinutes(client, serveur)).toBe(22);
  });

  it('detecte une horloge reculee, utilisee pour antidater un pointage', () => {
    const serveur = new Date('2026-08-06T08:20:00.000Z');
    const client = new Date('2026-08-06T08:00:00.000Z');
    expect(clockSkewMinutes(client, serveur)).toBe(-20);
  });

  it('renvoie 0 quand les horloges concordent', () => {
    const t = new Date('2026-08-06T08:00:00.000Z');
    expect(clockSkewMinutes(t, t)).toBe(0);
  });
});
