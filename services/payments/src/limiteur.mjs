// Limiteur de debit par cle (adresse IP, compte) : seau a jetons en memoire.
// Un seul processus sert payments.timora.tech ; la base applique en plus ses
// propres limites (6 paiements par entreprise et par 10 minutes).

export class Limiteur {
  /**
   * @param {number} capacite   requetes autorisees d'un coup
   * @param {number} parMinute  jetons rendus par minute
   */
  constructor({ capacite, parMinute, maxCles = 50000 }) {
    this.capacite = capacite;
    this.parMs = parMinute / 60000;
    this.maxCles = maxCles;
    this.seaux = new Map();
  }

  /** true si la requete passe, false si la limite est atteinte. */
  autoriser(cle, maintenant = Date.now()) {
    let s = this.seaux.get(cle);
    if (!s) {
      if (this.seaux.size >= this.maxCles) this.nettoyer(maintenant);
      s = { jetons: this.capacite, vu: maintenant };
      this.seaux.set(cle, s);
    }
    s.jetons = Math.min(this.capacite, s.jetons + (maintenant - s.vu) * this.parMs);
    s.vu = maintenant;
    if (s.jetons < 1) return false;
    s.jetons -= 1;
    return true;
  }

  /** Oublie les seaux pleins (inactifs) : la memoire reste bornee. */
  nettoyer(maintenant = Date.now()) {
    for (const [cle, s] of this.seaux) {
      if (s.jetons + (maintenant - s.vu) * this.parMs >= this.capacite) this.seaux.delete(cle);
    }
  }
}
