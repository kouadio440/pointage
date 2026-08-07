import { describe, expect, it } from 'vitest';
import {
  companyCodeSchema,
  companySignupSchema,
  createPunchSchema,
  dateRangeSchema,
  emailSchema,
  employeeLoginSchema,
  hourMinuteSchema,
  manualPunchSchema,
  matriculeSchema,
  paginationSchema,
  passwordSchema,
  phoneSchema,
} from './schemas.js';

const UUID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b';

describe('companyCodeSchema', () => {
  it.each(['WDS-4821', 'abc-0001'])('accepte %s', (v) => {
    expect(companyCodeSchema.parse(v)).toBe(v.toUpperCase());
  });

  it.each(['WDS4821', 'WD-4821', 'WDSX-4821', 'WDS-482', 'WDS-48210', ''])('refuse %s', (v) => {
    expect(companyCodeSchema.safeParse(v).success).toBe(false);
  });

  it('normalise la casse et les espaces', () => {
    expect(companyCodeSchema.parse('  wds-4821  ')).toBe('WDS-4821');
  });
});

describe('phoneSchema', () => {
  it.each([
    '+2250700000000', // Cote d'Ivoire
    '+221771234567', // Senegal
    '+237690000000', // Cameroun
    '+22670000000', // Burkina Faso
  ])('accepte %s', (v) => {
    expect(phoneSchema.safeParse(v).success).toBe(true);
  });

  it.each(['0700000000', '+0700000000', '225 07 00 00 00 00', '+225', 'abc'])('refuse %s', (v) => {
    expect(phoneSchema.safeParse(v).success).toBe(false);
  });
});

