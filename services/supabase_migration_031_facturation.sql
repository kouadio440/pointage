-- =============================================================================
--  MIGRATION 031 — ABONNEMENT PAYANT AVANT TOUTE UTILISATION REELLE
-- =============================================================================
--
--  NOUVEAU MODELE
--  --------------
--      demonstration gratuite -> abonnement -> paiement JoonaPay
--      -> confirmation SERVEUR -> entreprise activee -> premier pointage
--
--  Plus aucun essai gratuit reel : une entreprise creee apres cette migration
--  est « pending_payment ». Tant que son abonnement n'est pas ACTIVE, le
--  serveur refuse pointage, reconnaissance faciale, borne QR, zones GPS,
--  horaires et adhesion de collaborateurs — pas seulement l'interface.
--
--  CE QUI EST POSE ICI
--  -------------------
--   1. Les tarifs en base (platform_plans) : SEULE source de verite des prix,
--      lue par la page d'accueil, le recapitulatif et le serveur de paiement.
--   2. Le mode de facturation (sandbox / production) et l'environnement de
--      chaque entreprise : un paiement de test n'active JAMAIS une entreprise
--      reelle, et inversement.
--   3. billing_payments : chaque intention de paiement, sa reference Timora,
--      son identifiant JoonaPay, son etat (PENDING, PROCESSING, COMPLETED,
--      FAILED, CANCELLED, EXPIRED).
--   4. billing_events : le journal des etapes (jamais un secret, jamais une
--      cle, jamais une signature).
--   5. Les fonctions serveur : preparer un paiement (prix calcule ICI, jamais
--      recu du navigateur), rattacher le checkout JoonaPay, appliquer un etat
--      confirme par JoonaPay — atomique et idempotent —, consulter un paiement.
--   6. Le verrou « abonnement actif » sur toutes les fonctions payantes.
--   7. La resolution d'authentification oriente vers l'activation quand
--      l'abonnement manque ou a expire.
--
--  ENTREPRISES EXISTANTES
--  ----------------------
--  Les entreprises presentes avant cette migration sont marquees
--  `billing_legacy` : elles restent actives, sans rien perdre. Leurs
--  abonnements herites sont comptes a 0 FCFA de revenu — ils n'ont jamais
--  ete factures, et le tarif « pro » desormais connu ne doit pas fabriquer un
--  chiffre d'affaires qui n'existe pas.
--
--  CORRECTION AU PASSAGE
--  ---------------------
--  record_attendance, enroll_face et issue_face_challenge avaient ete
--  installees avec un mauvais encodage : leurs accents s'affichaient en
--  caracteres de remplacement (losanges) dans l'application. Elles sont
--  reinstallees depuis leurs fichiers sources (migrations 009, 010, 016), en UTF-8 correct.
--
--  get_employee_punch_config levait « malformed array literal » pour TOUT
--  employe a qui il manquait un reglage (site, compte actif...) : l'ecran de
--  pointage recevait une erreur au lieu de la liste de ce qui manque.
--  `v_missing || 'texte'` devient `array_append(v_missing, 'texte')`.
--
--  RETOUR ARRIERE
--  --------------
--  Voir services/supabase_migration_031_facturation_retour.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. MODE DE FACTURATION DE LA PLATEFORME
-- -----------------------------------------------------------------------------
--  Une seule ligne. « sandbox » tant que les paiements de production ne sont
--  pas ouverts : les entreprises creees pendant cette periode sont des
--  entreprises de TEST, activables par des paiements de test seulement.
--
--  Un paiement de test ne coute rien : ouvert a tous, il permettrait
--  d'utiliser reellement Timora sans payer. En mode sandbox, seuls les
--  administrateurs de la plateforme et les adresses de `testeurs_sandbox`
--  peuvent donc lancer un paiement. Ajouter un testeur :
--    UPDATE public.billing_settings
--       SET testeurs_sandbox = array_append(testeurs_sandbox, 'testeur@exemple.ci');

CREATE TABLE IF NOT EXISTS public.billing_settings (
    id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    mode             TEXT NOT NULL CHECK (mode IN ('sandbox', 'production')),
    testeurs_sandbox TEXT[] NOT NULL DEFAULT '{}',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.billing_settings ADD COLUMN IF NOT EXISTS testeurs_sandbox TEXT[] NOT NULL DEFAULT '{}';

INSERT INTO public.billing_settings (id, mode) VALUES (TRUE, 'sandbox')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.billing_mode()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE((SELECT mode FROM public.billing_settings WHERE id), 'sandbox');
$$;

REVOKE ALL ON FUNCTION public.billing_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_mode() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. ENTREPRISES : ENVIRONNEMENT DE FACTURATION, ENTREPRISES HERITEES
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'companies'
                      AND column_name = 'billing_legacy') THEN
        ALTER TABLE public.companies ADD COLUMN billing_legacy BOOLEAN NOT NULL DEFAULT FALSE;
        -- Calcule UNE SEULE FOIS : toutes les entreprises deja creees sont
        -- heritees. Une relance de la migration ne marquera pas celles creees
        -- depuis.
        UPDATE public.companies SET billing_legacy = TRUE;
    END IF;
END;
$$;

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS billing_environment TEXT NOT NULL DEFAULT 'production';

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_billing_environment_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_billing_environment_check
    CHECK (billing_environment IN ('sandbox', 'production'));

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_status_check
    CHECK (status IS NULL OR status IN ('active', 'pending_payment', 'trial', 'suspended', 'expired', 'cancelled'));

-- Une entreprise creee sans passer par create_company() ne doit pas naitre
-- active avec un plan qu'elle n'a pas paye.
ALTER TABLE public.companies ALTER COLUMN status SET DEFAULT 'pending_payment';
ALTER TABLE public.companies ALTER COLUMN plan DROP DEFAULT;

-- -----------------------------------------------------------------------------
-- 3. TARIFS : LA SOURCE DE VERITE
-- -----------------------------------------------------------------------------
--  Les montants ne vivent QU'ICI. Le navigateur les lit pour les afficher ; le
--  serveur de paiement les relit pour facturer. Un montant modifie dans le
--  navigateur ne change donc rien a ce qui est demande a JoonaPay.
--
--  Les prix deja saisis par le super admin ne sont jamais ecrases : seules
--  les valeurs absentes sont completees.

ALTER TABLE public.platform_plans ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'XOF';
ALTER TABLE public.platform_plans ADD COLUMN IF NOT EXISTS self_serve BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.platform_plans DROP CONSTRAINT IF EXISTS platform_plans_currency_check;
ALTER TABLE public.platform_plans ADD CONSTRAINT platform_plans_currency_check CHECK (currency = 'XOF');

INSERT INTO public.platform_plans (code, name, monthly_price_fcfa, annual_price_fcfa, max_employees,
                                   is_active, sort_order, currency, self_serve)
VALUES ('essentiel',  'Essentiel',  15000, 150000, 10,   TRUE, 10, 'XOF', TRUE),
       ('business',   'Business',   35000, 350000, 30,   TRUE, 20, 'XOF', TRUE),
       ('pro',        'Pro',        75000, 750000, 100,  TRUE, 30, 'XOF', TRUE),
       ('entreprise', 'Entreprise', NULL,  NULL,   NULL, TRUE, 40, 'XOF', FALSE)
ON CONFLICT (code) DO UPDATE SET
    name               = COALESCE(NULLIF(public.platform_plans.name, initcap(public.platform_plans.code)), EXCLUDED.name),
    monthly_price_fcfa = COALESCE(public.platform_plans.monthly_price_fcfa, EXCLUDED.monthly_price_fcfa),
    annual_price_fcfa  = COALESCE(public.platform_plans.annual_price_fcfa,  EXCLUDED.annual_price_fcfa),
    max_employees      = COALESCE(public.platform_plans.max_employees,      EXCLUDED.max_employees),
    sort_order         = EXCLUDED.sort_order,
    self_serve         = EXCLUDED.self_serve,
    updated_at         = NOW();

/** Tarifs publics, pour la page d'accueil et le recapitulatif (aucun secret). */
CREATE OR REPLACE FUNCTION public.billing_plans_public()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'code',          p.code,
               'name',          p.name,
               'monthly_price', p.monthly_price_fcfa,
               'annual_price',  p.annual_price_fcfa,
               'currency',      p.currency,
               'max_employees', p.max_employees,
               'self_serve',    p.self_serve AND p.monthly_price_fcfa IS NOT NULL
           ) ORDER BY p.sort_order, p.code), '[]'::JSONB)
      FROM public.platform_plans p
     WHERE p.is_active
       AND p.code IN ('essentiel', 'business', 'pro', 'entreprise');
$$;

REVOKE ALL ON FUNCTION public.billing_plans_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_plans_public() TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. ABONNEMENTS : ENVIRONNEMENT, PERIODE, NOUVEAUX STATUTS
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_nom TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'company_subscriptions'
                      AND column_name = 'provider') THEN
        ALTER TABLE public.company_subscriptions ADD COLUMN provider TEXT;
        -- Abonnements herites : jamais factures, comptes a 0 FCFA.
        UPDATE public.company_subscriptions
           SET provider = 'LEGACY', amount_fcfa = COALESCE(amount_fcfa, 0);
    END IF;

    -- Le nom de la contrainte de statut a ete genere par PostgreSQL : on la
    -- retrouve plutot que de supposer son nom.
    FOR v_nom IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.company_subscriptions'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE public.company_subscriptions DROP CONSTRAINT %I', v_nom);
    END LOOP;
END;
$$;

