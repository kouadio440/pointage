-- =============================================================================
--  MIGRATION 018 — Edition d'un abonnement depuis le tableau de bord
-- =============================================================================
--
--  La migration 017 laisse `company_subscriptions` avec RLS active et AUCUNE
--  politique : la table est donc invisible et non modifiable depuis le
--  navigateur, y compris pour un super admin. C'est voulu — mais il manquait
--  alors le seul chemin d'ecriture legitime.
--
--  Sans cette fonction, le tarif negocie d'une entreprise et la periodicite
--  de son abonnement ne pouvaient etre saisis qu'en SQL, et le MRR serait
--  reste a zero pour tout client hors grille tarifaire.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.platform_set_subscription(
    p_company  UUID,
    p_plan     TEXT        DEFAULT NULL,
    p_period   TEXT        DEFAULT NULL,
    p_amount   INTEGER     DEFAULT NULL,
    p_status   TEXT        DEFAULT NULL,
    p_end      TIMESTAMPTZ DEFAULT NULL,
    -- Un tarif negocie s'efface en passant ce drapeau : sans lui, `p_amount`
    -- a NULL serait indistinguable de « ne touche pas au montant ».
    p_clear_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id     UUID;
    v_statut TEXT := upper(NULLIF(btrim(COALESCE(p_status, '')), ''));
    v_per    TEXT := upper(NULLIF(btrim(COALESCE(p_period, '')), ''));
    v_plan   TEXT := lower(NULLIF(btrim(COALESCE(p_plan,   '')), ''));
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    IF v_statut IS NOT NULL AND v_statut NOT IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED') THEN
        RAISE EXCEPTION 'Statut d''abonnement invalide : %', p_status;
    END IF;

    IF v_per IS NOT NULL AND v_per NOT IN ('MONTHLY','ANNUAL') THEN
        RAISE EXCEPTION 'Periodicite invalide : % (attendu MONTHLY ou ANNUAL)', p_period;
    END IF;

    IF p_amount IS NOT NULL AND p_amount < 0 THEN
        RAISE EXCEPTION 'Le montant ne peut pas etre negatif.';
    END IF;

    IF v_plan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_plans WHERE code = v_plan) THEN
        RAISE EXCEPTION 'Plan inconnu : %', p_plan;
    END IF;

    SELECT id INTO v_id
      FROM public.company_subscriptions
     WHERE company_id = p_company
       AND status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED')
     ORDER BY created_at DESC
     LIMIT 1;

    IF v_id IS NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company) THEN
            RAISE EXCEPTION 'Entreprise inconnue.';
        END IF;

        INSERT INTO public.company_subscriptions
               (company_id, plan_code, status, billing_period, amount_fcfa, started_at, current_period_end)
        VALUES (p_company, v_plan,
                COALESCE(v_statut, 'ACTIVE'),
                COALESCE(v_per, 'MONTHLY'),
                CASE WHEN p_clear_amount THEN NULL ELSE p_amount END,
                NOW(), p_end)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.company_subscriptions
           SET plan_code          = COALESCE(v_plan,   plan_code),
               status             = COALESCE(v_statut, status),
               billing_period     = COALESCE(v_per,    billing_period),
               amount_fcfa        = CASE WHEN p_clear_amount THEN NULL
                                         ELSE COALESCE(p_amount, amount_fcfa) END,
               current_period_end = COALESCE(p_end, current_period_end),
               cancelled_at       = CASE WHEN v_statut = 'CANCELLED' THEN NOW() ELSE cancelled_at END,
               updated_at         = NOW()
         WHERE id = v_id;
    END IF;

    -- Le plan affiche sur la fiche entreprise doit suivre l'abonnement, sinon
    -- `companies.plan` et l'abonnement racontent deux histoires differentes.
    IF v_plan IS NOT NULL THEN
        UPDATE public.companies SET plan = v_plan, updated_at = NOW() WHERE id = p_company;
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'abonnement_id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_set_subscription(
    UUID, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, BOOLEAN) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
