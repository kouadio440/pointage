/**
 * Temps officiel de la plateforme : Africa/Abidjan.
 *
 * Le prototype dupliquait ces options dans app.js (l. 153 et l. 567) et
 * codait ~30 heures en dur dans le HTML. Tout passe desormais par ici.
 *
 * Abidjan est en UTC+0 toute l'annee, sans heure d'ete - ce qui evite la
 * classe de bugs la plus penible sur un produit de pointage. Le fuseau reste
 * neanmoins configurable par entreprise (module 2 du cahier des charges) :
 * ces fonctions acceptent donc un fuseau explicite, avec Abidjan par defaut.
 */

export const DEFAULT_TIMEZONE = 'Africa/Abidjan';

const LOCALE = 'fr-FR';

/** "08:02:14" */
export function formatTime(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleTimeString(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** "08:02" - format retenu pour les heures d'arrivee et de depart. */
export function formatHourMinute(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleTimeString(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "06/08/2026" */
export function formatDate(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleDateString(LOCALE, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** "06/08/2026 a 08:02" */
export function formatDateTime(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return `${formatDate(date, timeZone)} a ${formatHourMinute(date, timeZone)}`;
}

/** "08:02:14 GMT (Abidjan)" - format de la barre superieure du site vitrine. */
export function formatClock(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const city = timeZone.split('/')[1]?.replace(/_/g, ' ') ?? timeZone;
  return `${formatTime(date, timeZone)} GMT (${city})`;
}

/**
 * Date metier au format ISO court "2026-08-06", exprimee dans le fuseau donne.
 *
 * C'est la CLE de la table WorkDay. Elle doit etre derivee du fuseau de
 * l'entreprise et jamais de celui du serveur : un pointage a 23h30 a Abidjan
 * appartient au 6 aout, meme si le serveur est deja au 7 en UTC+2.
 */
export function businessDate(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  // en-CA produit nativement le format ISO yyyy-mm-dd.
  return date.toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** "08:00" -> 480. Renvoie null si le format est invalide. */
export function parseHourMinute(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 480 -> "08:00". Gere le passage minuit pour le travail de nuit. */
export function minutesToHourMinute(minutes: number): string {
  const norm = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Duree en minutes entre deux heures de la journee, en gerant le passage
 * par minuit (equipe de nuit : 22:00 -> 06:00 = 480 minutes, pas -960).
 */
export function durationMinutes(startMinutes: number, endMinutes: number): number {
  const d = endMinutes - startMinutes;
  return d >= 0 ? d : d + 1440;
}

/** "7 h 30" - format d'affichage des durees travaillees. */
export function formatDuration(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m} min`;
  if (m === 0) return `${sign}${h} h`;
  return `${sign}${h} h ${String(m).padStart(2, '0')}`;
}

/**
 * Ecart entre l'horloge du client et celle du serveur, en minutes.
 * Signal de fraude : une horloge reculee permet d'antidater un pointage.
 */
export function clockSkewMinutes(clientTime: Date, serverTime: Date): number {
  return Math.round((clientTime.getTime() - serverTime.getTime()) / 60_000);
}

/** Au-dela de cet ecart, le pointage est marque comme suspect. */
export const MAX_CLOCK_SKEW_MINUTES = 15;
