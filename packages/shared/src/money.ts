/**
 * Montants en franc CFA (XOF).
 *
 * Le prototype melangeait deux formats : "25.000 FCFA" en dur dans le HTML des
 * tarifs et "718 750 FCFA" via toLocaleString. On fige un format unique.
 *
 * Le XOF n'a pas de subdivision utilisee en pratique : tous les montants sont
 * des ENTIERS. On ne stocke donc jamais de flottant - c'est ce qui evite les
 * erreurs d'arrondi sur la facturation et le cout des retards.
 */

export const CURRENCY = 'XOF';
export const CURRENCY_LABEL = 'FCFA';

/**
 * Separateur de milliers : espace ASCII ordinaire (U+0020), volontairement.
 *
 * La typographie francaise voudrait une espace insecable etroite (U+202F), mais
 * ces montants finissent dans des exports Excel, des PDF et des SMS. U+202F y
 * casse le parsing numerique d'Excel et s'affiche en losange dans plusieurs
 * lecteurs PDF. Un espace ordinaire traverse tous ces canaux sans dommage ;
 * le retour a la ligne au milieu d'un nombre se corrige en CSS (white-space: nowrap),
 * ce qui est un probleme d'affichage, pas un probleme de donnees.
 */
const THIN_SPACE = ' ';

/**
 * "25 000 FCFA". Le montant doit etre un entier de francs.
 */
export function formatFcfa(amount: number, options?: { withLabel?: boolean }): string {
  const withLabel = options?.withLabel ?? true;
  const rounded = Math.round(amount);
  const grouped = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  const sign = rounded < 0 ? '-' : '';
  return withLabel ? `${sign}${grouped}${THIN_SPACE}${CURRENCY_LABEL}` : `${sign}${grouped}`;
}

/** Version compacte pour les tuiles de KPI : "1,2 M FCFA", "450 k FCFA". */
export function formatFcfaCompact(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) {
    const value = (abs / 1_000_000).toFixed(1).replace('.', ',');
    return `${sign}${value}${THIN_SPACE}M${THIN_SPACE}${CURRENCY_LABEL}`;
  }
  if (abs >= 1_000) {
    return `${sign}${Math.round(abs / 1000)}${THIN_SPACE}k${THIN_SPACE}${CURRENCY_LABEL}`;
  }
  return formatFcfa(amount);
}

/**
 * Cout d'un temps de travail perdu (retard, absence).
 *
 * Base sur le salaire mensuel brut et le volume horaire mensuel contractuel.
 * On arrondit au franc : c'est un montant destine a un rapport de direction,
 * pas a un bulletin de paie.
 */
export function costOfMinutes(
  minutes: number,
  monthlySalary: number,
  monthlyHours = 173.33,
): number {
  if (monthlyHours <= 0) return 0;
  const hourlyRate = monthlySalary / monthlyHours;
  return Math.round((minutes / 60) * hourlyRate);
}

/** Conversion vers l'entier stocke en base. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount);
}
