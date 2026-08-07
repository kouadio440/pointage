import { describe, expect, it } from 'vitest';
import {
  getContext,
  isSystemContext,
  requireContext,
  runAsSystem,
  runWithContext,
  SYSTEM_COMPANY_ID,
  type RequestContext,
} from './tenant-context.js';

const CTX_A: RequestContext = {
  requestId: 'req_a',
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'HR',
  scope: 'COMPANY',
};

const CTX_B: RequestContext = {
  ...CTX_A,
  requestId: 'req_b',
  companyId: '33333333-3333-4333-8333-333333333333',
};

describe('propagation du contexte', () => {
  it("expose le contexte a l'interieur de runWithContext", () => {
    runWithContext(CTX_A, () => {
      expect(getContext()?.companyId).toBe(CTX_A.companyId);
    });
  });

  it('ne fuit pas le contexte hors de son execution', () => {
    runWithContext(CTX_A, () => undefined);
    expect(getContext()).toBeUndefined();
  });

  it('traverse les frontieres asynchrones', async () => {
    await runWithContext(CTX_A, async () => {
      await new Promise((r) => setTimeout(r, 5));
      // C'est toute la raison d'etre d'AsyncLocalStorage : sans lui, le
      // companyId serait perdu apres le premier await, et une requete
      // ulterieure partirait sans filtre tenant.
      expect(getContext()?.companyId).toBe(CTX_A.companyId);
    });
  });

  it('isole deux contextes concurrents', async () => {
    const [a, b] = await Promise.all([
      runWithContext(CTX_A, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getContext()?.companyId;
      }),
      runWithContext(CTX_B, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getContext()?.companyId;
      }),
    ]);

    // Deux requetes simultanees de deux entreprises differentes ne doivent
    // jamais se contaminer : c'est le scenario de fuite le plus realiste.
    expect(a).toBe(CTX_A.companyId);
    expect(b).toBe(CTX_B.companyId);
  });

  it('restitue le contexte parent apres une imbrication', () => {
    runWithContext(CTX_A, () => {
      runWithContext(CTX_B, () => {
        expect(getContext()?.companyId).toBe(CTX_B.companyId);
      });
      expect(getContext()?.companyId).toBe(CTX_A.companyId);
    });
  });
});

describe('requireContext - comportement fail-closed', () => {
  it('leve une exception hors contexte plutot que de renvoyer undefined', () => {
    // Renvoyer undefined conduirait a une requete SANS filtre tenant,
    // donc a servir les donnees de toutes les entreprises. On echoue bruyamment.
    expect(() => requireContext()).toThrow(/Contexte de requete absent/);
  });

  it('oriente le developpeur vers la bonne solution', () => {
    expect(() => requireContext()).toThrow(/runAsSystem/);
  });

  it('renvoie le contexte quand il existe', () => {
    runWithContext(CTX_A, () => {
      expect(requireContext().companyId).toBe(CTX_A.companyId);
    });
  });
});

describe('contexte systeme', () => {
  it('est reconnaissable explicitement', () => {
    runAsSystem('req_seed', () => {
      const ctx = requireContext();
      expect(isSystemContext(ctx)).toBe(true);
      expect(ctx.companyId).toBe(SYSTEM_COMPANY_ID);
    });
  });

  it('ne confond pas un contexte client avec un contexte systeme', () => {
    runWithContext(CTX_A, () => {
      expect(isSystemContext(requireContext())).toBe(false);
    });
  });

  it('doit etre demande explicitement : un oubli reste une erreur', () => {
    // Il n'existe aucun repli implicite vers le mode systeme. Un developpeur
    // qui oublie le contexte obtient une exception, pas un acces global.
    expect(() => requireContext()).toThrow();
  });
});
