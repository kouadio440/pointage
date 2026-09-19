-- =============================================================================
--  RETOUR ARRIERE DE LA MIGRATION 033 (paiement de production)
-- =============================================================================
--  Retablit le fonctionnement de la migration 031 : fonctions de paiement
--  appelables avec le jeton de l'acheteur, activation 031, lecture des
--  paiements par le proprietaire. Supprime les fonctions ajoutees par la 033
--  (serveur de paiement, test de production, limites, recus, historique).
--
--  AUCUNE DONNEE N'EST SUPPRIMEE : paiements, recus (et leurs fichiers),
--  compteurs, journal, anti-rejeu et etat du test de production restent en
--  place. Les protections des traces financieres sont CONSERVEES (journal en
--  ajout seul, recus immuables, ON DELETE RESTRICT) : elles n'empechent rien
--  au fonctionnement de la 031.
--
--  Genere par generer_033_retour.mjs (fonction 031 extraite du fichier 031).
-- =============================================================================

BEGIN;

-- Limites par formule
DROP TRIGGER IF EXISTS ad_limites_formule ON public.company_memberships;
DROP TRIGGER IF EXISTS ad_limites_formule ON public.geofences;
DROP FUNCTION IF EXISTS public.controler_limites_membres();
DROP FUNCTION IF EXISTS public.controler_limites_sites();
DROP FUNCTION IF EXISTS public.limites_entreprise(UUID);
DROP FUNCTION IF EXISTS public.usage_entreprise(UUID);