describe('emailSchema', () => {
  it('normalise en minuscules', () => {
    expect(emailSchema.parse('  RH@Entreprise.CI ')).toBe('rh@entreprise.ci');
  });

  it.each(['pas-un-email', '@entreprise.ci', 'rh@', ''])('refuse %s', (v) => {
    expect(emailSchema.safeParse(v).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('exige au moins 12 caracteres', () => {
    expect(passwordSchema.safeParse('court').success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });

  it("n'impose pas de composition exotique : une phrase de passe est valide", () => {
    expect(passwordSchema.safeParse('mon chien mange trois mangues').success).toBe(true);
  });

  it('borne la longueur pour eviter un deni de service sur le hachage argon2', () => {
    expect(passwordSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});

describe('matriculeSchema', () => {
  it.each(['EMP-001', 'wd.042', 'A1'])('accepte %s', (v) => {
    expect(matriculeSchema.safeParse(v).success).toBe(true);
  });

  it.each(['E', 'EMP 001', 'EMP_001', 'EMP@1'])('refuse %s', (v) => {
    expect(matriculeSchema.safeParse(v).success).toBe(false);
  });
});

describe('hourMinuteSchema', () => {
  it.each(['00:00', '08:00', '23:59'])('accepte %s', (v) => {
    expect(hourMinuteSchema.safeParse(v).success).toBe(true);
  });

  it.each(['24:00', '8:00', '08:60', '08h00'])('refuse %s', (v) => {
    expect(hourMinuteSchema.safeParse(v).success).toBe(false);
  });
});

describe('employeeLoginSchema', () => {
  const valide = { companyCode: 'WDS-4821', matricule: 'EMP-001', password: 'motdepasse12' };

  it('accepte une connexion par code entreprise et matricule', () => {
    expect(employeeLoginSchema.safeParse(valide).success).toBe(true);
  });

  it('rejette toute cle inconnue au lieu de la retirer silencieusement', () => {
    const r = employeeLoginSchema.safeParse({ ...valide, role: 'SUPER_ADMIN' });
    expect(r.success).toBe(false);
  });

  it('exige les trois champs', () => {
    expect(employeeLoginSchema.safeParse({ companyCode: 'WDS-4821' }).success).toBe(false);
  });
});

describe('companySignupSchema', () => {
  const valide = {
    companyName: 'Winner Digital SARL',
    sector: 'Packaging personnalise',
    country: 'CI',
    city: 'Abidjan',
    timezone: 'Africa/Abidjan',
    ceoFirstName: 'Marc',
    ceoLastName: 'Kouassi',
    ceoEmail: 'marc@winnerdigital.ci',
    ceoPhone: '+2250700000000',
    password: 'motdepassesolide',
    planCode: 'BUSINESS',
    billingPeriod: 'ANNUAL',
    acceptTerms: true,
  };

  it('accepte une inscription complete', () => {
    expect(companySignupSchema.safeParse(valide).success).toBe(true);
  });

  it("exige l'acceptation explicite des conditions", () => {
    expect(companySignupSchema.safeParse({ ...valide, acceptTerms: false }).success).toBe(false);
  });

  it('applique Africa/Abidjan par defaut', () => {
    const { timezone, ...sansFuseau } = valide;
    const r = companySignupSchema.parse(sansFuseau);
    expect(r.timezone).toBe('Africa/Abidjan');
  });

  it('refuse un plan inconnu', () => {
    expect(companySignupSchema.safeParse({ ...valide, planCode: 'GRATUIT' }).success).toBe(false);
  });

  it('refuse une cle injectee comme companyId ou role', () => {
    expect(companySignupSchema.safeParse({ ...valide, companyId: UUID }).success).toBe(false);
  });
});

describe('createPunchSchema', () => {
  const valide = {
    type: 'IN',
    method: 'GPS_SELFIE',
    latitude: 5.359942,
    longitude: -4.008311,
    accuracyM: 12,
    clientTime: '2026-08-06T08:02:14.000Z',
    deviceFingerprint: 'fp_a1b2c3d4e5',
  };

  it('accepte un pointage web sans signaux natifs', () => {
    const r = createPunchSchema.safeParse(valide);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.nativeSignals).toBeUndefined();
  });

  it('accepte les signaux natifs quand la coque Capacitor les fournit', () => {
    const r = createPunchSchema.safeParse({
      ...valide,
      nativeSignals: { mockLocation: false, rooted: false, beaconIds: ['b1', 'b2'] },
    });
    expect(r.success).toBe(true);
  });

  it('refuse des coordonnees hors bornes', () => {
    expect(createPunchSchema.safeParse({ ...valide, latitude: 91 }).success).toBe(false);
    expect(createPunchSchema.safeParse({ ...valide, longitude: -181 }).success).toBe(false);
  });

  it("refuse une empreinte d'appareil absente : elle sert a lier le pointage", () => {
    const { deviceFingerprint, ...sansEmpreinte } = valide;
    expect(createPunchSchema.safeParse(sansEmpreinte).success).toBe(false);
  });

  it('refuse une date client mal formee', () => {
    expect(createPunchSchema.safeParse({ ...valide, clientTime: '06/08/2026' }).success).toBe(
      false,
    );
  });

  it("refuse un champ 'decision' ou 'fraudScore' injecte par le client", () => {
    // Le client ne decide jamais du verdict : ces champs n'existent pas en entree.
    expect(createPunchSchema.safeParse({ ...valide, decision: 'ACCEPTED' }).success).toBe(false);
    expect(createPunchSchema.safeParse({ ...valide, fraudScore: 0 }).success).toBe(false);
  });

  it("refuse un champ 'employeeId' : l'employe est deduit du jeton, jamais du corps", () => {
    expect(createPunchSchema.safeParse({ ...valide, employeeId: UUID }).success).toBe(false);
  });
});

describe('manualPunchSchema', () => {
  const valide = {
    employeeId: UUID,
    type: 'IN',
    occurredAt: '2026-08-06T08:00:00.000Z',
    siteId: UUID,
    reason: 'Oubli de pointage confirme par le chef d atelier',
  };

  it('accepte une saisie RH justifiee', () => {
    expect(manualPunchSchema.safeParse(valide).success).toBe(true);
  });

  it('refuse une saisie sans motif suffisant : elle ne serait pas auditable', () => {
    expect(manualPunchSchema.safeParse({ ...valide, reason: 'oubli' }).success).toBe(false);
    const { reason, ...sansMotif } = valide;
    expect(manualPunchSchema.safeParse(sansMotif).success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('applique une taille par defaut', () => {
    expect(paginationSchema.parse({}).take).toBe(50);
  });

  it('plafonne la taille de page a 200', () => {
    expect(paginationSchema.safeParse({ take: 201 }).success).toBe(false);
    expect(paginationSchema.parse({ take: 200 }).take).toBe(200);
  });

  it('convertit une taille passee en chaine de requete', () => {
    expect(paginationSchema.parse({ take: '25' }).take).toBe(25);
  });
});

describe('dateRangeSchema', () => {
  it('accepte une periode valide', () => {
    expect(dateRangeSchema.safeParse({ from: '2026-08-01', to: '2026-08-31' }).success).toBe(true);
  });

  it('refuse une periode inversee', () => {
    expect(dateRangeSchema.safeParse({ from: '2026-08-31', to: '2026-08-01' }).success).toBe(false);
  });

  it('refuse une periode de plus de 366 jours', () => {
    expect(dateRangeSchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(false);
  });

  it('accepte une annee bissextile complete', () => {
    expect(dateRangeSchema.safeParse({ from: '2024-01-01', to: '2024-12-31' }).success).toBe(true);
  });
});