ALTER TABLE public.company_subscriptions ADD CONSTRAINT company_subscriptions_status_check
    CHECK (status IN ('TRIAL', 'PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'SUSPENDED', 'CANCELLED'));

ALTER TABLE public.company_subscriptions
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production';
ALTER TABLE public.company_subscriptions DROP CONSTRAINT IF EXISTS company_subscriptions_environment_check;
ALTER TABLE public.company_subscriptions ADD CONSTRAINT company_subscriptions_environment_check
    CHECK (environment IN ('sandbox', 'production'));
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ;
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS last_payment_id UUID;

-- -----------------------------------------------------------------------------
-- 5. PAIEMENTS EN LIGNE ET JOURNAL
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_payments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id                 UUID REFERENCES public.users(id) ON DELETE SET NULL,
    provider                TEXT NOT NULL DEFAULT 'JOONAPAY' CHECK (provider = 'JOONAPAY'),
    environment             TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    plan_code               TEXT NOT NULL REFERENCES public.platform_plans(code),
    billing_period          TEXT NOT NULL CHECK (billing_period IN ('MONTHLY', 'ANNUAL')),
    amount                  INTEGER NOT NULL CHECK (amount >= 100),
    currency                TEXT NOT NULL DEFAULT 'XOF' CHECK (currency = 'XOF'),
    internal_reference      TEXT NOT NULL UNIQUE,
    provider_payment_id     TEXT UNIQUE,
    provider_reference      TEXT,
    checkout_url            TEXT,
    status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
    provider_status         TEXT,
    provider_payment_status TEXT,
    confirmed_amount        INTEGER,
    failure_code            TEXT,
    subscription_id         UUID REFERENCES public.company_subscriptions(id) ON DELETE SET NULL,
    last_provider_check_at  TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS billing_payments_company_idx ON public.billing_payments (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_payments_status_idx  ON public.billing_payments (status) WHERE status IN ('PENDING', 'PROCESSING');

ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_payments FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.billing_payments FROM authenticated;

DROP POLICY IF EXISTS billing_payments_lecture ON public.billing_payments;
CREATE POLICY billing_payments_lecture ON public.billing_payments
    FOR SELECT TO authenticated
    USING (public.can_configure_company(company_id) OR public.is_platform_admin());

CREATE TABLE IF NOT EXISTS public.billing_events (
    id                  BIGSERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event               TEXT NOT NULL CHECK (event IN (
                            'JOONAPAY_PAYMENT_CREATE_STARTED', 'JOONAPAY_PAYMENT_CREATED',
                            'JOONAPAY_PAYMENT_CREATE_FAILED', 'JOONAPAY_PAYMENT_STATUS_CHECKED',
                            'JOONAPAY_WEBHOOK_RECEIVED', 'JOONAPAY_WEBHOOK_VERIFIED',
                            'JOONAPAY_WEBHOOK_INVALID_SIGNATURE', 'JOONAPAY_WEBHOOK_UNKNOWN_EVENT',
                            'JOONAPAY_PAYMENT_CONFIRMED', 'JOONAPAY_PAYMENT_FAILED',
                            'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_ACTIVATION_FAILED')),
    environment         TEXT,
    payment_id          UUID,
    internal_reference  TEXT,
    company_id          UUID,
    detail              JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS billing_events_date_idx     ON public.billing_events (created_at DESC);
CREATE INDEX IF NOT EXISTS billing_events_reference_idx ON public.billing_events (internal_reference);

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_events FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS billing_events_lecture_plateforme ON public.billing_events;
CREATE POLICY billing_events_lecture_plateforme ON public.billing_events
    FOR SELECT TO authenticated USING (public.is_platform_admin());
GRANT SELECT ON TABLE public.billing_events TO authenticated;

/**
 * Journal de facturation. Le serveur y depose des faits, jamais un secret :
 * toute cle dont le nom evoque un secret est retiree par securite, meme si le
 * serveur ne devrait jamais en envoyer.
 */
CREATE OR REPLACE FUNCTION public.billing_log(
    p_event       TEXT,
    p_environment TEXT DEFAULT NULL,
    p_reference   TEXT DEFAULT NULL,
    p_detail      JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_paiement RECORD;
    v_detail   JSONB := '{}'::JSONB;
    v_cle      TEXT;
BEGIN
    IF p_detail IS NOT NULL AND jsonb_typeof(p_detail) = 'object' THEN
        FOR v_cle IN SELECT jsonb_object_keys(p_detail) LOOP
            IF v_cle !~* '(key|secret|token|signature|authorization|password|cookie)' THEN
                v_detail := v_detail || jsonb_build_object(v_cle, p_detail -> v_cle);
            END IF;
        END LOOP;
    END IF;

    SELECT id, company_id INTO v_paiement
      FROM public.billing_payments WHERE internal_reference = p_reference;

    INSERT INTO public.billing_events (event, environment, payment_id, internal_reference, company_id, detail)
    VALUES (p_event, p_environment, v_paiement.id, p_reference, v_paiement.company_id, v_detail);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_log(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_log(TEXT, TEXT, TEXT, JSONB) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. ETAT D'ABONNEMENT : LA SEULE REGLE « L'ENTREPRISE PEUT-ELLE TRAVAILLER ? »
-- -----------------------------------------------------------------------------
--   ACTIVE           entreprise heritee, ou abonnement actif dans la periode
--   PENDING_PAYMENT  jamais payee
--   EXPIRED          periode payee terminee (donnees conservees)
--   SUSPENDED        suspendue par la plateforme
--
--  L'abonnement doit appartenir au MEME environnement que l'entreprise : un
--  abonnement active par un paiement de test n'ouvre jamais une entreprise
--  reelle.

CREATE OR REPLACE FUNCTION public.etat_abonnement_entreprise(p_company UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_c  RECORD;
    v_s  RECORD;
    v_etat TEXT;
BEGIN
    SELECT id, lower(COALESCE(status, 'active')) AS status, plan, billing_environment, billing_legacy
      INTO v_c
      FROM public.companies WHERE id = p_company;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT s.status, s.plan_code, s.billing_period, s.current_period_start, s.current_period_end, s.provider
      INTO v_s
      FROM public.company_subscriptions s
     WHERE s.company_id = p_company
       AND s.environment = v_c.billing_environment
       AND s.status IN ('ACTIVE', 'PAST_DUE', 'EXPIRED')
     ORDER BY (s.status = 'ACTIVE') DESC, s.current_period_end DESC NULLS FIRST, s.updated_at DESC
     LIMIT 1;

    IF v_c.status IN ('suspended', 'cancelled') THEN
        v_etat := 'SUSPENDED';
    ELSIF v_c.billing_legacy AND v_c.status = 'active' THEN
        v_etat := 'ACTIVE';
    ELSIF v_s.status = 'ACTIVE' AND v_c.status = 'active'
          AND (v_s.current_period_end IS NULL OR v_s.current_period_end > NOW()) THEN
        v_etat := 'ACTIVE';
    ELSIF v_s.status IS NOT NULL THEN
        v_etat := 'EXPIRED';
    ELSE
        v_etat := 'PENDING_PAYMENT';
    END IF;

    RETURN jsonb_build_object(
        'etat',          v_etat,
        'plan',          COALESCE(v_s.plan_code, v_c.plan),
        'periode',       v_s.billing_period,
        'debut',         v_s.current_period_start,
        'fin',           v_s.current_period_end,
        'environnement', v_c.billing_environment,
        'heritee',       v_c.billing_legacy
    );
END;
$$;

REVOKE ALL ON FUNCTION public.etat_abonnement_entreprise(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.etat_abonnement_entreprise(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.entreprise_operationnelle(p_company UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(public.etat_abonnement_entreprise(p_company) ->> 'etat' = 'ACTIVE', FALSE);
$$;

REVOKE ALL ON FUNCTION public.entreprise_operationnelle(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entreprise_operationnelle(UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. PREPARER UN PAIEMENT (appelee par le serveur, AVEC le jeton de l'acheteur)
-- -----------------------------------------------------------------------------
--  Le navigateur n'envoie que le plan et la periode. L'entreprise est deduite
--  des droits de la personne connectee ; le montant est lu dans les tarifs.
--
--  Idempotence : un paiement du meme plan deja en cours (moins de 45 minutes)
--  est REUTILISE au lieu d'en creer un second — double clic, retour arriere,
--  requete rejouee. Un verrou par entreprise serialise les requetes
--  simultanees.
--
--  Reponse « action » :
--    REDIRECT     un checkout JoonaPay existe deja : y retourner
--    IN_PROGRESS  un autre onglet est en train de le creer : patienter
--    CREATE       nouveau paiement a creer chez JoonaPay

CREATE OR REPLACE FUNCTION public.billing_prepare_checkout(
    p_plan        TEXT,
    p_period      TEXT,
    p_environment TEXT,
    p_company     UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid        UUID := auth.uid();
    v_email      TEXT := auth.email();
    v_plan       TEXT := lower(btrim(COALESCE(p_plan, '')));
    v_periode    TEXT := upper(btrim(COALESCE(p_period, 'MONTHLY')));
    v_env        TEXT := lower(btrim(COALESCE(p_environment, '')));
    v_nb         INT;
    v_company    RECORD;
    v_tarif      RECORD;
    v_montant    INTEGER;
    v_etat       JSONB;
    v_existant   RECORD;
    v_reference  TEXT;
    v_paiement   RECORD;
    v_client     RECORD;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;
    IF v_env NOT IN ('sandbox', 'production') THEN
        RAISE EXCEPTION 'Environnement inconnu.' USING ERRCODE = 'TM422', HINT = 'ENVIRONNEMENT_INVALIDE';
    END IF;
    IF v_env <> public.billing_mode() THEN
        RAISE EXCEPTION 'Le serveur de paiement et la plateforme ne sont pas dans le même mode.'
            USING ERRCODE = 'TM409', HINT = 'MODE_INCOHERENT';
    END IF;
    IF v_periode NOT IN ('MONTHLY', 'ANNUAL') THEN
        RAISE EXCEPTION 'Période invalide.' USING ERRCODE = 'TM422', HINT = 'PERIODE_INVALIDE';
    END IF;

    -- Sandbox : un paiement de test ne coute rien. Reserve aux testeurs.
    IF v_env = 'sandbox' AND NOT public.is_platform_admin() AND NOT EXISTS (
        SELECT 1 FROM public.billing_settings s
         WHERE lower(COALESCE(v_email, '')) = ANY (SELECT lower(t) FROM unnest(s.testeurs_sandbox) t)
    ) THEN
        RAISE EXCEPTION 'Le paiement en ligne n''est pas encore ouvert. Votre entreprise est enregistrée : revenez bientôt pour l''activer.'
            USING ERRCODE = 'TM403', HINT = 'PAIEMENT_PAS_ENCORE_OUVERT';
    END IF;

    -- Entreprise : celle que la personne administre. Un identifiant fourni
    -- n'est accepte que s'il figure parmi ses propres rattachements.
    SELECT count(*) INTO v_nb
      FROM public.company_memberships m
     WHERE m.user_id = v_uid AND m.status = 'ACTIVE'
       AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
       AND (p_company IS NULL OR m.company_id = p_company);

    IF v_nb = 0 THEN
        RAISE EXCEPTION 'Seuls le propriétaire et les administrateurs activent l''abonnement.'
            USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;
    IF v_nb > 1 THEN
        RAISE EXCEPTION 'Précisez l''entreprise à activer.' USING ERRCODE = 'TM409', HINT = 'ENTREPRISE_A_PRECISER';
    END IF;

    SELECT c.id, c.name, c.billing_environment, lower(COALESCE(c.status, 'active')) AS status,
           c.onboarding_completed, c.country
      INTO v_company
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_uid AND m.status = 'ACTIVE'
       AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
       AND (p_company IS NULL OR m.company_id = p_company)
     LIMIT 1;

    IF v_company.status IN ('suspended', 'cancelled') THEN
        RAISE EXCEPTION 'Ce compte entreprise est suspendu. Contactez Timora.'
            USING ERRCODE = 'TM403', HINT = 'ENTREPRISE_SUSPENDUE';
    END IF;
    IF NOT v_company.onboarding_completed THEN
        RAISE EXCEPTION 'Complétez d''abord les informations de l''entreprise.'
            USING ERRCODE = 'TM409', HINT = 'ONBOARDING_INCOMPLET';
    END IF;
    IF v_company.billing_environment <> v_env THEN
        RAISE EXCEPTION 'Cette entreprise ne peut pas être activée dans ce mode de paiement.'
            USING ERRCODE = 'TM409', HINT = 'ENVIRONNEMENT_INCOMPATIBLE';
    END IF;

    SELECT code, name, monthly_price_fcfa, annual_price_fcfa, currency, self_serve, is_active
      INTO v_tarif
      FROM public.platform_plans WHERE code = v_plan;

    IF NOT FOUND OR NOT v_tarif.is_active OR NOT v_tarif.self_serve THEN
        RAISE EXCEPTION 'Cette formule ne se souscrit pas en ligne.'
            USING ERRCODE = 'TM422', HINT = 'FORMULE_INDISPONIBLE';
    END IF;

    v_montant := CASE WHEN v_periode = 'ANNUAL' THEN v_tarif.annual_price_fcfa ELSE v_tarif.monthly_price_fcfa END;
    IF v_montant IS NULL OR v_montant < 100 THEN
        RAISE EXCEPTION 'Cette formule n''a pas de tarif en ligne.'
            USING ERRCODE = 'TM422', HINT = 'FORMULE_INDISPONIBLE';
    END IF;

    -- Deja actif et loin de l'echeance : un second paiement serait un doublon.
    v_etat := public.etat_abonnement_entreprise(v_company.id);
    IF v_etat ->> 'etat' = 'ACTIVE' AND NOT (v_etat ->> 'heritee')::BOOLEAN
       AND (v_etat ->> 'fin') IS NOT NULL
       AND (v_etat ->> 'fin')::TIMESTAMPTZ > NOW() + INTERVAL '7 days' THEN
        RAISE EXCEPTION 'Votre abonnement est déjà actif. Le renouvellement s''ouvre 7 jours avant l''échéance.'
            USING ERRCODE = 'TM409', HINT = 'DEJA_ACTIF';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('billing_checkout:' || v_company.id::TEXT, 0));

    SELECT id, internal_reference, checkout_url, status, created_at, amount, plan_code, billing_period
      INTO v_existant
      FROM public.billing_payments
     WHERE company_id = v_company.id
       AND environment = v_env
       AND status IN ('PENDING', 'PROCESSING')
       AND created_at > NOW() - INTERVAL '45 minutes'
     ORDER BY created_at DESC
     LIMIT 1;

    IF FOUND THEN
        IF v_existant.plan_code = v_plan AND v_existant.billing_period = v_periode
           AND v_existant.amount = v_montant THEN
            IF v_existant.checkout_url IS NOT NULL THEN
                RETURN jsonb_build_object('action', 'REDIRECT', 'reference', v_existant.internal_reference,
                                          'checkout_url', v_existant.checkout_url,
                                          'amount', v_existant.amount, 'currency', 'XOF');
            ELSIF v_existant.created_at > NOW() - INTERVAL '2 minutes' THEN
                RETURN jsonb_build_object('action', 'IN_PROGRESS', 'reference', v_existant.internal_reference);
            END IF;
        END IF;

        -- Autre formule choisie, ou creation abandonnee : l'ancien checkout est
        -- clos pour qu'un seul paiement reste ouvert a la fois.
        UPDATE public.billing_payments
           SET status = 'CANCELLED', failure_code = 'REMPLACE_PAR_UN_NOUVEAU_PAIEMENT', updated_at = NOW()
         WHERE id = v_existant.id AND status = 'PENDING';
    END IF;

    -- Garde-fou : alterner les formules pour multiplier les demandes chez
    -- JoonaPay (60 requetes par minute pour tout Timora) n'est pas un usage
    -- normal.
    IF (SELECT count(*) FROM public.billing_payments
         WHERE company_id = v_company.id AND created_at > NOW() - INTERVAL '10 minutes') >= 6 THEN
        RAISE EXCEPTION 'Trop de tentatives de paiement. Réessayez dans quelques minutes.'
            USING ERRCODE = 'TM429', HINT = 'TROP_DE_TENTATIVES';
    END IF;

    v_reference := 'TIMORA-SUB-' || to_char(NOW() AT TIME ZONE 'Africa/Abidjan', 'YYYYMMDD') || '-'
                   || upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8));

    INSERT INTO public.billing_payments (company_id, user_id, environment, plan_code, billing_period,
                                         amount, currency, internal_reference, status)
    VALUES (v_company.id, v_uid, v_env, v_plan, v_periode, v_montant, 'XOF', v_reference, 'PENDING')
    RETURNING id, internal_reference INTO v_paiement;

    SELECT u.full_name, u.phone_number INTO v_client FROM public.users u WHERE u.id = v_uid;

    PERFORM public.billing_log('JOONAPAY_PAYMENT_CREATE_STARTED', v_env, v_reference,
        jsonb_build_object('plan', v_plan, 'period', v_periode, 'amount', v_montant));

    RETURN jsonb_build_object(
        'action',       'CREATE',
        'payment_id',   v_paiement.id,
        'reference',    v_paiement.internal_reference,
        'amount',       v_montant,
        'currency',     'XOF',
        'plan',         v_plan,
        'plan_name',    v_tarif.name,
        'period',       v_periode,
        'company_id',   v_company.id,
        'company_name', v_company.name,
        'company_country', v_company.country,
        'customer',     jsonb_build_object(
                            'name',  COALESCE(NULLIF(btrim(v_client.full_name), ''), split_part(COALESCE(v_email, ''), '@', 1)),
                            'email', v_email,
                            'phone', v_client.phone_number)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_prepare_checkout(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_prepare_checkout(TEXT, TEXT, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. RATTACHER LE CHECKOUT JOONAPAY / CONSTATER UN ECHEC DE CREATION
-- -----------------------------------------------------------------------------
--  Serveur uniquement (cle de service). Le navigateur ne peut ni fournir un
--  identifiant JoonaPay, ni une URL de paiement.

CREATE OR REPLACE FUNCTION public.billing_attach_checkout(
    p_reference           TEXT,
    p_environment         TEXT,
    p_provider_payment_id TEXT,
    p_provider_reference  TEXT,
    p_checkout_url        TEXT,
    p_provider_status     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_p RECORD;
BEGIN
    SELECT * INTO v_p FROM public.billing_payments
     WHERE internal_reference = p_reference FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Paiement inconnu.' USING ERRCODE = 'TM404', HINT = 'PAIEMENT_INCONNU';
    END IF;
    IF v_p.environment <> p_environment THEN
        RAISE EXCEPTION 'Environnement incohérent.' USING ERRCODE = 'TM409', HINT = 'ENVIRONNEMENT_INCOMPATIBLE';
    END IF;
    IF p_checkout_url IS NULL OR p_checkout_url !~ '^https://' THEN
        RAISE EXCEPTION 'URL de paiement invalide.' USING ERRCODE = 'TM422', HINT = 'URL_INVALIDE';
    END IF;
    IF v_p.status <> 'PENDING' THEN
        RETURN jsonb_build_object('ok', FALSE, 'status', v_p.status);
    END IF;

    UPDATE public.billing_payments
       SET provider_payment_id = p_provider_payment_id,
           provider_reference  = p_provider_reference,
           checkout_url        = p_checkout_url,
           provider_status     = p_provider_status,
           updated_at          = NOW()
     WHERE id = v_p.id;

    PERFORM public.billing_log('JOONAPAY_PAYMENT_CREATED', p_environment, p_reference,
        jsonb_build_object('provider_reference', p_provider_reference));

    RETURN jsonb_build_object('ok', TRUE, 'status', 'PENDING');
END;
$$;

REVOKE ALL ON FUNCTION public.billing_attach_checkout(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_attach_checkout(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_mark_create_failed(
    p_reference   TEXT,
    p_environment TEXT,
    p_code        TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.billing_payments
       SET status = 'FAILED',
           failure_code = left(regexp_replace(COALESCE(p_code, 'CREATION_ECHOUEE'), '[^A-Za-z0-9_]', '', 'g'), 64),
           updated_at = NOW()
     WHERE internal_reference = p_reference
       AND environment = p_environment
       AND status = 'PENDING'
       AND provider_payment_id IS NULL;

    PERFORM public.billing_log('JOONAPAY_PAYMENT_CREATE_FAILED', p_environment, p_reference,
        jsonb_build_object('code', p_code));
END;
$$;

REVOKE ALL ON FUNCTION public.billing_mark_create_failed(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_mark_create_failed(TEXT, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 9. APPLIQUER UN ETAT CONFIRME PAR JOONAPAY — ATOMIQUE ET IDEMPOTENT
-- -----------------------------------------------------------------------------
--  Appelee par le serveur apres une verification AUPRES de JoonaPay
--  (GET /payments/{uuid}), jamais sur la seule foi d'un webhook ou d'un
--  retour de navigateur.
--
--  L'abonnement n'est active que si TOUT concorde :
--    paiement connu, meme environnement que l'entreprise, statut SUCCESS et
--    payment_status PAID, montant paye = montant attendu, devise XOF, et
--    paiement jamais applique auparavant.
--
--  Rejouee (webhook repete, page de confirmation rafraichie), elle ne fait
--  rien de plus : un paiement COMPLETED ne s'applique qu'une fois.

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
     WHERE company_id = v_p.company_id AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
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

-- -----------------------------------------------------------------------------
-- 10. CONSULTER UN PAIEMENT (page de confirmation, AVEC le jeton de l'acheteur)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.billing_payment_status(p_reference TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_p RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    SELECT p.*, c.name AS company_name INTO v_p
      FROM public.billing_payments p
      JOIN public.companies c ON c.id = p.company_id
     WHERE p.internal_reference = p_reference;

    -- Une reference inconnue et une reference d'une autre entreprise recoivent
    -- la meme reponse : on ne revele pas l'existence d'un paiement.
    IF NOT FOUND OR NOT (public.can_configure_company(v_p.company_id) OR v_p.user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Paiement introuvable.' USING ERRCODE = 'TM404', HINT = 'PAIEMENT_INCONNU';
    END IF;

    RETURN jsonb_build_object(
        'reference',           v_p.internal_reference,
        'status',              v_p.status,
        'plan',                v_p.plan_code,
        'period',              v_p.billing_period,
        'amount',              v_p.amount,
        'currency',            v_p.currency,
        'environment',         v_p.environment,
        'company_id',          v_p.company_id,
        'company_name',        v_p.company_name,
        'failure_code',        v_p.failure_code,
        'provider_payment_id', v_p.provider_payment_id,
        'provider_status',     v_p.provider_status,
        'checkout_url',        CASE WHEN v_p.status IN ('PENDING', 'PROCESSING') THEN v_p.checkout_url END,
        'last_provider_check_at', v_p.last_provider_check_at,
        'created_at',          v_p.created_at,
        'completed_at',        v_p.completed_at,
        'subscription',        public.etat_abonnement_entreprise(v_p.company_id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_payment_status(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_payment_status(TEXT) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 11. PROGRESSION APRES ACTIVATION (premier pointage le plus vite possible)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.company_onboarding_progress(p_company UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := p_company;
    v_c       RECORD;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    IF v_company IS NULL THEN
        SELECT m.company_id INTO v_company
          FROM public.company_memberships m
         WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
         ORDER BY m.created_at LIMIT 1;
    END IF;

    IF v_company IS NULL OR NOT public.can_configure_company(v_company) THEN
        RAISE EXCEPTION 'Réservé au propriétaire et aux administrateurs.' USING ERRCODE = '42501';
    END IF;

    SELECT id, name, country, city, company_code INTO v_c FROM public.companies WHERE id = v_company;

    RETURN jsonb_build_object(
        'company_id',      v_c.id,
        'abonnement',      public.etat_abonnement_entreprise(v_c.id),
        'profil_complet',  v_c.country IS NOT NULL AND v_c.city IS NOT NULL,
        'zones',           (SELECT count(*) FROM public.geofences g WHERE g.company_id = v_c.id),
        'code_entreprise', v_c.company_code,
        'employes_actifs', (SELECT count(*) FROM public.company_memberships m
                             WHERE m.company_id = v_c.id AND m.status = 'ACTIVE'
                               AND public.normaliser_role_membre(m.role) IN ('EMPLOYEE', 'MANAGER')),
        'demandes',        (SELECT count(*) FROM public.company_memberships m
                             WHERE m.company_id = v_c.id AND m.status = 'PENDING_APPROVAL'),
        'pointages',       (SELECT count(*) FROM public.attendances a WHERE a.company_id = v_c.id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.company_onboarding_progress(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_onboarding_progress(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 12. VERROUS « ABONNEMENT ACTIF » SUR LES FONCTIONS PAYANTES
-- -----------------------------------------------------------------------------
--  Reinstallees depuis leurs sources, avec le controle d'abonnement. Les trois
--  premieres viennent des fichiers des migrations 010, 009 et 016 : leurs
--  messages retrouvent au passage leurs accents.

CREATE OR REPLACE FUNCTION public.record_attendance(
    p_punch_type      VARCHAR,
    p_latitude        DOUBLE PRECISION,
    p_longitude       DOUBLE PRECISION,
    p_gps_accuracy    DOUBLE PRECISION,
    p_selfie_path     TEXT DEFAULT NULL,
    p_face_score      NUMERIC DEFAULT NULL,
    p_device_ua       TEXT DEFAULT NULL,
    p_client_time     TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    p_qr_token        TEXT DEFAULT NULL,
    p_face_descriptor DOUBLE PRECISION[] DEFAULT NULL,
    p_face_motion     NUMERIC DEFAULT NULL,
    p_challenge_id    UUID DEFAULT NULL,
    p_liveness        JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid          UUID := auth.uid();
    v_user         public.users%ROWTYPE;
    v_company      public.companies%ROWTYPE;
    v_site         public.geofences%ROWTYPE;
    v_sched        public.work_schedules%ROWTYPE;
    v_tpl          public.face_templates%ROWTYPE;
    v_now          TIMESTAMP WITH TIME ZONE := NOW();
    v_local        TIMESTAMP := (NOW() AT TIME ZONE 'Africa/Abidjan');
    v_today        DATE := v_local::date;
    v_open         public.attendances%ROWTYPE;
    v_last         public.attendances%ROWTYPE;
    v_distance     DOUBLE PRECISION;
    v_att_id       UUID;
    v_needs_selfie BOOLEAN;
    v_face_ok      BOOLEAN := NULL;
    v_face_dist    DOUBLE PRECISION := NULL;
    v_face_pct     NUMERIC := NULL;
    v_max_dist     NUMERIC;
    v_required     BOOLEAN;
    v_late         INT := NULL;
    v_status       VARCHAR(50) := 'on_time';
    v_decision     VARCHAR(20) := 'ACCEPTED';
    v_code         VARCHAR(60) := NULL;
    v_detail       TEXT;
    v_qr           JSONB;
    v_method       VARCHAR(50);
    v_review       TEXT := NULL;
    v_live         JSONB;
BEGIN
    -- 1. Identite ---------------------------------------------------------------
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous pour pointer.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'EMPLOYEE_NOT_FOUND',
            'message', 'Votre fiche employé est introuvable. Contactez votre service RH.');
    END IF;

    IF NOT COALESCE(v_user.is_active, TRUE) THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'EMPLOYEE_INACTIVE',
            'message', 'Votre compte employé est désactivé. Contactez votre service RH.');
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;
    IF NOT FOUND OR v_company.status IN ('suspended', 'expired') THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'COMPANY_SUSPENDED',
            'message', 'Le compte de votre entreprise est suspendu.');
    END IF;

    -- Aucun pointage reel sans abonnement actif (migration 031).
    IF NOT public.entreprise_operationnelle(v_company.id) THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'SUBSCRIPTION_INACTIVE',
            'message', 'L''abonnement Timora de votre entreprise n''est pas actif. Prévenez votre responsable.');
    END IF;

    v_required := COALESCE(
        v_user.attendance_required,
        (SELECT m.attendance_required FROM public.company_memberships m
          WHERE m.user_id = v_user.id AND m.company_id = v_user.company_id),
        TRUE);

    IF NOT v_required THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'ATTENDANCE_NOT_REQUIRED',
            'message', 'Votre poste n''est pas soumis au pointage.');
    END IF;

    IF p_punch_type NOT IN ('CHECK_IN', 'CHECK_OUT') THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'INVALID_PUNCH_TYPE',
            'message', 'Type de pointage invalide.');
    END IF;

    -- 2. Doublons et coherence de la journee -----------------------------------
    SELECT * INTO v_last FROM public.attendances
     WHERE user_id = v_user.id AND company_id = v_user.company_id AND decision = 'ACCEPTED'
     ORDER BY server_time DESC LIMIT 1;

    IF FOUND AND v_last.server_time > v_now - make_interval(secs => COALESCE(v_company.min_punch_interval_sec, 60)) THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'DUPLICATE_PUNCH',
            'message', 'Un pointage vient déjà d''être enregistré. Patientez un instant.');
    END IF;

    SELECT * INTO v_open FROM public.attendances
     WHERE user_id = v_user.id AND company_id = v_user.company_id
       AND decision = 'ACCEPTED' AND punch_type = 'CHECK_IN' AND clock_out IS NULL
       AND (server_time AT TIME ZONE 'Africa/Abidjan')::date = v_today
     ORDER BY server_time DESC LIMIT 1;

    IF p_punch_type = 'CHECK_IN' AND v_open.id IS NOT NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'ALREADY_CHECKED_IN',
            'message', 'Votre arrivée a déjà été enregistrée aujourd''hui.');
    END IF;

    IF p_punch_type = 'CHECK_OUT' AND v_open.id IS NULL THEN
        RETURN jsonb_build_object('accepted', FALSE, 'code', 'NO_OPEN_CHECK_IN',
            'message', 'Aucune arrivée n''a été enregistrée aujourd''hui.');
    END IF;

    -- 3. Controles GPS ----------------------------------------------------------
    IF p_latitude IS NULL OR p_longitude IS NULL THEN
        v_code := 'NO_LOCATION'; v_detail := 'Coordonnées absentes.';
    ELSIF p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
        v_code := 'INVALID_COORDINATES'; v_detail := 'Coordonnées hors bornes.';
    ELSIF p_gps_accuracy IS NULL OR p_gps_accuracy <= 0 THEN
        v_code := 'NO_ACCURACY'; v_detail := 'Précision GPS non fournie.';
    ELSIF p_gps_accuracy > COALESCE(v_company.max_gps_accuracy_m, 100) THEN
        v_code := 'GPS_TOO_IMPRECISE';
        v_detail := format('Précision de %s m, maximum autorisé %s m.',
                    round(p_gps_accuracy::numeric, 0), COALESCE(v_company.max_gps_accuracy_m, 100));
    END IF;

    -- 4. VERIFICATION FACIALE — calculee ICI, jamais par le client ---------------
    --
    -- Placee AVANT la validation du QR, volontairement : qr_validate()
    -- consomme le jeton (anti-rejeu). Si l identite echouait apres, le code
    -- affiche sur la borne serait brule et l employe ne pourrait pas
    -- reessayer avant la rotation suivante.
    --
    -- Elle s applique AUSSI au pointage par QR code. Le jeton QR prouve la
    -- presence devant la borne ; il ne prouve pas QUI tient le telephone. Un
    -- salarie pourrait confier son appareil deverrouille a un collegue et se
    -- faire pointer a distance. Quand l entreprise exige l identite, elle
    -- l exige sur tous les chemins de pointage, sans exception.
    IF v_code IS NULL AND COALESCE(v_company.face_verification_enabled, FALSE) THEN

        SELECT * INTO v_tpl FROM public.face_templates WHERE user_id = v_user.id;

        IF NOT FOUND THEN
            -- On ne bloque pas sur une reference que l'employe n'a jamais pu
            -- enregistrer : on le lui dit clairement, c'est une action a sa portee.
            v_code := 'FACE_NOT_ENROLLED';
            v_detail := 'Aucun visage de référence enregistré pour votre compte.';

        ELSIF p_face_descriptor IS NULL OR array_length(p_face_descriptor, 1) <> 128 THEN
            v_code := 'FACE_NOT_CAPTURED';
            v_detail := 'Aucun visage exploitable n''a été détecté sur la photo.';

        ELSIF v_tpl.model_version IS DISTINCT FROM 'face-api-1.7.15/128' THEN
            -- Deux versions de modele produisent des vecteurs incomparables.
            v_code := 'FACE_MODEL_MISMATCH';
            v_detail := 'Votre visage de référence doit être réenregistré.';

        ELSE
            v_max_dist  := COALESCE(v_company.face_max_distance, 0.550);
            v_face_dist := public.face_distance(v_tpl.descriptor, p_face_descriptor);
            -- Pourcentage indicatif, pour l'affichage uniquement. La DECISION
            -- porte sur la distance, l'unite naturelle du modele.
            -- Cast explicite : PostgreSQL n'a pas de round(double precision, int).
            v_face_pct  := round((GREATEST(0, (1 - v_face_dist)) * 100)::numeric, 1);

            IF v_face_dist IS NULL THEN
                v_code := 'FACE_NOT_CAPTURED';
                v_detail := 'Empreinte faciale illisible.';
            ELSIF v_face_dist > v_max_dist THEN
                v_face_ok := FALSE;
                v_code := 'FACE_MISMATCH';
                v_detail := format('Le visage capturé ne correspond pas à la référence (écart %s, maximum %s).',
                            round(v_face_dist::numeric, 3), v_max_dist);
            ELSE
                v_face_ok := TRUE;

                -- ---------------------------------------------------------------
                -- VIVACITE : le visage correspond, mais est-il VIVANT ?
                --
                -- Sans ce controle, une photographie du bon visage passe. C est
                -- ici, et seulement ici, que la photo brandie est arretee.
                -- Voir la migration 011 pour le detail des mesures.
                -- ---------------------------------------------------------------
                IF COALESCE(v_company.face_liveness_enabled, TRUE) THEN
                    IF p_challenge_id IS NULL THEN
                        v_face_ok := NULL;
                        v_code := 'LIVENESS_REQUIRED';
                        v_detail := 'Le contrôle anti-photo n''a pas été effectué.';
                    ELSE
                        v_live := public.validate_liveness(
                            p_challenge_id, v_user.id, p_liveness,
                            v_tpl.descriptor, v_max_dist);

                        IF NOT (v_live->>'ok')::boolean THEN
                            v_face_ok := NULL;
                            v_code := v_live->>'code';
                            v_detail := v_live->>'detail';

                        -- « accepte, mais a verifier » : la mesure passive n a
                        -- pas conclu. Le pointage est ENREGISTRE — l employe ne
                        -- reste jamais bloque par un indicateur dont on ignore
                        -- le point de bascule — et le service RH le voit en
                        -- attente, avec le selfie horodate.
                        ELSIF COALESCE((v_live->>'soft')::boolean, FALSE) THEN
                            v_decision := 'PENDING_REVIEW';
                            v_review := COALESCE(v_live->>'detail',
                                'Vivacité non confirmée : vérification humaine recommandée.');
                        END IF;
                    END IF;
                END IF;

                -- Signal de mouvement, conserve comme motif de revue humaine.
                -- Il n a jamais ete un test de vivacite ; celui-ci est au-dessus.
                IF v_code IS NULL AND p_face_motion IS NOT NULL
                   AND p_face_motion <= COALESCE(v_company.face_min_motion, 0) THEN
                    v_decision := 'PENDING_REVIEW';
                    v_review := 'Mouvement du visage très faible entre les prises : vérification humaine recommandée.';
                END IF;
            END IF;
        END IF;
    END IF;

    -- 5. QR : le jeton impose le site -------------------------------------------
    IF v_code IS NULL AND p_qr_token IS NOT NULL AND length(trim(p_qr_token)) > 0 THEN
        v_qr := public.qr_validate(p_qr_token, v_user.id);
        IF NOT (v_qr->>'ok')::boolean THEN
            v_code := v_qr->>'code';
            v_detail := CASE v_code
                WHEN 'QR_EXPIRED' THEN 'Ce QR code n''est plus valable. Scannez celui affiché maintenant.'
                WHEN 'QR_REPLAY'  THEN 'Ce QR code a déjà servi à un pointage.'
                WHEN 'QR_FORGED'  THEN 'Ce QR code ne provient pas d''un poste de votre entreprise.'
                ELSE 'QR code invalide.'
            END;
        ELSE
            SELECT * INTO v_site FROM public.geofences
             WHERE id = (v_qr->>'site_id')::uuid AND company_id = v_user.company_id;
            IF NOT FOUND THEN
                v_code := 'QR_FORGED';
                v_detail := 'Ce QR code appartient à une autre entreprise.';
            END IF;
        END IF;
    END IF;

    -- 6. Sans QR : site le plus proche parmi ceux autorises ---------------------
    IF v_code IS NULL AND v_site.id IS NULL THEN
        SELECT g.* INTO v_site
          FROM public.geofences g
         WHERE g.company_id = v_user.company_id
           AND COALESCE(g.is_active, TRUE)
           AND g.latitude IS NOT NULL AND g.longitude IS NOT NULL
           AND (g.id = v_user.site_id
                OR g.id IN (SELECT es.site_id FROM public.employee_sites es WHERE es.user_id = v_user.id))
         ORDER BY public.haversine_meters(p_latitude, p_longitude, g.latitude, g.longitude) ASC
         LIMIT 1;

        IF v_site.id IS NULL THEN
            v_code := 'NO_SITE_ASSIGNED';
            v_detail := 'Aucun site de travail géolocalisé ne vous est affecté.';
        END IF;
    END IF;

    -- 7. Geofencing --------------------------------------------------------------
    IF v_code IS NULL AND v_site.id IS NOT NULL THEN
        v_distance := public.haversine_meters(p_latitude, p_longitude, v_site.latitude, v_site.longitude);
        IF v_distance > v_site.radius_meters AND NOT COALESCE(v_company.allow_out_of_zone, FALSE) THEN
            v_code := 'OUTSIDE_GEOFENCE';
            v_detail := format('À %s m du site, rayon autorisé %s m.',
                        round(v_distance::numeric, 0), v_site.radius_meters);
        END IF;
    END IF;

    -- 8. Selfie ------------------------------------------------------------------
    v_needs_selfie := COALESCE(v_company.attendance_method, 'GPS_SELFIE') IN ('GPS_SELFIE', 'GPS_SELFIE_QR')
                      AND (p_qr_token IS NULL OR length(trim(p_qr_token)) = 0);

    IF v_code IS NULL AND v_needs_selfie AND (p_selfie_path IS NULL OR length(trim(p_selfie_path)) = 0) THEN
        v_code := 'SELFIE_REQUIRED'; v_detail := 'Selfie obligatoire pour cette entreprise.';
    END IF;

    -- 9. Refus : on trace la tentative ------------------------------------------
    IF v_code IS NOT NULL THEN
        INSERT INTO public.attendance_attempts (
            company_id, user_id, site_id, punch_type, rejection_code, rejection_detail,
            latitude, longitude, gps_accuracy_meters, distance_from_site_m, allowed_radius_m,
            face_verification_score, selfie_path, device_user_agent, server_time)
        VALUES (
            v_user.company_id, v_user.id, v_site.id, p_punch_type, v_code, v_detail,
            p_latitude, p_longitude, p_gps_accuracy,
            round(v_distance::numeric, 2), v_site.radius_meters,
            v_face_pct, p_selfie_path, p_device_ua, v_now);

        RETURN jsonb_build_object('accepted', FALSE, 'code', v_code, 'message', v_detail,
            'distance_m', round(v_distance::numeric, 0), 'radius_m', v_site.radius_meters,
            'accuracy_m', round(p_gps_accuracy::numeric, 0), 'site_name', v_site.name,
            'face_distance', round(v_face_dist::numeric, 3), 'face_similarity', v_face_pct);
    END IF;

    -- 10. Retard -----------------------------------------------------------------
    IF v_user.schedule_id IS NOT NULL THEN
        SELECT * INTO v_sched FROM public.work_schedules
         WHERE id = v_user.schedule_id AND company_id = v_user.company_id;
    END IF;

    IF p_punch_type = 'CHECK_IN' AND v_sched.id IS NOT NULL THEN
        v_late := GREATEST(0,
            (EXTRACT(HOUR FROM v_local)::INT * 60 + EXTRACT(MINUTE FROM v_local)::INT)
              - v_sched.start_minute - COALESCE(v_sched.tolerance_minutes, 0));
        IF v_late > 0 THEN v_status := 'late'; END IF;
    END IF;

    -- 11. Acceptation -------------------------------------------------------------
    v_method := CASE
        WHEN p_qr_token IS NOT NULL AND length(trim(p_qr_token)) > 0 THEN 'qr_kiosk'
        WHEN v_face_ok IS TRUE THEN 'face_id'
        WHEN p_selfie_path IS NOT NULL THEN 'face_id'
        ELSE 'gps'
    END;

    IF p_punch_type = 'CHECK_OUT' AND v_decision = 'ACCEPTED' THEN
        UPDATE public.attendances SET clock_out = v_now, updated_at = v_now WHERE id = v_open.id;
    END IF;

    INSERT INTO public.attendances (
        company_id, user_id, geofence_id, site_id, schedule_id,
        method, status, punch_type, clock_in, clock_out, server_time,
        latitude, longitude, gps_accuracy_meters,
        distance_from_site_m, allowed_radius_m, max_accuracy_m_at_punch,
        late_minutes, tolerance_at_punch,
        selfie_path, face_verified, face_verification_score, face_threshold_at_punch,
        decision, review_note, device_user_agent, device_platform,
        attendance_method_used, is_fake_gps_detected)
    VALUES (
        v_user.company_id, v_user.id, v_site.id, v_site.id, v_sched.id,
        v_method, v_status, p_punch_type,
        CASE WHEN p_punch_type = 'CHECK_IN' THEN v_now ELSE v_open.clock_in END,
        CASE WHEN p_punch_type = 'CHECK_OUT' THEN v_now ELSE NULL END,
        v_now,
        p_latitude, p_longitude, p_gps_accuracy,
        round(v_distance::numeric, 2), v_site.radius_meters,
        COALESCE(v_company.max_gps_accuracy_m, 100),
        v_late, v_sched.tolerance_minutes,
        p_selfie_path, v_face_ok, v_face_pct, (COALESCE(v_company.face_max_distance, 0.550) * 100),
        v_decision, v_review, p_device_ua, 'WEB',
        COALESCE(v_company.attendance_method, 'GPS_SELFIE'), FALSE)
    RETURNING id INTO v_att_id;

    RETURN jsonb_build_object(
        'accepted', (v_decision = 'ACCEPTED'), 'code', v_decision,
        'attendance_id', v_att_id, 'punch_type', p_punch_type, 'method', v_method,
        'server_time', to_char(v_local, 'HH24:MI:SS'),
        'server_date', to_char(v_local, 'DD/MM/YYYY'),
        'distance_m', round(v_distance::numeric, 0),
        'radius_m', v_site.radius_meters,
        'accuracy_m', round(p_gps_accuracy::numeric, 0),
        'site_name', v_site.name,
        'late_minutes', v_late,
        'status', v_status,
        'face_verified', v_face_ok,
        'face_distance', round(v_face_dist::numeric, 3),
        'face_similarity', v_face_pct,
        'review_note', v_review);
END;
$$;

CREATE OR REPLACE FUNCTION public.enroll_face(
    p_descriptor    DOUBLE PRECISION[],
    p_quality       NUMERIC DEFAULT NULL,
    p_model_version TEXT DEFAULT 'face-api-1.7.15/128'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_user public.users%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'EMPLOYEE_NOT_FOUND',
            'message', 'Votre fiche employé est introuvable.');
    END IF;

    IF NOT public.entreprise_operationnelle(v_user.company_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SUBSCRIPTION_INACTIVE',
            'message', 'L''abonnement Timora de votre entreprise n''est pas actif. Prévenez votre responsable.');
    END IF;

    IF p_descriptor IS NULL OR array_length(p_descriptor, 1) <> 128 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID_DESCRIPTOR',
            'message', 'La capture n''a pas produit une empreinte exploitable.');
    END IF;

    INSERT INTO public.face_templates (company_id, user_id, descriptor, model_version, quality)
    VALUES (v_user.company_id, v_user.id, p_descriptor, p_model_version, p_quality)
    ON CONFLICT (user_id) DO UPDATE
        SET descriptor    = EXCLUDED.descriptor,
            model_version = EXCLUDED.model_version,
            quality       = EXCLUDED.quality,
            company_id    = EXCLUDED.company_id,
            consent_at    = NOW(),
            updated_at    = NOW();

    RETURN jsonb_build_object('ok', TRUE,
        'message', 'Votre visage de référence est enregistré.');
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_face_challenge(p_mode TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_uid     UUID := auth.uid();
    v_user    public.users%ROWTYPE;
    v_company public.companies%ROWTYPE;
    -- Plus de BLINK : trop bref pour etre capte de facon fiable.
    v_pool    TEXT[] := ARRAY['MOUTH_OPEN', 'TURN_SIDE'];
    v_actions TEXT[] := ARRAY[]::TEXT[];
    v_mode    TEXT;
    v_n       INT;
    v_i       INT;
    v_j       INT;
    v_tmp     TEXT;
    v_id      UUID;
    v_ttl     INT := 90;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'NOT_AUTHENTICATED',
            'message', 'Votre session a expiré. Reconnectez-vous.');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'EMPLOYEE_NOT_FOUND');
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;

    IF NOT public.entreprise_operationnelle(v_user.company_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SUBSCRIPTION_INACTIVE',
            'message', 'L''abonnement Timora de votre entreprise n''est pas actif. Prévenez votre responsable.');
    END IF;

    IF COALESCE(v_company.face_liveness_mode, 'PASSIVE') = 'GESTURE' THEN
        v_mode := 'GESTURE';
    ELSE
        v_mode := CASE WHEN upper(COALESCE(p_mode, 'PASSIVE')) = 'GESTURE'
                       THEN 'GESTURE' ELSE 'PASSIVE' END;
    END IF;

    IF v_mode = 'GESTURE' THEN
        -- Un seul geste suffit desormais : deux geste a chaque pointage, matin
        -- et soir, tous les jours, personne ne le supporte.
        v_n := LEAST(array_length(v_pool, 1),
                     GREATEST(1, COALESCE(v_company.face_liveness_steps, 1)));

        v_actions := v_pool;
        FOR v_i IN REVERSE array_length(v_actions, 1) .. 2 LOOP
            v_j := 1 + floor(random() * v_i)::int;
            v_tmp          := v_actions[v_i];
            v_actions[v_i] := v_actions[v_j];
            v_actions[v_j] := v_tmp;
        END LOOP;
        v_actions := v_actions[1:v_n];
    END IF;

    UPDATE public.face_challenges
       SET consumed_at = NOW()
     WHERE user_id = v_uid AND consumed_at IS NULL;

    INSERT INTO public.face_challenges (user_id, company_id, actions, mode, expires_at)
    VALUES (v_uid, v_user.company_id, v_actions, v_mode,
            NOW() + make_interval(secs => v_ttl))
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', TRUE,
        'challenge_id', v_id,
        'mode', v_mode,
        'actions', to_jsonb(COALESCE(v_actions, ARRAY[]::TEXT[])),
        'expires_in', v_ttl);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_employee_punch_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_uid      UUID := auth.uid();
    v_user     public.users%ROWTYPE;
    v_company  public.companies%ROWTYPE;
    v_site     public.geofences%ROWTYPE;
    v_sched    public.work_schedules%ROWTYPE;
    v_sites    JSONB := '[]'::jsonb;
    v_missing  TEXT[] := ARRAY[]::TEXT[];
    v_required BOOLEAN;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ready', FALSE, 'reason', 'NOT_AUTHENTICATED');
    END IF;

    SELECT * INTO v_user FROM public.users WHERE id = v_uid;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ready', FALSE, 'reason', 'EMPLOYEE_NOT_FOUND',
            'missing', to_jsonb(ARRAY['Votre fiche employé n''existe pas encore']));
    END IF;

    SELECT * INTO v_company FROM public.companies WHERE id = v_user.company_id;

    -- Obligation de pointer : la fiche employé prime, le rattachement complète.
    v_required := COALESCE(
        v_user.attendance_required,
        (SELECT m.attendance_required FROM public.company_memberships m
          WHERE m.user_id = v_user.id AND m.company_id = v_user.company_id),
        TRUE
    );

    IF NOT COALESCE(v_user.is_active, TRUE) THEN
        v_missing := array_append(v_missing, 'Votre compte est désactivé'::TEXT);
    END IF;

    IF v_company.id IS NULL THEN
        v_missing := array_append(v_missing, 'Aucune entreprise rattachée'::TEXT);
    ELSIF v_company.status IN ('suspended', 'expired') THEN
        v_missing := array_append(v_missing, 'Abonnement de l''entreprise inactif'::TEXT);
    ELSIF NOT public.entreprise_operationnelle(v_company.id) THEN
        v_missing := array_append(v_missing, 'L''abonnement Timora de votre entreprise n''est pas actif'::TEXT);
    END IF;

    -- Site principal, puis sites additionnels autorisés.
    IF v_user.site_id IS NOT NULL THEN
        SELECT * INTO v_site FROM public.geofences
        WHERE id = v_user.site_id AND company_id = v_user.company_id;
    END IF;

    IF v_site.id IS NULL THEN
        v_missing := array_append(v_missing, 'Aucun site de travail ne vous est affecté'::TEXT);
    ELSIF v_site.latitude IS NULL OR v_site.longitude IS NULL THEN
        v_missing := array_append(v_missing, 'Votre site n''a pas de coordonnées GPS'::TEXT);
    ELSIF NOT COALESCE(v_site.is_active, TRUE) THEN
        v_missing := array_append(v_missing, 'Votre site de travail est désactivé'::TEXT);
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name,
               'latitude', g.latitude, 'longitude', g.longitude,
               'radius_m', g.radius_meters)), '[]'::jsonb)
      INTO v_sites
      FROM public.geofences g
     WHERE g.company_id = v_user.company_id
       AND COALESCE(g.is_active, TRUE)
       AND g.latitude IS NOT NULL
       AND (g.id = v_user.site_id
            OR g.id IN (SELECT es.site_id FROM public.employee_sites es WHERE es.user_id = v_user.id));

    -- Horaire : bloquant uniquement si l'entreprise l'exige.
    IF v_user.schedule_id IS NOT NULL THEN
        SELECT * INTO v_sched FROM public.work_schedules
        WHERE id = v_user.schedule_id AND company_id = v_user.company_id;
    END IF;

    IF v_sched.id IS NULL AND COALESCE(v_company.require_schedule, FALSE) THEN
        v_missing := array_append(v_missing, 'Aucun horaire de travail ne vous est attribué'::TEXT);
    END IF;

    RETURN jsonb_build_object(
        'ready',              (array_length(v_missing, 1) IS NULL) AND v_required,
        'attendance_required', v_required,
        'missing',            to_jsonb(v_missing),
        'employee', jsonb_build_object(
            'id', v_user.id, 'full_name', v_user.full_name,
            'matricule', v_user.registration_number, 'is_active', v_user.is_active),
        'company', jsonb_build_object(
            'id', v_company.id, 'name', v_company.name,
            'attendance_method', COALESCE(v_company.attendance_method, 'GPS_SELFIE'),
            'max_gps_accuracy_m', COALESCE(v_company.max_gps_accuracy_m, 100),
            'require_check_in', COALESCE(v_company.require_check_in, TRUE),
            'require_check_out', COALESCE(v_company.require_check_out, TRUE),
            'face_verification_enabled', COALESCE(v_company.face_verification_enabled, FALSE)),
        'primary_site', CASE WHEN v_site.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_site.id, 'name', v_site.name,
            'latitude', v_site.latitude, 'longitude', v_site.longitude,
            'radius_m', v_site.radius_meters) END,
        'allowed_sites', v_sites,
        'schedule', CASE WHEN v_sched.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_sched.id, 'name', v_sched.name,
            'start_minute', v_sched.start_minute, 'end_minute', v_sched.end_minute,
            'tolerance_minutes', v_sched.tolerance_minutes,
            'work_days', to_jsonb(v_sched.work_days)) END
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_site_qr_token(p_site_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_site    public.geofences%ROWTYPE;
    v_counter BIGINT;
    v_rot     INT;
    v_reste   INT;
BEGIN
    SELECT * INTO v_site FROM public.geofences WHERE id = p_site_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SITE_NOT_FOUND',
            'message', 'Ce site est introuvable.');
    END IF;

    IF NOT public.can_configure_company(v_site.company_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'FORBIDDEN',
            'message', 'Seuls le CEO et le service RH peuvent ouvrir une borne de pointage.');
    END IF;

    IF NOT public.entreprise_operationnelle(v_site.company_id) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SUBSCRIPTION_INACTIVE',
            'message', 'Activez l''abonnement Timora pour ouvrir une borne de pointage.');
    END IF;

    IF NOT COALESCE(v_site.qr_enabled, TRUE) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_DISABLED',
            'message', 'Le pointage par QR code est désactivé pour ce site.');
    END IF;

    v_rot := GREATEST(15, COALESCE(v_site.qr_rotation_sec, 30));
    v_counter := FLOOR(EXTRACT(EPOCH FROM NOW()) / v_rot)::BIGINT;
    v_reste := v_rot - (FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT % v_rot);

    RETURN jsonb_build_object(
        'ok', TRUE,
        'token', p_site_id::text || '.' || v_counter::text || '.' ||
                 public.qr_sign(p_site_id, v_counter, v_site.qr_secret),
        'site_name', v_site.name,
        'rotation_sec', v_rot,
        'expires_in', v_reste
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_join_request(p_membership uuid, p_site uuid DEFAULT NULL::uuid, p_schedule uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_demande   RECORD;
    v_prefixe   TEXT;
    v_compteur  INTEGER;
    v_matricule TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    SELECT m.id, m.user_id, m.company_id, m.status, u.registration_number, u.full_name, u.email
      INTO v_demande
      FROM public.company_memberships m
      JOIN public.users u ON u.id = m.user_id
     WHERE m.id = p_membership
     FOR UPDATE OF m;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cette demande n''existe plus.' USING ERRCODE = 'TM404', HINT = 'DEMANDE_INTROUVABLE';
    END IF;

    IF NOT public.can_configure_company(v_demande.company_id) THEN
        RAISE EXCEPTION 'Seuls le propriétaire et les administrateurs traitent les demandes.'
            USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;

    IF v_demande.status = 'ACTIVE' THEN
        RETURN jsonb_build_object('ok', TRUE, 'status', 'ACTIVE', 'deja_traitee', TRUE,
                                  'membership_id', v_demande.id, 'user_id', v_demande.user_id,
                                  'company_id', v_demande.company_id, 'full_name', v_demande.full_name);
    END IF;

    IF NOT public.entreprise_operationnelle(v_demande.company_id) THEN
        RAISE EXCEPTION 'Activez l''abonnement Timora pour accueillir des collaborateurs.'
            USING ERRCODE = 'TM402', HINT = 'ABONNEMENT_INACTIF';
    END IF;

    IF v_demande.status NOT IN ('PENDING_APPROVAL', 'INVITED') THEN
        RAISE EXCEPTION 'Cette demande a déjà été traitée.' USING ERRCODE = 'TM409', HINT = 'DEMANDE_TRAITEE';
    END IF;

    -- Le site et l'horaire proposes doivent appartenir a CETTE entreprise.
    IF p_site IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.geofences g WHERE g.id = p_site AND g.company_id = v_demande.company_id
    ) THEN
        RAISE EXCEPTION 'Ce site n''appartient pas à votre entreprise.' USING ERRCODE = 'TM422', HINT = 'SITE_INVALIDE';
    END IF;

    IF p_schedule IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.work_schedules w WHERE w.id = p_schedule AND w.company_id = v_demande.company_id
    ) THEN
        RAISE EXCEPTION 'Cet horaire n''appartient pas à votre entreprise.' USING ERRCODE = 'TM422', HINT = 'HORAIRE_INVALIDE';
    END IF;

    -- Matricule : attribue ici, avec le compteur de l'entreprise verrouille.
    v_matricule := NULLIF(btrim(COALESCE(v_demande.registration_number, '')), '');
    IF v_matricule IS NULL THEN
        UPDATE public.companies
           SET employee_counter = COALESCE(employee_counter, 0) + 1,
               updated_at = NOW()
         WHERE id = v_demande.company_id
        RETURNING COALESCE(NULLIF(btrim(employee_prefix), ''), 'EMP'), employee_counter
          INTO v_prefixe, v_compteur;

        v_matricule := v_prefixe || '-' || lpad(v_compteur::TEXT, 4, '0');
    END IF;

    UPDATE public.company_memberships
       SET status = 'ACTIVE', updated_at = NOW()
     WHERE id = v_demande.id;

    UPDATE public.users
       SET is_active = TRUE,
           company_id = v_demande.company_id,
           registration_number = v_matricule,
           site_id = COALESCE(p_site, site_id),
           schedule_id = COALESCE(p_schedule, schedule_id)
     WHERE id = v_demande.user_id;

    RETURN jsonb_build_object(
        'ok', TRUE, 'status', 'ACTIVE', 'deja_traitee', FALSE,
        'membership_id', v_demande.id, 'user_id', v_demande.user_id,
        'company_id', v_demande.company_id, 'full_name', v_demande.full_name,
        'email', v_demande.email, 'registration_number', v_matricule);
END;
$function$;

CREATE OR REPLACE FUNCTION public.join_company(p_code text, p_full_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_job_title text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user    UUID := auth.uid();
    v_email   TEXT := auth.email();
    v_company RECORD;
    v_statut  TEXT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.compte_email_verifie() THEN
        RAISE EXCEPTION 'Adresse e-mail non vérifiée : confirmez-la avant de rejoindre une entreprise.'
            USING ERRCODE = 'TM401', HINT = 'EMAIL_NON_VERIFIE';
    END IF;

    SELECT c.id, c.name, lower(COALESCE(c.status, 'active')) AS status
      INTO v_company
      FROM public.companies c
     WHERE upper(btrim(c.company_code)) = upper(btrim(COALESCE(p_code, '')))
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aucune entreprise ne correspond à ce code.'
            USING ERRCODE = 'TM404', HINT = 'CODE_INCONNU';
    END IF;

    IF v_company.status IN ('suspended', 'expired', 'cancelled') THEN
        RAISE EXCEPTION 'L''abonnement de cette entreprise est suspendu.'
            USING ERRCODE = 'TM403', HINT = 'ENTREPRISE_SUSPENDUE';
    END IF;

    IF NOT public.entreprise_operationnelle(v_company.id) THEN
        RAISE EXCEPTION 'Cette entreprise n''a pas encore activé Timora. Son responsable doit d''abord activer l''abonnement.'
            USING ERRCODE = 'TM402', HINT = 'ABONNEMENT_INACTIF';
    END IF;

    SELECT m.status INTO v_statut
      FROM public.company_memberships m
     WHERE m.user_id = v_user AND m.company_id = v_company.id
     LIMIT 1;

    INSERT INTO public.users (id, company_id, email, full_name, role, job_title,
                              phone_number, attendance_required, is_active)
    VALUES (v_user, v_company.id, v_email,
            COALESCE(NULLIF(btrim(p_full_name), ''), public.nom_compte_connecte()),
            'EMPLOYEE', NULLIF(btrim(p_job_title), ''), NULLIF(btrim(p_phone), ''), TRUE, TRUE)
    ON CONFLICT (id) DO UPDATE
        SET full_name    = COALESCE(NULLIF(btrim(p_full_name), ''), public.users.full_name),
            phone_number = COALESCE(NULLIF(btrim(p_phone), ''), public.users.phone_number);

    IF v_statut IS NULL THEN
        INSERT INTO public.company_memberships (user_id, company_id, role, attendance_required, status)
        VALUES (v_user, v_company.id, 'EMPLOYEE', TRUE, 'PENDING_APPROVAL');
        v_statut := 'PENDING_APPROVAL';

        INSERT INTO public.auth_events (event, flow, email_hash, email_domain, user_id)
        VALUES ('JOIN_REQUESTED', 'employee_join', public.empreinte_email(v_email),
                NULLIF(lower(split_part(COALESCE(v_email, ''), '@', 2)), ''), v_user);
    ELSIF v_statut = 'INVITED' THEN
        UPDATE public.company_memberships
           SET status = 'PENDING_APPROVAL', updated_at = NOW()
         WHERE user_id = v_user AND company_id = v_company.id;
        v_statut := 'PENDING_APPROVAL';
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'company_id', v_company.id,
                              'company_name', v_company.name, 'statut', v_statut);
END;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_company_by_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    IF p_code IS NULL OR length(btrim(p_code)) < 4 OR length(btrim(p_code)) > 32 THEN
        RETURN NULL;
    END IF;

    SELECT c.id, c.name, c.city, lower(COALESCE(c.status, 'active')) AS status
      INTO v
      FROM public.companies c
     WHERE upper(btrim(c.company_code)) = upper(btrim(p_code))
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- `accepts_members` : l'entreprise a un abonnement actif. Sans lui,
    -- l'employe l'apprend AVANT de s'identifier, pas apres.
    RETURN jsonb_build_object('id', v.id, 'name', v.name, 'city', v.city, 'status', v.status,
                              'accepts_members', public.entreprise_operationnelle(v.id));
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_company_by_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_company_by_code(TEXT) TO anon, authenticated;

-- Zones GPS et horaires : lecture libre pour l'entreprise, ecriture seulement
-- avec un abonnement actif. La suppression reste possible (gestion des donnees).
DROP POLICY IF EXISTS geofences_write_configurator ON public.geofences;
CREATE POLICY geofences_write_configurator ON public.geofences
    FOR ALL TO authenticated
    USING (public.can_configure_company(company_id))
    WITH CHECK (public.can_configure_company(company_id) AND public.entreprise_operationnelle(company_id));

DROP POLICY IF EXISTS schedules_write_configurator ON public.work_schedules;
CREATE POLICY schedules_write_configurator ON public.work_schedules
    FOR ALL TO authenticated
    USING (public.can_configure_company(company_id))
    WITH CHECK (public.can_configure_company(company_id) AND public.entreprise_operationnelle(company_id));

-- Collaborateurs : ni demande d'adhesion, ni ajout direct sans abonnement actif.
DROP POLICY IF EXISTS memberships_insert_demande ON public.company_memberships;
CREATE POLICY memberships_insert_demande ON public.company_memberships
    FOR INSERT TO authenticated
    WITH CHECK (
        public.entreprise_operationnelle(company_id)
        AND (
            (user_id = auth.uid() AND COALESCE(status, 'PENDING_APPROVAL') = 'PENDING_APPROVAL')
            OR public.can_configure_company(company_id)
        )
    );

-- L'ancienne creation d'entreprise (avant la refonte) n'a plus d'appelant ;
-- elle permettrait de creer une entreprise sans passer par l'activation.
REVOKE EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) FROM authenticated, anon, PUBLIC;

-- -----------------------------------------------------------------------------
-- 13. CREATION D'ENTREPRISE : EN ATTENTE DE PAIEMENT
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_company(p_name text, p_country text, p_city text, p_employee_range text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user    UUID := auth.uid();
    v_email   TEXT := auth.email();
    v_nom     TEXT := btrim(COALESCE(p_name, ''));
    v_pays    TEXT := btrim(COALESCE(p_country, ''));
    v_ville   TEXT := btrim(COALESCE(p_city, ''));
    v_existe  RECORD;
    v_company RECORD;
    v_suite   TEXT;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.compte_email_verifie() THEN
        RAISE EXCEPTION 'Adresse e-mail non vérifiée.' USING ERRCODE = 'TM401', HINT = 'EMAIL_NON_VERIFIE';
    END IF;

    IF length(v_nom) < 2 OR length(v_nom) > 120 THEN
        RAISE EXCEPTION 'Nom d''entreprise invalide.' USING ERRCODE = 'TM422', HINT = 'NOM_INVALIDE';
    END IF;
    IF length(v_pays) < 2 OR length(v_pays) > 80 THEN
        RAISE EXCEPTION 'Pays invalide.' USING ERRCODE = 'TM422', HINT = 'PAYS_INVALIDE';
    END IF;
    IF length(v_ville) < 2 OR length(v_ville) > 80 THEN
        RAISE EXCEPTION 'Ville invalide.' USING ERRCODE = 'TM422', HINT = 'VILLE_INVALIDE';
    END IF;
    IF p_employee_range IS NULL OR p_employee_range NOT IN ('1-10', '11-30', '31-100', '100+') THEN
        RAISE EXCEPTION 'Effectif invalide.' USING ERRCODE = 'TM422', HINT = 'EFFECTIF_INVALIDE';
    END IF;

    -- Verrou transactionnel propre a CET utilisateur : deux requetes simultanees
    -- (double clic, requete rejouee par le reseau) s'executent l'une apres
    -- l'autre, et la seconde trouve le rattachement cree par la premiere.
    PERFORM pg_advisory_xact_lock(hashtextextended('create_company:' || v_user::text, 0));

    SELECT c.id, c.name, c.company_code, c.onboarding_completed,
           public.normaliser_role_membre(m.role) AS role
      INTO v_existe
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_user
       AND m.status = 'ACTIVE'
       AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
     ORDER BY (public.normaliser_role_membre(m.role) = 'OWNER') DESC, m.created_at
     LIMIT 1;

    IF FOUND THEN
        -- Entreprise creee par l'ancien parcours, sans pays ni ville : on la
        -- COMPLETE au lieu d'en creer une seconde.
        IF v_existe.role = 'OWNER' AND NOT v_existe.onboarding_completed THEN
            UPDATE public.companies
               SET name = v_nom, country = v_pays, city = v_ville,
                   employee_range = p_employee_range, onboarding_completed = TRUE, updated_at = NOW()
             WHERE id = v_existe.id
            RETURNING id, name, company_code INTO v_company;

            v_suite := CASE WHEN public.entreprise_operationnelle(v_company.id)
                            THEN 'company_dashboard' ELSE 'company_billing_required' END;

            RETURN jsonb_build_object('status', 'COMPLETED', 'company_id', v_company.id,
                                      'company_name', v_company.name, 'company_code', v_company.company_code,
                                      'role', 'owner', 'destination', v_suite);
        END IF;

        v_suite := CASE WHEN public.entreprise_operationnelle(v_existe.id)
                        THEN 'company_dashboard' ELSE 'company_billing_required' END;

        RETURN jsonb_build_object('status', 'ALREADY_EXISTS', 'company_id', v_existe.id,
                                  'company_name', v_existe.name, 'company_code', v_existe.company_code,
                                  'role', lower(v_existe.role), 'destination', v_suite);
    END IF;

    -- Tout ce qui suit forme UNE transaction : si une etape echoue, rien ne
    -- subsiste — ni entreprise sans proprietaire, ni proprietaire sans entreprise.
    -- Plus d'essai gratuit : l'entreprise nait en attente de paiement, dans le
    -- mode de facturation courant (test ou production). Rien ne fonctionne
    -- reellement avant la confirmation du paiement par le serveur.
    INSERT INTO public.companies (name, country, city, employee_range, onboarding_completed,
                                  created_by, plan, status, billing_environment, billing_legacy)
    VALUES (v_nom, v_pays, v_ville, p_employee_range, TRUE, v_user, NULL, 'pending_payment',
            public.billing_mode(), FALSE)
    RETURNING id, name, company_code INTO v_company;

    -- Le rattachement d'abord : la fiche peut ensuite pointer vers une
    -- entreprise que l'utilisateur administre (voir users_bloquer_escalade).
    INSERT INTO public.company_memberships (user_id, company_id, role, attendance_required, status)
    VALUES (v_user, v_company.id, public.role_proprietaire_stocke(), FALSE, 'ACTIVE');

    INSERT INTO public.users (id, company_id, email, full_name, role, job_title,
                              attendance_required, is_active)
    VALUES (v_user, v_company.id, v_email, public.nom_compte_connecte(),
            public.role_proprietaire_stocke(), 'Dirigeant', FALSE, TRUE)
    ON CONFLICT (id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            role       = EXCLUDED.role,
            is_active  = TRUE;

    INSERT INTO public.auth_events (event, flow, email_hash, email_domain, user_id)
    VALUES ('COMPANY_CREATED', 'company_signup', public.empreinte_email(v_email),
            NULLIF(lower(split_part(COALESCE(v_email, ''), '@', 2)), ''), v_user);

    RETURN jsonb_build_object('status', 'CREATED', 'company_id', v_company.id,
                              'company_name', v_company.name, 'company_code', v_company.company_code,
                              'role', 'owner', 'destination', 'company_billing_required');
END;
$function$;

-- -----------------------------------------------------------------------------
-- 14. RESOLUTION D'AUTHENTIFICATION : ACTIVATION AVANT LE COCKPIT
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_auth_context(p_intent text DEFAULT NULL::text, p_preferred_company uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_user        UUID := auth.uid();
    v_compte      RECORD;
    v_membres     JSONB;
    v_actif       RECORD;
    v_nb_actifs   INT;
    v_destination TEXT;
    v_attente     JSONB := NULL;
    v_abonnement  JSONB := NULL;
    v_operationnelle BOOLEAN := FALSE;
BEGIN
    IF v_user IS NULL THEN
        RETURN jsonb_build_object('authenticated', FALSE, 'destination', 'unauthenticated');
    END IF;

    SELECT u.id, u.email, u.email_confirmed_at IS NOT NULL AS email_verified,
           (SELECT COALESCE(jsonb_agg(DISTINCT i.provider), '[]'::jsonb)
              FROM auth.identities i WHERE i.user_id = u.id) AS providers
      INTO v_compte
      FROM auth.users u WHERE u.id = v_user;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'company_id', m.company_id,
               'company_name', c.name,
               'role', lower(public.normaliser_role_membre(m.role)),
               'status', m.status,
               'attendance_required', m.attendance_required,
               'company_status', lower(COALESCE(c.status, 'active')),
               'onboarding_completed', c.onboarding_completed
           ) ORDER BY m.created_at), '[]'::jsonb)
      INTO v_membres
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_user;

    SELECT count(*) INTO v_nb_actifs
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_user AND m.status = 'ACTIVE'
       AND lower(COALESCE(c.status, 'active')) NOT IN ('suspended', 'expired', 'cancelled');

    -- Rattachement retenu : l'entreprise demandee si elle est valide, sinon la
    -- seule disponible. Avec plusieurs et aucun choix valide, on ne choisit pas
    -- a la place de l'utilisateur.
    SELECT m.company_id, c.name AS company_name, public.normaliser_role_membre(m.role) AS role,
           m.attendance_required, c.onboarding_completed, c.company_code
      INTO v_actif
      FROM public.company_memberships m
      JOIN public.companies c ON c.id = m.company_id
     WHERE m.user_id = v_user AND m.status = 'ACTIVE'
       AND lower(COALESCE(c.status, 'active')) NOT IN ('suspended', 'expired', 'cancelled')
       AND (m.company_id = p_preferred_company OR v_nb_actifs = 1)
     ORDER BY (m.company_id = p_preferred_company) DESC NULLS LAST
     LIMIT 1;

    IF v_actif.company_id IS NOT NULL THEN
        v_abonnement := public.etat_abonnement_entreprise(v_actif.company_id);
        v_operationnelle := COALESCE(v_abonnement ->> 'etat' = 'ACTIVE', FALSE);
    END IF;

    IF p_intent = 'company_signup' THEN
        -- Deja proprietaire ou administrateur : pas de seconde entreprise, on
        -- ouvre l'existante — sauf une entreprise dont l'onboarding reste a finir.
        IF EXISTS (SELECT 1 FROM public.company_memberships m
                     JOIN public.companies c ON c.id = m.company_id
                    WHERE m.user_id = v_user AND m.status = 'ACTIVE'
                      AND public.normaliser_role_membre(m.role) = 'OWNER'
                      AND NOT c.onboarding_completed) THEN
            v_destination := 'company_onboarding';
        ELSIF EXISTS (SELECT 1 FROM public.company_memberships m
                       WHERE m.user_id = v_user AND m.status = 'ACTIVE'
                         AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')) THEN
            v_destination := CASE WHEN v_actif.company_id IS NULL THEN 'select_company'
                                  WHEN v_actif.role IN ('OWNER', 'ADMIN') AND NOT v_operationnelle
                                       THEN 'company_billing_required'
                                  ELSE 'company_dashboard' END;
        ELSE
            v_destination := 'company_onboarding';
        END IF;
    ELSIF v_actif.company_id IS NOT NULL THEN
        IF v_actif.role = 'OWNER' AND NOT v_actif.onboarding_completed THEN
            v_destination := 'company_onboarding';
        ELSIF v_actif.role IN ('OWNER', 'ADMIN') AND NOT v_operationnelle THEN
            -- Pas d'abonnement actif : l'activation, pas le cockpit.
            v_destination := 'company_billing_required';
        ELSIF NOT v_operationnelle THEN
            -- Collaborateur d'une entreprise dont l'abonnement a expire.
            v_destination := 'company_inactive';
        ELSIF v_actif.role IN ('OWNER', 'ADMIN', 'MANAGER') THEN
            v_destination := 'company_dashboard';
        ELSE
            v_destination := 'employee_dashboard';
        END IF;
    ELSIF v_nb_actifs > 1 THEN
        v_destination := 'select_company';
    ELSE
        SELECT jsonb_build_object('company_name', c.name, 'status', m.status,
                                  'registration_number',
                                  (SELECT u.registration_number FROM public.users u WHERE u.id = v_user))
          INTO v_attente
          FROM public.company_memberships m
          JOIN public.companies c ON c.id = m.company_id
         WHERE m.user_id = v_user AND m.status IN ('PENDING_APPROVAL', 'INVITED')
         ORDER BY m.created_at DESC
         LIMIT 1;

        IF v_attente IS NOT NULL THEN
            v_destination := 'pending_approval';
        ELSIF EXISTS (SELECT 1 FROM public.company_memberships m
                       WHERE m.user_id = v_user AND m.status = 'ACTIVE') THEN
            v_destination := 'company_suspended';
        ELSE
            v_destination := 'no_membership';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'authenticated', TRUE,
        'user', jsonb_build_object(
            'id', v_compte.id,
            'email', v_compte.email,
            'full_name', public.nom_compte_connecte(),
            'email_verified', v_compte.email_verified,
            'providers', v_compte.providers),
        'platform_admin', public.is_platform_admin(),
        'memberships', v_membres,
        'active', CASE WHEN v_actif.company_id IS NULL THEN NULL ELSE jsonb_build_object(
            'company_id', v_actif.company_id,
            'company_name', v_actif.company_name,
            'company_code', v_actif.company_code,
            'role', lower(v_actif.role),
            'attendance_required', v_actif.attendance_required,
            'onboarding_completed', v_actif.onboarding_completed) END,
        -- Etat d'abonnement : detaille pour qui peut le regler, reduit a
        -- l'essentiel pour les collaborateurs.
        'billing', CASE WHEN v_actif.company_id IS NULL THEN NULL
                        WHEN v_actif.role IN ('OWNER', 'ADMIN') THEN v_abonnement
                        ELSE jsonb_build_object('etat', v_abonnement ->> 'etat') END,
        'pending', v_attente,
        'destination', v_destination
    );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 15. TABLEAU DE BORD SUPER ADMIN : LE BAC A SABLE N'EST PAS DU CHIFFRE D'AFFAIRES
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_today   DATE := (NOW() AT TIME ZONE 'Africa/Abidjan')::DATE;
    v_mois    DATE := date_trunc('month', (NOW() AT TIME ZONE 'Africa/Abidjan'))::DATE;
    v_revenu  JSONB;
    v_clients JSONB;
    v_usage   JSONB;
    v_serie   JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    -- --- REVENU ---------------------------------------------------------
    -- Le MRR ne somme que les abonnements dont le tarif est REELLEMENT connu.
    -- Les autres sont comptes separement pour que le chiffre affiche ne
    -- cache jamais une part inconnue.
    --
    -- Depuis la migration 031 : les abonnements de TEST (bac a sable JoonaPay)
    -- ne sont jamais du chiffre d'affaires, et un abonnement dont la periode
    -- payee est terminee compte comme expire.
    WITH abos AS (
        SELECT s.id,
               CASE WHEN s.status IN ('ACTIVE', 'PAST_DUE') AND s.current_period_end IS NOT NULL
                         AND s.current_period_end <= NOW() THEN 'EXPIRED'
                    ELSE s.status END AS status,
               s.company_id, s.plan_code, s.billing_period,
               public.subscription_monthly_fcfa(
                   s.amount_fcfa, s.billing_period, p.monthly_price_fcfa, p.annual_price_fcfa
               ) AS mensuel
          FROM public.company_subscriptions s
          LEFT JOIN public.platform_plans p ON p.code = s.plan_code
         WHERE s.environment = 'production'
    ),
    factures AS (
        SELECT
            COALESCE(SUM(amount_fcfa) FILTER (WHERE status IN ('SENT', 'OVERDUE')), 0) AS encours,
            COUNT(*) FILTER (WHERE status = 'OVERDUE')                                 AS impayees,
            COUNT(*) FILTER (WHERE status IN ('SENT', 'OVERDUE'))                      AS a_recouvrer,
            COUNT(*)                                                                   AS total
          FROM public.platform_invoices
    ),
    encaisse AS (
        SELECT
            COALESCE(SUM(amount_fcfa) FILTER (WHERE status = 'CONFIRMED'), 0)          AS total,
            COALESCE(SUM(amount_fcfa) FILTER (WHERE status = 'CONFIRMED'
                     AND paid_at >= v_mois), 0)                                        AS mois,
            COALESCE(SUM(amount_fcfa) FILTER (WHERE status = 'CONFIRMED'
                     AND paid_at >= NOW() - INTERVAL '30 days'), 0)                    AS jours_30,
            COUNT(*) FILTER (WHERE status = 'CONFIRMED')                               AS nb
          FROM public.platform_payments
    )
    SELECT jsonb_build_object(
        'mrr',                    COALESCE(ROUND(SUM(a.mensuel) FILTER (
                                      WHERE a.status IN ('ACTIVE', 'PAST_DUE'))), 0),
        'abonnements_payants',    COUNT(*) FILTER (WHERE a.status IN ('ACTIVE', 'PAST_DUE')
                                                     AND a.mensuel > 0),
        'abonnements_non_factures', COUNT(*) FILTER (WHERE a.status IN ('ACTIVE', 'PAST_DUE')
                                                     AND a.mensuel = 0),
        'abonnements_expires',    COUNT(*) FILTER (WHERE a.status = 'EXPIRED'),
        'abonnements_non_tarifes',COUNT(*) FILTER (WHERE a.status IN ('ACTIVE', 'PAST_DUE')
                                                     AND a.mensuel IS NULL),
        'abonnements_essai',      COUNT(*) FILTER (WHERE a.status = 'TRIAL'),
        'abonnements_suspendus',  COUNT(*) FILTER (WHERE a.status = 'SUSPENDED'),
        'abonnements_resilies',   COUNT(*) FILTER (WHERE a.status = 'CANCELLED'),
        'abonnements_total',      COUNT(*),
        'plans_sans_tarif',       (SELECT COUNT(*) FROM public.platform_plans
                                    WHERE monthly_price_fcfa IS NULL
                                      AND annual_price_fcfa IS NULL),
        'plans_total',            (SELECT COUNT(*) FROM public.platform_plans),
        'encours_fcfa',           (SELECT encours      FROM factures),
        'factures_impayees',      (SELECT impayees     FROM factures),
        'factures_a_recouvrer',   (SELECT a_recouvrer  FROM factures),
        'factures_total',         (SELECT total        FROM factures),
        'encaisse_total_fcfa',    (SELECT total        FROM encaisse),
        'encaisse_mois_fcfa',     (SELECT mois         FROM encaisse),
        'encaisse_30j_fcfa',      (SELECT jours_30     FROM encaisse),
        'paiements_confirmes',    (SELECT nb           FROM encaisse)
    ) INTO v_revenu
    FROM abos a;

    -- --- CLIENTS --------------------------------------------------------
    SELECT jsonb_build_object(
        'entreprises_total',      (SELECT COUNT(*) FROM public.companies),
        'entreprises_actives',    (SELECT COUNT(*) FROM public.companies
                                    WHERE lower(COALESCE(status, 'active')) = 'active'),
        'entreprises_suspendues', (SELECT COUNT(*) FROM public.companies
                                    WHERE lower(COALESCE(status, 'active')) = 'suspended'),
        'entreprises_attente_paiement', (SELECT COUNT(*) FROM public.companies
                                    WHERE lower(COALESCE(status, 'active')) = 'pending_payment'),
        'entreprises_test',       (SELECT COUNT(*) FROM public.companies
                                    WHERE billing_environment = 'sandbox'),
        'entreprises_30j',        (SELECT COUNT(*) FROM public.companies
                                    WHERE created_at >= NOW() - INTERVAL '30 days'),
        'entreprises_mois',       (SELECT COUNT(*) FROM public.companies
                                    WHERE created_at >= v_mois),
        'utilisateurs_total',     (SELECT COUNT(*) FROM public.users),
        'utilisateurs_actifs',    (SELECT COUNT(*) FROM public.users WHERE is_active IS NOT FALSE),
        'utilisateurs_inactifs',  (SELECT COUNT(*) FROM public.users WHERE is_active IS FALSE),
        'utilisateurs_30j',       (SELECT COUNT(*) FROM public.users
                                    WHERE created_at >= NOW() - INTERVAL '30 days'),
        'utilisateurs_mois',      (SELECT COUNT(*) FROM public.users WHERE created_at >= v_mois),
        'par_role',               (SELECT COALESCE(jsonb_object_agg(r.role, r.n), '{}'::JSONB)
                                     FROM (SELECT upper(role) AS role, COUNT(*) AS n
                                             FROM public.users GROUP BY 1) r),
        'rattachements_actifs',   (SELECT COUNT(*) FROM public.company_memberships WHERE status = 'ACTIVE'),
        'rattachements_attente',  (SELECT COUNT(*) FROM public.company_memberships WHERE status = 'PENDING_APPROVAL'),
        'rattachements_invites',  (SELECT COUNT(*) FROM public.company_memberships WHERE status = 'INVITED'),
        'par_plan',               (SELECT COALESCE(jsonb_object_agg(x.code, x.n), '{}'::JSONB)
                                     FROM (SELECT COALESCE(s.plan_code, 'sans plan') AS code, COUNT(*) AS n
                                             FROM public.company_subscriptions s
                                            WHERE s.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
                                              AND s.environment = 'production'
                                              AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
                                            GROUP BY 1) x)
    ) INTO v_clients;

    -- --- USAGE DU PRODUIT -----------------------------------------------
    SELECT jsonb_build_object(
        'pointages_total',    (SELECT COUNT(*) FROM public.attendances),
        'pointages_jour',     (SELECT COUNT(*) FROM public.attendances
                                WHERE (COALESCE(server_time, created_at) AT TIME ZONE 'Africa/Abidjan')::DATE = v_today),
        'pointages_30j',      (SELECT COUNT(*) FROM public.attendances
                                WHERE COALESCE(server_time, created_at) >= NOW() - INTERVAL '30 days'),
        'pointages_7j',       (SELECT COUNT(*) FROM public.attendances
                                WHERE COALESCE(server_time, created_at) >= NOW() - INTERVAL '7 days'),
        'par_decision',       (SELECT COALESCE(jsonb_object_agg(d.decision, d.n), '{}'::JSONB)
                                 FROM (SELECT COALESCE(decision, 'INCONNU') AS decision, COUNT(*) AS n
                                         FROM public.attendances GROUP BY 1) d),
        'par_methode',        (SELECT COALESCE(jsonb_object_agg(m.methode, m.n), '{}'::JSONB)
                                 FROM (SELECT COALESCE(attendance_method_used, 'INCONNUE') AS methode, COUNT(*) AS n
                                         FROM public.attendances GROUP BY 1) m),
        'retards',            (SELECT COUNT(*) FROM public.attendances WHERE COALESCE(late_minutes, 0) > 0),
        'a_verifier',         (SELECT COUNT(*) FROM public.attendances WHERE decision = 'PENDING_REVIEW'),
        'refuses',            (SELECT COUNT(*) FROM public.attendances
                                WHERE decision IS NOT NULL AND decision NOT IN ('ACCEPTED', 'PENDING_REVIEW')),
        'gps_suspects',       (SELECT COUNT(*) FROM public.attendances WHERE is_fake_gps_detected IS TRUE),
        'empreintes',         (SELECT COUNT(*) FROM public.face_templates),
        'employes_pointeurs', (SELECT COUNT(*) FROM public.users
                                WHERE upper(COALESCE(role, '')) <> 'SUPER_ADMIN'
                                  AND attendance_required IS NOT FALSE
                                  AND is_active IS NOT FALSE),
        'sites',              (SELECT COUNT(*) FROM public.geofences),
        'sites_actifs',       (SELECT COUNT(*) FROM public.geofences WHERE is_active IS NOT FALSE),
        'sites_qr',           (SELECT COUNT(*) FROM public.geofences WHERE qr_enabled IS TRUE),
        'horaires',           (SELECT COUNT(*) FROM public.work_schedules),
        'conges_attente',     (SELECT COUNT(*) FROM public.leaves WHERE lower(COALESCE(status, '')) LIKE 'en attente%'),
        'conges_total',       (SELECT COUNT(*) FROM public.leaves),
        'heures_attente',     (SELECT COUNT(*) FROM public.overtimes WHERE lower(COALESCE(status, '')) LIKE 'en attente%'),
        'heures_total',       (SELECT COUNT(*) FROM public.overtimes),
        'retards_a_statuer',  (SELECT COUNT(*) FROM public.attendances WHERE late_status = 'PENDING')
    ) INTO v_usage;

    -- --- CROISSANCE : 12 derniers mois ----------------------------------
    WITH mois AS (
        SELECT generate_series(
                   date_trunc('month', (NOW() AT TIME ZONE 'Africa/Abidjan')) - INTERVAL '11 months',
                   date_trunc('month', (NOW() AT TIME ZONE 'Africa/Abidjan')),
                   INTERVAL '1 month'
               )::DATE AS m
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'mois',          to_char(mois.m, 'YYYY-MM'),
               'entreprises',   (SELECT COUNT(*) FROM public.companies c
                                  WHERE date_trunc('month', c.created_at AT TIME ZONE 'Africa/Abidjan')::DATE = mois.m),
               'utilisateurs',  (SELECT COUNT(*) FROM public.users u
                                  WHERE date_trunc('month', u.created_at AT TIME ZONE 'Africa/Abidjan')::DATE = mois.m),
               'pointages',     (SELECT COUNT(*) FROM public.attendances a
                                  WHERE date_trunc('month', COALESCE(a.server_time, a.created_at) AT TIME ZONE 'Africa/Abidjan')::DATE = mois.m),
               'encaisse_fcfa', (SELECT COALESCE(SUM(p.amount_fcfa), 0) FROM public.platform_payments p
                                  WHERE p.status = 'CONFIRMED'
                                    AND date_trunc('month', p.paid_at AT TIME ZONE 'Africa/Abidjan')::DATE = mois.m)
           ) ORDER BY mois.m), '[]'::JSONB)
      INTO v_serie
      FROM mois;

    RETURN jsonb_build_object(
        'genere_le', NOW(),
        'jour',      v_today,
        'revenu',    v_revenu,
        'clients',   v_clients,
        'usage',     v_usage,
        'serie',     v_serie
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.platform_companies()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::JSONB) INTO v
    FROM (
        SELECT jsonb_build_object(
            'id',              c.id,
            'nom',             c.name,
            'statut',          lower(COALESCE(c.status, 'active')),
            'code',            c.company_code,
            'created_at',      c.created_at,
            'max_employes',    c.max_employees,
            'plan',            s.plan_code,
            'abonnement_id',   s.id,
            'abonnement',      s.status,
            'periodicite',     s.billing_period,
            'montant_negocie', s.amount_fcfa,
            'debut',           s.started_at,
            'fin_periode',     s.current_period_end,
            'environnement',   c.billing_environment,
            'heritee',         c.billing_legacy,
            'etat_abonnement', public.etat_abonnement_entreprise(c.id) ->> 'etat',
            -- Le montant mensuel reel, ou NULL si aucun tarif n'est connu.
            'mrr_fcfa',        public.subscription_monthly_fcfa(
                                   s.amount_fcfa, s.billing_period,
                                   p.monthly_price_fcfa, p.annual_price_fcfa),
            'membres',         (SELECT COUNT(*) FROM public.company_memberships m
                                 WHERE m.company_id = c.id AND m.status = 'ACTIVE'),
            'membres_attente', (SELECT COUNT(*) FROM public.company_memberships m
                                 WHERE m.company_id = c.id AND m.status = 'PENDING_APPROVAL'),
            'pointages_30j',   (SELECT COUNT(*) FROM public.attendances a
                                 WHERE a.company_id = c.id
                                   AND COALESCE(a.server_time, a.created_at) >= NOW() - INTERVAL '30 days'),
            'dernier_pointage',(SELECT MAX(COALESCE(a.server_time, a.created_at)) FROM public.attendances a
                                 WHERE a.company_id = c.id),
            'sites',           (SELECT COUNT(*) FROM public.geofences g WHERE g.company_id = c.id),
            'empreintes',      (SELECT COUNT(*) FROM public.face_templates f WHERE f.company_id = c.id),
            'encaisse_fcfa',   (SELECT COALESCE(SUM(pm.amount_fcfa), 0) FROM public.platform_payments pm
                                 WHERE pm.company_id = c.id AND pm.status = 'CONFIRMED'),
            'encours_fcfa',    (SELECT COALESCE(SUM(i.amount_fcfa), 0) FROM public.platform_invoices i
                                 WHERE i.company_id = c.id AND i.status IN ('SENT', 'OVERDUE'))
        ) AS x
        FROM public.companies c
        LEFT JOIN public.company_subscriptions s
               ON s.company_id = c.id AND s.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
        LEFT JOIN public.platform_plans p ON p.code = s.plan_code
    ) t;

    RETURN v;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 16. ABONNEMENT REGLE HORS LIGNE (formule Entreprise sur devis, virement)
-- -----------------------------------------------------------------------------
--  Le super admin garde la main : un abonnement qu'il pose suit l'environnement
--  de l'entreprise (sinon il ne l'ouvrirait jamais), et l'active reellement.

CREATE OR REPLACE FUNCTION public.platform_set_subscription(
    p_company      UUID,
    p_plan         TEXT DEFAULT NULL,
    p_period       TEXT DEFAULT NULL,
    p_amount       INTEGER DEFAULT NULL,
    p_status       TEXT DEFAULT NULL,
    p_end          TIMESTAMPTZ DEFAULT NULL,
    p_clear_amount BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id     UUID;
    v_env    TEXT;
    v_statut TEXT := upper(NULLIF(btrim(COALESCE(p_status, '')), ''));
    v_per    TEXT := upper(NULLIF(btrim(COALESCE(p_period, '')), ''));
    v_plan   TEXT := lower(NULLIF(btrim(COALESCE(p_plan,   '')), ''));
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    IF v_statut IS NOT NULL AND v_statut NOT IN ('TRIAL','PENDING_PAYMENT','ACTIVE','PAST_DUE','EXPIRED','SUSPENDED','CANCELLED') THEN
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

    SELECT billing_environment INTO v_env FROM public.companies WHERE id = p_company;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entreprise inconnue.';
    END IF;

    SELECT id INTO v_id
      FROM public.company_subscriptions
     WHERE company_id = p_company
       AND status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','EXPIRED')
     ORDER BY created_at DESC
     LIMIT 1;

    IF v_id IS NULL THEN
        INSERT INTO public.company_subscriptions
               (company_id, plan_code, status, billing_period, amount_fcfa, started_at,
                current_period_start, current_period_end, environment, provider)
        VALUES (p_company, v_plan,
                COALESCE(v_statut, 'ACTIVE'),
                COALESCE(v_per, 'MONTHLY'),
                CASE WHEN p_clear_amount THEN NULL ELSE p_amount END,
                NOW(), NOW(), p_end, v_env, 'MANUAL')
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
               environment        = v_env,
               updated_at         = NOW()
         WHERE id = v_id;
    END IF;

    -- Le plan affiche sur la fiche entreprise doit suivre l'abonnement, sinon
    -- `companies.plan` et l'abonnement racontent deux histoires differentes.
    IF v_plan IS NOT NULL THEN
        UPDATE public.companies SET plan = v_plan, updated_at = NOW() WHERE id = p_company;
    END IF;

    -- Un abonnement active a la main ouvre l'entreprise qui attendait son paiement.
    IF v_statut = 'ACTIVE' THEN
        UPDATE public.companies SET status = 'active', updated_at = NOW()
         WHERE id = p_company AND lower(COALESCE(status, 'active')) IN ('pending_payment', 'expired');
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'abonnement_id', v_id);
END;
$$;

-- Les champs de facturation ne se modifient pas depuis le navigateur.
CREATE OR REPLACE FUNCTION public.companies_champs_reserves()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NOT public.appel_direct_client() OR public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.max_employees IS DISTINCT FROM OLD.max_employees
       OR NEW.billing_environment IS DISTINCT FROM OLD.billing_environment
       OR NEW.billing_legacy IS DISTINCT FROM OLD.billing_legacy THEN
        RAISE EXCEPTION 'L''abonnement de l''entreprise est géré par Timora.'
            USING ERRCODE = '42501', HINT = 'ABONNEMENT_RESERVE';
    END IF;

    IF NEW.company_code IS DISTINCT FROM OLD.company_code THEN
        RAISE EXCEPTION 'Le code entreprise se régénère depuis le cockpit, par le propriétaire.'
            USING ERRCODE = '42501', HINT = 'CODE_RESERVE';
    END IF;

    IF NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.onboarding_completed IS DISTINCT FROM OLD.onboarding_completed THEN
        RAISE EXCEPTION 'Champ réservé.'
            USING ERRCODE = '42501', HINT = 'CHAMP_RESERVE';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