-- Serveur de paiement (v2), test de production, anti-rejeu
DROP FUNCTION IF EXISTS public.billing_prepare_checkout_v2(UUID, TEXT, TEXT, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS public.billing_payment_status_v2(UUID, TEXT);
DROP FUNCTION IF EXISTS public.billing_agir_pour(UUID);
DROP FUNCTION IF EXISTS public.billing_smoke_test_configure(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.billing_smoke_test_disable();
DROP FUNCTION IF EXISTS public.billing_smoke_test_state();
DROP FUNCTION IF EXISTS public.billing_webhook_register(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.billing_webhook_mark_processed(TEXT, TEXT);

-- Recus, historique, expiration, rapprochement
DROP FUNCTION IF EXISTS public.billing_history(UUID);
DROP FUNCTION IF EXISTS public.billing_expire_due();
DROP FUNCTION IF EXISTS public.billing_payments_a_reconcilier(INTEGER);
DROP FUNCTION IF EXISTS public.billing_receipts_a_traiter(INTEGER);
DROP FUNCTION IF EXISTS public.billing_receipt_json(UUID);
DROP FUNCTION IF EXISTS public.billing_receipt_set_pdf(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.billing_receipt_set_email(UUID, BOOLEAN, TEXT);
DROP POLICY IF EXISTS billing_receipts_lecture ON storage.objects;
DROP FUNCTION IF EXISTS public.uuid_ou_null(TEXT);

-- Activation : version 031 (9 parametres). La 033 emet un recu : sa version
-- est retiree avec billing_emettre_recu.
DROP FUNCTION IF EXISTS public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.billing_emettre_recu(UUID, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.billing_apply_provider_status(
    p_environment         TEXT,
    p_provider_payment_id TEXT,
    p_merchant_reference  TEXT,
    p_status              TEXT,
    p_payment_status      TEXT,
    p_amount              NUMERIC,
    p_paid_amount         NUMERIC,
    p_currency            TEXT,
    p_source              TEXT DEFAULT 'webhook'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_p          RECORD;
    v_c          RECORD;
    v_statut     TEXT := upper(btrim(COALESCE(p_status, '')));
    v_financier  TEXT := upper(btrim(COALESCE(p_payment_status, '')));
    v_paye       NUMERIC := COALESCE(p_paid_amount, p_amount);
    v_nouveau    TEXT;
    v_abo        RECORD;
    v_debut      TIMESTAMPTZ;
    v_fin        TIMESTAMPTZ;
    v_abo_id     UUID;
    v_max        INTEGER;
    v_ledger     UUID;
BEGIN
    SELECT * INTO v_p FROM public.billing_payments
     WHERE provider_payment_id = p_provider_payment_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'PAIEMENT_INCONNU');
    END IF;

    -- La reference Timora renvoyee par JoonaPay doit etre la notre.
    IF p_merchant_reference IS NOT NULL AND p_merchant_reference <> v_p.internal_reference THEN
        PERFORM public.billing_log('SUBSCRIPTION_ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'REFERENCE_INCOHERENTE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'REFERENCE_INCOHERENTE', 'reference', v_p.internal_reference);
    END IF;

    IF v_p.environment <> p_environment THEN
        PERFORM public.billing_log('SUBSCRIPTION_ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'ENVIRONNEMENT_INCOMPATIBLE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'ENVIRONNEMENT_INCOMPATIBLE', 'reference', v_p.internal_reference);
    END IF;

    UPDATE public.billing_payments
       SET provider_status = NULLIF(v_statut, ''), provider_payment_status = NULLIF(v_financier, ''),
           last_provider_check_at = NOW(), updated_at = NOW()
     WHERE id = v_p.id;

    -- Deja applique : rien a refaire.
    IF v_p.status = 'COMPLETED' THEN
        RETURN jsonb_build_object('ok', TRUE, 'status', 'COMPLETED', 'deja_traite', TRUE,
                                  'reference', v_p.internal_reference, 'company_id', v_p.company_id);
    END IF;

    v_nouveau := CASE
        WHEN v_statut = 'SUCCESS' AND v_financier = 'PAID'   THEN 'COMPLETED'
        WHEN v_statut = 'SUCCESS'                            THEN 'PROCESSING'
        WHEN v_statut = 'FAILED'                             THEN 'FAILED'
        WHEN v_statut = 'CANCELLED'                          THEN 'CANCELLED'
        WHEN v_statut = 'EXPIRED'                            THEN 'EXPIRED'
        WHEN v_statut = 'PENDING'                            THEN 'PROCESSING'
        WHEN v_statut = 'NEW'                                THEN v_p.status
        ELSE NULL   -- statut non documente : on ne devine rien
    END;

    IF v_nouveau IS NULL THEN
        PERFORM public.billing_log('JOONAPAY_PAYMENT_STATUS_CHECKED', p_environment, v_p.internal_reference,
            jsonb_build_object('status', v_statut, 'payment_status', v_financier, 'source', p_source,
                               'resultat', 'STATUT_INCONNU_IGNORE'));
        RETURN jsonb_build_object('ok', TRUE, 'status', v_p.status, 'reference', v_p.internal_reference,
                                  'company_id', v_p.company_id, 'ignore', TRUE);
    END IF;

    IF v_nouveau <> 'COMPLETED' THEN
        UPDATE public.billing_payments
           SET status = v_nouveau,
               failure_code = CASE WHEN v_nouveau IN ('FAILED', 'CANCELLED', 'EXPIRED')
                                   THEN COALESCE(failure_code, v_statut) ELSE failure_code END,
               updated_at = NOW()
         WHERE id = v_p.id;

        IF v_nouveau IN ('FAILED', 'CANCELLED', 'EXPIRED') THEN
            PERFORM public.billing_log('JOONAPAY_PAYMENT_FAILED', p_environment, v_p.internal_reference,
                jsonb_build_object('status', v_statut, 'payment_status', v_financier, 'source', p_source));
        ELSE
            PERFORM public.billing_log('JOONAPAY_PAYMENT_STATUS_CHECKED', p_environment, v_p.internal_reference,
                jsonb_build_object('status', v_statut, 'payment_status', v_financier, 'source', p_source));
        END IF;

        RETURN jsonb_build_object('ok', TRUE, 'status', v_nouveau, 'reference', v_p.internal_reference,
                                  'company_id', v_p.company_id);
    END IF;

    -- ---- Paiement annonce comme paye : controle strict avant activation ----
    IF upper(COALESCE(p_currency, '')) <> v_p.currency THEN
        UPDATE public.billing_payments SET status = 'PROCESSING', failure_code = 'DEVISE_INCORRECTE', updated_at = NOW()
         WHERE id = v_p.id;
        PERFORM public.billing_log('SUBSCRIPTION_ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'DEVISE_INCORRECTE', 'devise', p_currency, 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'DEVISE_INCORRECTE', 'reference', v_p.internal_reference);
    END IF;

    IF v_paye IS NULL OR v_paye <> v_p.amount THEN
        UPDATE public.billing_payments SET status = 'PROCESSING', failure_code = 'MONTANT_INCORRECT', updated_at = NOW()
         WHERE id = v_p.id;
        PERFORM public.billing_log('SUBSCRIPTION_ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'MONTANT_INCORRECT', 'attendu', v_p.amount, 'recu', v_paye, 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'MONTANT_INCORRECT', 'reference', v_p.internal_reference);
    END IF;

    SELECT id, billing_environment INTO v_c FROM public.companies WHERE id = v_p.company_id FOR UPDATE;
    IF v_c.billing_environment <> v_p.environment THEN
        PERFORM public.billing_log('SUBSCRIPTION_ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'ENVIRONNEMENT_INCOMPATIBLE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'ENVIRONNEMENT_INCOMPATIBLE', 'reference', v_p.internal_reference);
    END IF;

    -- ---- Activation : une periode, prolongee si l'abonnement court encore ----
    SELECT * INTO v_abo FROM public.company_subscriptions
     WHERE company_id = v_p.company_id AND status IN ('TRIAL', 'PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE')
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;

    v_debut := CASE
        WHEN v_abo.id IS NOT NULL AND v_abo.environment = v_p.environment AND v_abo.provider = 'JOONAPAY'
             AND v_abo.current_period_end IS NOT NULL AND v_abo.current_period_end > NOW()
        THEN v_abo.current_period_end
        ELSE NOW()
    END;
    v_fin := v_debut + CASE WHEN v_p.billing_period = 'ANNUAL' THEN INTERVAL '12 months' ELSE INTERVAL '1 month' END;

    -- Montant compte au chiffre d'affaires : jamais un paiement de test.
    IF v_abo.id IS NOT NULL THEN
        UPDATE public.company_subscriptions
           SET plan_code = v_p.plan_code,
               status = 'ACTIVE',
               billing_period = v_p.billing_period,
               amount_fcfa = CASE WHEN v_p.environment = 'production' THEN v_p.amount ELSE 0 END,
               environment = v_p.environment,
               provider = 'JOONAPAY',
               started_at = COALESCE(started_at, NOW()),
               current_period_start = CASE WHEN v_debut = NOW() THEN NOW() ELSE current_period_start END,
               current_period_end = v_fin,
               trial_ends_at = NULL,
               cancelled_at = NULL,
               last_payment_id = v_p.id,
               updated_at = NOW()
         WHERE id = v_abo.id
        RETURNING id INTO v_abo_id;
    ELSE
        INSERT INTO public.company_subscriptions (company_id, plan_code, status, billing_period, amount_fcfa,
                                                  environment, provider, started_at, current_period_start,
                                                  current_period_end, last_payment_id)
        VALUES (v_p.company_id, v_p.plan_code, 'ACTIVE', v_p.billing_period,
                CASE WHEN v_p.environment = 'production' THEN v_p.amount ELSE 0 END,
                v_p.environment, 'JOONAPAY', NOW(), NOW(), v_fin, v_p.id)
        RETURNING id INTO v_abo_id;
    END IF;

    SELECT max_employees INTO v_max FROM public.platform_plans WHERE code = v_p.plan_code;

    UPDATE public.companies
       SET status = 'active', plan = v_p.plan_code, max_employees = v_max, updated_at = NOW()
     WHERE id = v_p.company_id;

    -- Grand livre des encaissements (tableau de bord super admin) :
    -- production seulement.
    IF v_p.environment = 'production' THEN
        INSERT INTO public.platform_payments (company_id, method, status, amount_fcfa, external_ref, paid_at, notes)
        VALUES (v_p.company_id, 'OTHER', 'CONFIRMED', v_p.amount, v_p.internal_reference, NOW(),
                'JoonaPay ' || COALESCE(v_p.provider_reference, ''))
        RETURNING id INTO v_ledger;
    END IF;

    UPDATE public.billing_payments
       SET status = 'COMPLETED', completed_at = NOW(), confirmed_amount = v_paye::INTEGER,
           subscription_id = v_abo_id, failure_code = NULL, updated_at = NOW()
     WHERE id = v_p.id;

    PERFORM public.billing_log('JOONAPAY_PAYMENT_CONFIRMED', p_environment, v_p.internal_reference,
        jsonb_build_object('amount', v_p.amount, 'source', p_source));
    PERFORM public.billing_log('SUBSCRIPTION_ACTIVATED', p_environment, v_p.internal_reference,
        jsonb_build_object('plan', v_p.plan_code, 'period', v_p.billing_period, 'fin', v_fin));

    RETURN jsonb_build_object('ok', TRUE, 'status', 'COMPLETED', 'deja_traite', FALSE,
                              'reference', v_p.internal_reference, 'company_id', v_p.company_id,
                              'subscription', jsonb_build_object('status', 'ACTIVE', 'fin', v_fin,
                                                                 'plan', v_p.plan_code));
END;
$$;

REVOKE ALL ON FUNCTION public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) TO service_role;

-- La 031 n'ecrit pas normal_amount : la colonne redevient facultative.
ALTER TABLE public.billing_payments ALTER COLUMN normal_amount DROP NOT NULL;

-- Droits de la 031 : preparation et consultation avec le jeton de l'acheteur,
-- lecture des paiements par le proprietaire et les administrateurs.
GRANT EXECUTE ON FUNCTION public.billing_prepare_checkout(TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.billing_payment_status(TEXT) TO authenticated, service_role;
GRANT SELECT ON TABLE public.billing_payments TO authenticated;
DROP POLICY IF EXISTS billing_payments_lecture ON public.billing_payments;
CREATE POLICY billing_payments_lecture ON public.billing_payments
    FOR SELECT TO authenticated
    USING (public.can_configure_company(company_id) OR public.is_platform_admin());

NOTIFY pgrst, 'reload schema';

COMMIT;
