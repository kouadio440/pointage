-- =============================================================================
--  MIGRATION 033 — PAIEMENT DE PRODUCTION
-- =============================================================================
--
--  Timora encaisse ses abonnements chez JoonaPay (production) par un serveur de
--  paiement dedie, a IP fixe (payments.timora.tech). Ce serveur est le SEUL a
--  parler a JoonaPay et le SEUL a appeler les fonctions de paiement ci-dessous
--  (cle de service). Le navigateur n'envoie qu'un code de formule.
--
--  CONTENU
--    1. Paiements : tarif normal / montant debite / test de production, moyen
--       de paiement ; traces financieres protegees (ON DELETE RESTRICT)
--    2. Journal de facturation en AJOUT SEUL
--    3. Webhooks recus : anti-rejeu par empreinte du corps signe
--    4. Test de production unique (100 XOF, usage unique, compte autorise)
--    5. Limites par formule : collaborateurs, sites, administrateurs
--    6. Recus de paiement (TIM-REC-AAAA-NNNNNN) et stockage prive
--    7. Preparer / consulter un paiement (serveur de paiement, v2)
--    8. Appliquer un etat confirme par JoonaPay (activation atomique, test
--       consomme, recu emis)
--    9. Historique de facturation du cockpit (ses propres paiements)
--   10. Expiration des abonnements, rapprochement des paiements en attente
--   11. Droits : le navigateur n'appelle plus les fonctions de paiement
--
--  Idempotente : peut etre rejouee. Aucune donnee n'est supprimee.
--  RETOUR ARRIERE : supabase_migration_033_paiement_production_retour.sql
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.billing_payments') IS NULL OR to_regclass('public.billing_settings') IS NULL THEN
        RAISE EXCEPTION 'La migration 031 doit etre appliquee avant la 033.';
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1. PAIEMENTS : TARIF NORMAL, MONTANT DEBITE, TEST DE PRODUCTION
-- -----------------------------------------------------------------------------

ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS normal_amount  INTEGER;
ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS is_smoke_test  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.billing_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;

UPDATE public.billing_payments SET normal_amount = amount WHERE normal_amount IS NULL;
ALTER TABLE public.billing_payments ALTER COLUMN normal_amount SET NOT NULL;

ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_montant_normal_check;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_montant_normal_check
    CHECK (is_smoke_test OR amount = normal_amount);

ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_test_production_check;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_test_production_check
    CHECK (NOT is_smoke_test
           OR (environment = 'production' AND plan_code = 'essentiel'
               AND billing_period = 'MONTHLY' AND amount < normal_amount));

ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_moyen_check;
ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_moyen_check
    CHECK (payment_method IS NULL OR payment_method ~ '^[A-Z0-9_]{2,40}$');

COMMENT ON COLUMN public.billing_payments.amount IS
    'Montant REELLEMENT demande a JoonaPay, en XOF (montant debite).';
COMMENT ON COLUMN public.billing_payments.normal_amount IS
    'Tarif catalogue de la formule et de la periode, en XOF.';
COMMENT ON COLUMN public.billing_payments.is_smoke_test IS
    'Test de production controle : montant reduit, usage unique (billing_smoke_test).';
COMMENT ON COLUMN public.billing_payments.payment_method IS
    'Moyen de paiement annonce par JoonaPay (ex. WAVE_CI), sans donnee personnelle.';

-- Une entreprise qui a des traces financieres ne se supprime plus : la
-- suppression en cascade effacait paiements, grand livre et factures.
DO $$
DECLARE
    v RECORD;
BEGIN
    FOR v IN
        SELECT c.conrelid::regclass AS t, c.conname
          FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.confrelid = 'public.companies'::regclass
           AND c.conrelid IN ('public.billing_payments'::regclass,
                              'public.platform_payments'::regclass,
                              'public.platform_invoices'::regclass)
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v.t, v.conname);
    END LOOP;
END;
$$;

ALTER TABLE public.billing_payments ADD CONSTRAINT billing_payments_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE public.platform_payments ADD CONSTRAINT platform_payments_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;
ALTER TABLE public.platform_invoices ADD CONSTRAINT platform_invoices_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;

-- Seules les fonctions ci-dessous exposent un paiement, et seulement les
-- champs utiles : plus de lecture directe de la table par le navigateur.
DROP POLICY IF EXISTS billing_payments_lecture ON public.billing_payments;
REVOKE ALL ON TABLE public.billing_payments FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. JOURNAL DE FACTURATION EN AJOUT SEUL
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v TEXT;
BEGIN
    FOR v IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'public.billing_events'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) ILIKE '%event%'
    LOOP
        EXECUTE format('ALTER TABLE public.billing_events DROP CONSTRAINT %I', v);
    END LOOP;
END;
$$;

ALTER TABLE public.billing_events ADD CONSTRAINT billing_events_event_check
    CHECK (event ~ '^[A-Z][A-Z0-9_]{2,63}$');

CREATE OR REPLACE FUNCTION public.billing_events_ajout_seul()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Le journal de facturation est en ajout seul : aucune ligne ne se modifie ni ne se supprime.'
        USING ERRCODE = 'TM403', HINT = 'JOURNAL_IMMUABLE';
END;
$$;

DROP TRIGGER IF EXISTS billing_events_ajout_seul ON public.billing_events;
CREATE TRIGGER billing_events_ajout_seul
    BEFORE UPDATE OR DELETE ON public.billing_events
    FOR EACH ROW EXECUTE FUNCTION public.billing_events_ajout_seul();

DROP TRIGGER IF EXISTS billing_events_ajout_seul_vidage ON public.billing_events;
CREATE TRIGGER billing_events_ajout_seul_vidage
    BEFORE TRUNCATE ON public.billing_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.billing_events_ajout_seul();

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.billing_events FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. WEBHOOKS RECUS : ANTI-REJEU
-- -----------------------------------------------------------------------------
--  Cle : empreinte SHA-256 du corps BRUT, dont la signature JoonaPay a ete
--  verifiee. Un meme evenement rejoue n'est traite qu'une fois ; un traitement
--  interrompu (base ou JoonaPay indisponible) peut etre repris.

CREATE TABLE IF NOT EXISTS public.billing_webhook_receipts (
    payload_sha256      TEXT PRIMARY KEY CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts            INTEGER NOT NULL DEFAULT 1,
    event               TEXT,
    provider_payment_id TEXT,
    internal_reference  TEXT,
    processed_at        TIMESTAMPTZ,
    result              TEXT
);

ALTER TABLE public.billing_webhook_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_webhook_receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.billing_webhook_register(
    p_sha256              TEXT,
    p_event               TEXT,
    p_provider_payment_id TEXT,
    p_reference           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    IF lower(COALESCE(p_sha256, '')) !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Empreinte invalide.' USING ERRCODE = 'TM422', HINT = 'EMPREINTE_INVALIDE';
    END IF;

    INSERT INTO public.billing_webhook_receipts (payload_sha256, event, provider_payment_id, internal_reference)
    VALUES (lower(p_sha256), left(p_event, 60), left(p_provider_payment_id, 64), left(p_reference, 64))
    ON CONFLICT (payload_sha256) DO UPDATE
        SET attempts = public.billing_webhook_receipts.attempts + 1
    RETURNING processed_at, attempts INTO v;

    RETURN jsonb_build_object('deja_traite', v.processed_at IS NOT NULL, 'tentatives', v.attempts);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_webhook_mark_processed(p_sha256 TEXT, p_result TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.billing_webhook_receipts
       SET processed_at = COALESCE(processed_at, NOW()),
           result = left(regexp_replace(COALESCE(p_result, ''), '[^A-Za-z0-9_]', '', 'g'), 40)
     WHERE payload_sha256 = lower(p_sha256);
$$;

REVOKE ALL ON FUNCTION public.billing_webhook_register(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_webhook_mark_processed(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_webhook_register(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_webhook_mark_processed(TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. TEST DE PRODUCTION UNIQUE (100 XOF)
-- -----------------------------------------------------------------------------
--  Verifie toute la chaine avec un vrai paiement minime. Ce n'est PAS un prix :
--  le catalogue, la page d'accueil et le checkout normal restent a 15 000 XOF.
--
--  Le montant reduit n'est applique que si TOUT est vrai :
--    - test active ici ET sur le serveur de paiement (PRODUCTION_SMOKE_TEST_ENABLED) ;
--    - facturation en mode production ;
--    - compte authentifie, adresse verifiee, dont l'empreinte (SHA-256 de
--      l'adresse normalisee, jamais l'adresse en clair) est celle autorisee ;
--    - son entreprise en attente de paiement (la premiere qui l'utilise lui
--      est liee) ;
--    - formule Essentiel, mensuelle ;
--    - test jamais consomme (usage unique).
--  Sinon : tarif normal. Une fois le paiement confirme, le test est consomme,
--  desactive, et ne se rearme plus jamais.

CREATE TABLE IF NOT EXISTS public.billing_smoke_test (
    id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    enabled              BOOLEAN NOT NULL DEFAULT FALSE,
    amount               INTEGER NOT NULL DEFAULT 100 CHECK (amount BETWEEN 100 AND 999),
    max_uses             INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 0 AND 1),
    uses                 INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
    allowed_email_sha256 TEXT CHECK (allowed_email_sha256 IS NULL OR allowed_email_sha256 ~ '^[0-9a-f]{64}$'),
    bound_company_id     UUID,
    reserved_payment_id  UUID,
    consumed             BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_payment_id  UUID,
    consumed_at          TIMESTAMPTZ,
    enabled_at           TIMESTAMPTZ,
    disabled_at          TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT billing_smoke_test_consomme_check
        CHECK (NOT consumed OR (consumed_payment_id IS NOT NULL AND consumed_at IS NOT NULL)),
    CONSTRAINT billing_smoke_test_actif_ou_consomme_check
        CHECK (NOT (enabled AND consumed))
);

INSERT INTO public.billing_smoke_test (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.billing_smoke_test ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_smoke_test FROM PUBLIC, anon, authenticated;

/** Un test consomme ne se reactive, ne se remet a zero, ni ne se supprime. */
CREATE OR REPLACE FUNCTION public.billing_smoke_test_verrou()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Le test de production ne se supprime pas.'
            USING ERRCODE = 'TM403', HINT = 'SMOKE_TEST_PROTEGE';
    END IF;
    IF OLD.consumed AND (NOT NEW.consumed OR NEW.enabled OR NEW.uses < OLD.uses
                         OR NEW.consumed_payment_id IS DISTINCT FROM OLD.consumed_payment_id) THEN
        RAISE EXCEPTION 'Le test de production a déjà été consommé : il ne se réactive pas.'
            USING ERRCODE = 'TM409', HINT = 'SMOKE_TEST_CONSOMME';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billing_smoke_test_verrou ON public.billing_smoke_test;
CREATE TRIGGER billing_smoke_test_verrou
    BEFORE UPDATE OR DELETE ON public.billing_smoke_test
    FOR EACH ROW EXECUTE FUNCTION public.billing_smoke_test_verrou();

CREATE OR REPLACE FUNCTION public.billing_smoke_test_state()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'enabled',                    s.enabled,
        'consumed',                   s.consumed,
        'uses',                       s.uses,
        'max_uses',                   s.max_uses,
        'amount',                     s.amount,
        'mode_facturation',           public.billing_mode(),
        'compte_autorise_configure',  s.allowed_email_sha256 IS NOT NULL,
        'bound_company_id',           s.bound_company_id,
        'reserved_payment_reference', (SELECT internal_reference FROM public.billing_payments WHERE id = s.reserved_payment_id),
        'consumed_payment_reference', (SELECT internal_reference FROM public.billing_payments WHERE id = s.consumed_payment_id),
        'consumed_at',                s.consumed_at,
        'enabled_at',                 s.enabled_at,
        'disabled_at',                s.disabled_at)
      FROM public.billing_smoke_test s
     WHERE s.id;
$$;

CREATE OR REPLACE FUNCTION public.billing_smoke_test_configure(p_email_sha256 TEXT, p_amount INTEGER DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    IF public.billing_mode() <> 'production' THEN
        RAISE EXCEPTION 'Le test de production suppose la facturation en mode production.'
            USING ERRCODE = 'TM409', HINT = 'MODE_INCOHERENT';
    END IF;
    IF lower(COALESCE(p_email_sha256, '')) !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Empreinte de compte invalide (SHA-256 hexadécimal attendu).'
            USING ERRCODE = 'TM422', HINT = 'EMPREINTE_INVALIDE';
    END IF;

    SELECT * INTO v FROM public.billing_smoke_test WHERE id FOR UPDATE;
    IF v.consumed THEN
        RAISE EXCEPTION 'Le test de production a déjà été consommé : il ne se réactive pas.'
            USING ERRCODE = 'TM409', HINT = 'SMOKE_TEST_CONSOMME';
    END IF;

    UPDATE public.billing_smoke_test
       SET enabled = TRUE, amount = COALESCE(p_amount, 100), max_uses = 1, uses = 0,
           allowed_email_sha256 = lower(p_email_sha256), bound_company_id = NULL,
           reserved_payment_id = NULL, enabled_at = NOW(), disabled_at = NULL
     WHERE id;

    PERFORM public.billing_log('SMOKE_TEST_ENABLED', 'production', NULL,
        jsonb_build_object('amount', COALESCE(p_amount, 100), 'max_uses', 1));
    RETURN public.billing_smoke_test_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_smoke_test_disable()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.billing_smoke_test SET enabled = FALSE, disabled_at = NOW() WHERE id AND enabled;
    IF FOUND THEN
        PERFORM public.billing_log('SMOKE_TEST_DISABLED', public.billing_mode(), NULL, '{}'::JSONB);
    END IF;
    RETURN public.billing_smoke_test_state();
END;
$$;

REVOKE ALL ON FUNCTION public.billing_smoke_test_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_smoke_test_configure(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_smoke_test_disable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_smoke_test_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_smoke_test_configure(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_smoke_test_disable() TO service_role;

-- -----------------------------------------------------------------------------
-- 5. LIMITES PAR FORMULE
-- -----------------------------------------------------------------------------
--  REGLE UNIQUE (catalogue : apps/web/billing/catalogue.js)
--    collaborateurs  = rattachements ACTIFS de role EMPLOYEE ou MANAGER ;
--                      les demandes en attente ne comptent pas (mais leur
--                      nombre est plafonne : anti-spam) ;
--    administrateurs = rattachements ACTIFS OWNER ou ADMIN : le proprietaire
--                      est COMPRIS (Essentiel : le proprietaire seul) ;
--    sites           = zones de pointage (geofences) ACTIVES.
--  Formule Entreprise : limites du contrat (company_subscriptions.seats,
--  max_sites, max_admins) ; NULL = sans limite.
--  Controlees ici, par la base : aucune ecriture, d'ou qu'elle vienne, ne les
--  depasse. Un collaborateur n'est JAMAIS retire automatiquement.

ALTER TABLE public.platform_plans ADD COLUMN IF NOT EXISTS max_sites  INTEGER;
ALTER TABLE public.platform_plans ADD COLUMN IF NOT EXISTS max_admins INTEGER;
ALTER TABLE public.platform_plans DROP CONSTRAINT IF EXISTS platform_plans_limites_check;
ALTER TABLE public.platform_plans ADD CONSTRAINT platform_plans_limites_check
    CHECK ((max_sites IS NULL OR max_sites > 0) AND (max_admins IS NULL OR max_admins > 0));

-- Valeurs du catalogue (verifiees par scripts/check-billing-catalogue.mjs).
UPDATE public.platform_plans p
   SET max_employees = v.employes, max_sites = v.sites, max_admins = v.admins, updated_at = NOW()
  FROM (VALUES
        ('essentiel', 10, 1, 1),
        ('business', 30, 3, 3),
        ('pro', 100, 10, 10),
        ('entreprise', NULL::INTEGER, NULL::INTEGER, NULL::INTEGER)
       ) AS v(code, employes, sites, admins)
 WHERE p.code = v.code;

ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS max_sites  INTEGER;
ALTER TABLE public.company_subscriptions ADD COLUMN IF NOT EXISTS max_admins INTEGER;
COMMENT ON COLUMN public.company_subscriptions.seats IS
    'Formule Entreprise : collaborateurs couverts par le contrat (NULL = sans limite).';

/** Limites en vigueur pour une entreprise (formule de son abonnement). */
CREATE OR REPLACE FUNCTION public.limites_entreprise(p_company UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_etat JSONB := public.etat_abonnement_entreprise(p_company);
    v_plan TEXT := v_etat ->> 'plan';
    v_p    RECORD;
    v_s    RECORD;
BEGIN
    IF v_plan IS NULL THEN
        RETURN jsonb_build_object('plan', NULL, 'plan_name', NULL, 'max_employees', NULL,
                                  'max_sites', NULL, 'max_admins', NULL, 'contractuel', FALSE);
    END IF;

    SELECT code, name, max_employees, max_sites, max_admins INTO v_p
      FROM public.platform_plans WHERE code = v_plan;

    IF v_plan = 'entreprise' THEN
        SELECT s.seats, s.max_sites, s.max_admins INTO v_s
          FROM public.company_subscriptions s
         WHERE s.company_id = p_company AND s.status IN ('ACTIVE', 'PAST_DUE')
         ORDER BY s.updated_at DESC
         LIMIT 1;
        RETURN jsonb_build_object('plan', v_plan, 'plan_name', COALESCE(v_p.name, 'Entreprise'),
                                  'max_employees', v_s.seats, 'max_sites', v_s.max_sites,
                                  'max_admins', v_s.max_admins, 'contractuel', TRUE);
    END IF;

    RETURN jsonb_build_object('plan', v_plan, 'plan_name', COALESCE(v_p.name, v_plan),
                              'max_employees', v_p.max_employees, 'max_sites', v_p.max_sites,
                              'max_admins', v_p.max_admins, 'contractuel', FALSE);
END;
$$;

/** Usage reel d'une entreprise, avec les memes definitions que les limites. */
CREATE OR REPLACE FUNCTION public.usage_entreprise(p_company UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'employees', (SELECT count(*) FROM public.company_memberships m
                       WHERE m.company_id = p_company AND m.status = 'ACTIVE'
                         AND public.normaliser_role_membre(m.role) IN ('EMPLOYEE', 'MANAGER')),
        'admins',    (SELECT count(*) FROM public.company_memberships m
                       WHERE m.company_id = p_company AND m.status = 'ACTIVE'
                         AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')),
        'sites',     (SELECT count(*) FROM public.geofences g
                       WHERE g.company_id = p_company AND COALESCE(g.is_active, TRUE)),
        'pending',   (SELECT count(*) FROM public.company_memberships m
                       WHERE m.company_id = p_company AND m.status IN ('PENDING_APPROVAL', 'INVITED')));
$$;

REVOKE ALL ON FUNCTION public.limites_entreprise(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.usage_entreprise(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.limites_entreprise(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.usage_entreprise(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.controler_limites_membres()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_categorie TEXT;
    v_avant     TEXT;
    v_lim       JSONB;
    v_max       INTEGER;
    v_nb        INTEGER;
    v_nom       TEXT;
BEGIN
    IF NEW.status = 'ACTIVE' THEN
        v_categorie := CASE WHEN public.normaliser_role_membre(NEW.role) IN ('OWNER', 'ADMIN') THEN 'ADMIN' ELSE 'EMPLOYEE' END;

        IF TG_OP = 'UPDATE' THEN
            IF OLD.status = 'ACTIVE' AND OLD.company_id = NEW.company_id THEN
                v_avant := CASE WHEN public.normaliser_role_membre(OLD.role) IN ('OWNER', 'ADMIN') THEN 'ADMIN' ELSE 'EMPLOYEE' END;
                IF v_avant = v_categorie THEN
                    RETURN NEW;   -- rien ne change pour les limites
                END IF;
            END IF;
        END IF;

        -- Deux approbations simultanees ne franchissent pas la limite ensemble.
        PERFORM pg_advisory_xact_lock(hashtextextended('limites_formule:' || NEW.company_id::TEXT, 0));
        v_lim := public.limites_entreprise(NEW.company_id);
        v_nom := COALESCE(v_lim ->> 'plan_name', 'actuelle');

        IF v_categorie = 'ADMIN' THEN
            v_max := (v_lim ->> 'max_admins')::INTEGER;
            IF v_max IS NOT NULL THEN
                SELECT count(*) INTO v_nb FROM public.company_memberships m
                 WHERE m.company_id = NEW.company_id AND m.status = 'ACTIVE' AND m.id IS DISTINCT FROM NEW.id
                   AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN');
                IF v_nb >= v_max THEN
                    RAISE EXCEPTION 'Votre formule % permet %, propriétaire compris.', v_nom,
                        CASE WHEN v_max = 1 THEN '1 administrateur' ELSE 'jusqu''à ' || v_max || ' administrateurs' END
                        USING ERRCODE = 'TM403', HINT = 'PLAN_ADMIN_LIMIT_REACHED';
                END IF;
            END IF;
        ELSE
            v_max := (v_lim ->> 'max_employees')::INTEGER;
            IF v_max IS NOT NULL THEN
                SELECT count(*) INTO v_nb FROM public.company_memberships m
                 WHERE m.company_id = NEW.company_id AND m.status = 'ACTIVE' AND m.id IS DISTINCT FROM NEW.id
                   AND public.normaliser_role_membre(m.role) IN ('EMPLOYEE', 'MANAGER');
                IF v_nb >= v_max THEN
                    RAISE EXCEPTION 'Votre formule % permet jusqu''à % collaborateurs.', v_nom, v_max
                        USING ERRCODE = 'TM403', HINT = 'PLAN_EMPLOYEE_LIMIT_REACHED';
                END IF;
            END IF;
        END IF;

    ELSIF NEW.status IN ('PENDING_APPROVAL', 'INVITED') THEN
        IF TG_OP = 'UPDATE' THEN
            IF OLD.status IN ('PENDING_APPROVAL', 'INVITED') THEN
                RETURN NEW;   -- deja en attente
            END IF;
        END IF;
        -- Anti-spam : les demandes en attente ne comptent pas dans la limite,
        -- mais leur nombre est plafonne.
        v_lim := public.limites_entreprise(NEW.company_id);
        v_max := GREATEST(20, 2 * COALESCE((v_lim ->> 'max_employees')::INTEGER, 50));
        SELECT count(*) INTO v_nb FROM public.company_memberships m
         WHERE m.company_id = NEW.company_id AND m.status IN ('PENDING_APPROVAL', 'INVITED')
           AND m.id IS DISTINCT FROM NEW.id;
        IF v_nb >= v_max THEN
            RAISE EXCEPTION 'Cette entreprise a trop de demandes en attente. Réessayez plus tard.'
                USING ERRCODE = 'TM429', HINT = 'TROP_DE_DEMANDES_EN_ATTENTE';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ad_limites_formule ON public.company_memberships;
CREATE TRIGGER ad_limites_formule
    BEFORE INSERT OR UPDATE ON public.company_memberships
    FOR EACH ROW EXECUTE FUNCTION public.controler_limites_membres();

CREATE OR REPLACE FUNCTION public.controler_limites_sites()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lim JSONB;
    v_max INTEGER;
    v_nb  INTEGER;
BEGIN
    IF COALESCE(NEW.is_active, TRUE) THEN
        IF TG_OP = 'UPDATE' THEN
            IF COALESCE(OLD.is_active, TRUE) AND OLD.company_id = NEW.company_id THEN
                RETURN NEW;   -- site deja actif : rien ne change pour les limites
            END IF;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('limites_formule:' || NEW.company_id::TEXT, 0));
        v_lim := public.limites_entreprise(NEW.company_id);
        v_max := (v_lim ->> 'max_sites')::INTEGER;
        IF v_max IS NOT NULL THEN
            SELECT count(*) INTO v_nb FROM public.geofences g
             WHERE g.company_id = NEW.company_id AND COALESCE(g.is_active, TRUE) AND g.id IS DISTINCT FROM NEW.id;
            IF v_nb >= v_max THEN
                RAISE EXCEPTION 'Votre formule % permet %.', COALESCE(v_lim ->> 'plan_name', 'actuelle'),
                    CASE WHEN v_max = 1 THEN '1 site de pointage' ELSE 'jusqu''à ' || v_max || ' sites de pointage' END
                    USING ERRCODE = 'TM403', HINT = 'PLAN_SITE_LIMIT_REACHED';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ad_limites_formule ON public.geofences;
CREATE TRIGGER ad_limites_formule
    BEFORE INSERT OR UPDATE ON public.geofences
    FOR EACH ROW EXECUTE FUNCTION public.controler_limites_sites();

/** Tarifs publics : les limites s'ajoutent aux prix. */
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
               'max_sites',     p.max_sites,
               'max_admins',    p.max_admins,
               'self_serve',    p.self_serve AND p.monthly_price_fcfa IS NOT NULL
           ) ORDER BY p.sort_order, p.code), '[]'::JSONB)
      FROM public.platform_plans p
     WHERE p.is_active
       AND p.code IN ('essentiel', 'business', 'pro', 'entreprise');
$$;

-- -----------------------------------------------------------------------------
-- 6. RECUS DE PAIEMENT
-- -----------------------------------------------------------------------------
--  « Reçu de paiement Timora », pas « facture » : les mentions legales d'une
--  facture ne sont pas toutes disponibles. Un recu par paiement confirme,
--  emis dans la MEME transaction que l'activation. Numero sequentiel par
--  annee, sans trou : TIM-REC-2026-000001.
--  Les donnees du document sont figees a l'emission ; seuls le fichier PDF et
--  le suivi de l'e-mail evoluent (et l'anonymisation du client).

CREATE TABLE IF NOT EXISTS public.billing_receipt_counters (
    year        INTEGER PRIMARY KEY CHECK (year BETWEEN 2024 AND 2200),
    last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
ALTER TABLE public.billing_receipt_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_receipt_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.billing_receipts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number                TEXT NOT NULL UNIQUE CHECK (number ~ '^TIM-REC-[0-9]{4}-[0-9]{6}$'),
    payment_id            UUID NOT NULL UNIQUE REFERENCES public.billing_payments(id) ON DELETE RESTRICT,
    company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    environment           TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    company_name          TEXT NOT NULL,
    customer_name         TEXT,
    customer_email        TEXT,
    plan_code             TEXT NOT NULL,
    plan_name             TEXT NOT NULL,
    billing_period        TEXT NOT NULL CHECK (billing_period IN ('MONTHLY', 'ANNUAL')),
    period_start          TIMESTAMPTZ,
    period_end            TIMESTAMPTZ,
    amount                INTEGER NOT NULL CHECK (amount > 0),
    normal_amount         INTEGER NOT NULL CHECK (normal_amount > 0),
    currency              TEXT NOT NULL DEFAULT 'XOF' CHECK (currency = 'XOF'),
    is_smoke_test         BOOLEAN NOT NULL DEFAULT FALSE,
    first_activation      BOOLEAN NOT NULL DEFAULT FALSE,
    internal_reference    TEXT NOT NULL,
    provider_reference    TEXT,
    payment_method        TEXT,
    paid_at               TIMESTAMPTZ NOT NULL,
    storage_path          TEXT,
    pdf_sha256            TEXT CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
    pdf_created_at        TIMESTAMPTZ,
    email_status          TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (email_status IN ('PENDING', 'SENT', 'FAILED', 'ABANDONED')),
    email_attempts        INTEGER NOT NULL DEFAULT 0,
    email_last_error      TEXT,
    email_sent_at         TIMESTAMPTZ,
    email_next_attempt_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS billing_receipts_company_idx ON public.billing_receipts (company_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS billing_receipts_a_traiter_idx ON public.billing_receipts (email_next_attempt_at)
    WHERE storage_path IS NULL OR email_status IN ('PENDING', 'FAILED');

ALTER TABLE public.billing_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.billing_receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.billing_receipts_protection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Un reçu de paiement ne se supprime pas.' USING ERRCODE = 'TM403', HINT = 'RECU_PROTEGE';
    END IF;
    IF (NEW.number, NEW.payment_id, NEW.company_id, NEW.issued_at, NEW.environment, NEW.company_name,
        NEW.plan_code, NEW.plan_name, NEW.billing_period, NEW.period_start, NEW.period_end, NEW.amount,
        NEW.normal_amount, NEW.currency, NEW.is_smoke_test, NEW.first_activation, NEW.internal_reference,
        NEW.provider_reference, NEW.payment_method, NEW.paid_at)
       IS DISTINCT FROM
       (OLD.number, OLD.payment_id, OLD.company_id, OLD.issued_at, OLD.environment, OLD.company_name,
        OLD.plan_code, OLD.plan_name, OLD.billing_period, OLD.period_start, OLD.period_end, OLD.amount,
        OLD.normal_amount, OLD.currency, OLD.is_smoke_test, OLD.first_activation, OLD.internal_reference,
        OLD.provider_reference, OLD.payment_method, OLD.paid_at) THEN
        RAISE EXCEPTION 'Les données d''un reçu émis ne se modifient pas.' USING ERRCODE = 'TM403', HINT = 'RECU_PROTEGE';
    END IF;
    -- Anonymisation seulement : le nom et l'adresse du client peuvent etre
    -- effaces (compte supprime), jamais remplaces.
    IF (NEW.customer_name IS DISTINCT FROM OLD.customer_name AND NEW.customer_name IS NOT NULL)
       OR (NEW.customer_email IS DISTINCT FROM OLD.customer_email AND NEW.customer_email IS NOT NULL) THEN
        RAISE EXCEPTION 'Le client d''un reçu ne se modifie pas (anonymisation seulement).'
            USING ERRCODE = 'TM403', HINT = 'RECU_PROTEGE';
    END IF;
    -- Le fichier PDF est depose une seule fois.
    IF OLD.storage_path IS NOT NULL AND NEW.storage_path IS DISTINCT FROM OLD.storage_path THEN
        RAISE EXCEPTION 'Le document d''un reçu est déjà déposé.' USING ERRCODE = 'TM403', HINT = 'RECU_PROTEGE';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS billing_receipts_protection ON public.billing_receipts;
CREATE TRIGGER billing_receipts_protection
    BEFORE UPDATE OR DELETE ON public.billing_receipts
    FOR EACH ROW EXECUTE FUNCTION public.billing_receipts_protection();

/** Emet le recu d'un paiement confirme (interne ; idempotente). */
CREATE OR REPLACE FUNCTION public.billing_emettre_recu(p_payment UUID, p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id      UUID;
    v_p       RECORD;
    v_client  RECORD;
    v_annee   INTEGER;
    v_numero  INTEGER;
    v_premier BOOLEAN;
BEGIN
    SELECT id INTO v_id FROM public.billing_receipts WHERE payment_id = p_payment;
    IF FOUND THEN
        RETURN v_id;
    END IF;

    SELECT p.*, c.name AS company_name, COALESCE(pl.name, p.plan_code) AS plan_name
      INTO v_p
      FROM public.billing_payments p
      JOIN public.companies c ON c.id = p.company_id
      LEFT JOIN public.platform_plans pl ON pl.code = p.plan_code
     WHERE p.id = p_payment;
    IF NOT FOUND OR v_p.status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Reçu impossible : paiement non confirmé.' USING ERRCODE = 'TM409', HINT = 'PAIEMENT_NON_CONFIRME';
    END IF;

    SELECT NULLIF(btrim(u.full_name), '') AS nom, a.email INTO v_client
      FROM auth.users a LEFT JOIN public.users u ON u.id = a.id
     WHERE a.id = v_p.user_id;

    -- Premiere activation de l'entreprise : e-mail de bienvenue.
    v_premier := NOT EXISTS (SELECT 1 FROM public.billing_payments o
                              WHERE o.company_id = v_p.company_id AND o.status = 'COMPLETED' AND o.id <> v_p.id);

    v_annee := extract(YEAR FROM (COALESCE(v_p.completed_at, NOW()) AT TIME ZONE 'Africa/Abidjan'))::INTEGER;
    INSERT INTO public.billing_receipt_counters (year, last_number) VALUES (v_annee, 1)
    ON CONFLICT (year) DO UPDATE SET last_number = public.billing_receipt_counters.last_number + 1
    RETURNING last_number INTO v_numero;

    INSERT INTO public.billing_receipts (
        number, payment_id, company_id, environment, company_name, customer_name, customer_email,
        plan_code, plan_name, billing_period, period_start, period_end, amount, normal_amount, currency,
        is_smoke_test, first_activation, internal_reference, provider_reference, payment_method, paid_at)
    VALUES (
        'TIM-REC-' || v_annee || '-' || lpad(v_numero::TEXT, 6, '0'), v_p.id, v_p.company_id, v_p.environment,
        v_p.company_name, v_client.nom, v_client.email, v_p.plan_code, v_p.plan_name, v_p.billing_period,
        p_debut, p_fin, v_p.amount, v_p.normal_amount, v_p.currency, v_p.is_smoke_test, v_premier,
        v_p.internal_reference, v_p.provider_reference, v_p.payment_method, COALESCE(v_p.completed_at, NOW()))
    RETURNING id INTO v_id;

    PERFORM public.billing_log('INVOICE_CREATED', v_p.environment, v_p.internal_reference,
        jsonb_build_object('receipt', 'TIM-REC-' || v_annee || '-' || lpad(v_numero::TEXT, 6, '0')));
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_emettre_recu(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_emettre_recu(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

/** Donnees d'un recu, pour le document et l'e-mail (serveur de paiement). */
CREATE OR REPLACE FUNCTION public.billing_receipt_json(p_receipt UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'id', r.id, 'number', r.number, 'issued_at', r.issued_at, 'environment', r.environment,
        'company_id', r.company_id, 'company_name', r.company_name,
        'customer_name', r.customer_name, 'customer_email', r.customer_email,
        'plan_code', r.plan_code, 'plan_name', r.plan_name, 'billing_period', r.billing_period,
        'period_start', r.period_start, 'period_end', r.period_end,
        'amount', r.amount, 'normal_amount', r.normal_amount, 'currency', r.currency,
        'is_smoke_test', r.is_smoke_test, 'first_activation', r.first_activation,
        'internal_reference', r.internal_reference, 'provider_reference', r.provider_reference,
        'payment_method', r.payment_method, 'paid_at', r.paid_at,
        'storage_path', r.storage_path, 'email_status', r.email_status, 'email_attempts', r.email_attempts)
      FROM public.billing_receipts r
     WHERE r.id = p_receipt;
$$;

CREATE OR REPLACE FUNCTION public.billing_receipts_a_traiter(p_limit INTEGER DEFAULT 10)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(jsonb_agg(public.billing_receipt_json(x.id)), '[]'::JSONB)
      FROM (SELECT r.id FROM public.billing_receipts r
             WHERE r.storage_path IS NULL
                OR (r.email_status IN ('PENDING', 'FAILED')
                    AND (r.email_next_attempt_at IS NULL OR r.email_next_attempt_at <= NOW()))
             ORDER BY r.issued_at
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)) x;
$$;

CREATE OR REPLACE FUNCTION public.billing_receipt_set_pdf(p_receipt UUID, p_path TEXT, p_sha256 TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT * INTO v FROM public.billing_receipts WHERE id = p_receipt FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reçu inconnu.' USING ERRCODE = 'TM404', HINT = 'RECU_INCONNU';
    END IF;
    IF v.storage_path IS NOT NULL THEN
        RETURN jsonb_build_object('ok', TRUE, 'deja_depose', TRUE, 'storage_path', v.storage_path);
    END IF;
    IF p_path IS NULL OR p_path <> (v.company_id::TEXT || '/' || v.number || '.pdf') THEN
        RAISE EXCEPTION 'Emplacement de reçu invalide.' USING ERRCODE = 'TM422', HINT = 'EMPLACEMENT_INVALIDE';
    END IF;

    UPDATE public.billing_receipts
       SET storage_path = p_path, pdf_sha256 = lower(p_sha256), pdf_created_at = NOW()
     WHERE id = p_receipt;
    RETURN jsonb_build_object('ok', TRUE, 'deja_depose', FALSE, 'storage_path', p_path);
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_receipt_set_email(p_receipt UUID, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v       RECORD;
    v_essai INTEGER;
    v_etat  TEXT;
BEGIN
    SELECT * INTO v FROM public.billing_receipts WHERE id = p_receipt FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reçu inconnu.' USING ERRCODE = 'TM404', HINT = 'RECU_INCONNU';
    END IF;
    IF v.email_status = 'SENT' THEN
        RETURN jsonb_build_object('ok', TRUE, 'email_status', 'SENT', 'deja_envoye', TRUE);
    END IF;

    v_essai := v.email_attempts + 1;
    IF p_ok THEN
        UPDATE public.billing_receipts
           SET email_status = 'SENT', email_attempts = v_essai, email_sent_at = NOW(),
               email_last_error = NULL, email_next_attempt_at = NULL
         WHERE id = p_receipt;
        PERFORM public.billing_log('INVOICE_EMAIL_SENT', v.environment, v.internal_reference,
            jsonb_build_object('receipt', v.number, 'attempt', v_essai));
        RETURN jsonb_build_object('ok', TRUE, 'email_status', 'SENT');
    END IF;

    -- Echec : nouvel essai 2, 4, 8... minutes plus tard (6 heures au plus),
    -- abandon apres 8 essais. Le paiement et l'abonnement ne bougent pas.
    v_etat := CASE WHEN v_essai >= 8 THEN 'ABANDONED' ELSE 'FAILED' END;
    UPDATE public.billing_receipts
       SET email_status = v_etat, email_attempts = v_essai,
           email_last_error = left(regexp_replace(COALESCE(p_error, 'ECHEC'), '[^A-Za-z0-9_ .:-]', '', 'g'), 160),
           email_next_attempt_at = CASE WHEN v_etat = 'FAILED'
                                        THEN NOW() + LEAST(INTERVAL '6 hours', INTERVAL '1 minute' * power(2, v_essai))
                                   END
     WHERE id = p_receipt;
    PERFORM public.billing_log('INVOICE_EMAIL_FAILED', v.environment, v.internal_reference,
        jsonb_build_object('receipt', v.number, 'attempt', v_essai, 'final', v_etat = 'ABANDONED',
                           'error', left(COALESCE(p_error, ''), 80)));
    RETURN jsonb_build_object('ok', TRUE, 'email_status', v_etat);
END;
$$;

REVOKE ALL ON FUNCTION public.billing_receipt_json(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_receipts_a_traiter(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_receipt_set_pdf(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_receipt_set_email(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_receipt_json(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_receipts_a_traiter(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_receipt_set_pdf(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_receipt_set_email(UUID, BOOLEAN, TEXT) TO service_role;

-- Stockage PRIVE des recus : billing-receipts/<entreprise>/<numero>.pdf.
-- Lecture (lien signe, a duree limitee) : proprietaire et administrateurs de
-- l'entreprise, administrateurs de la plateforme. Aucune ecriture depuis le
-- navigateur : seul le serveur de paiement (cle de service) depose.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('billing-receipts', 'billing-receipts', FALSE, 1048576, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
    SET public = FALSE, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.uuid_ou_null(p_texte TEXT)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    RETURN p_texte::UUID;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;

DROP POLICY IF EXISTS billing_receipts_lecture ON storage.objects;
CREATE POLICY billing_receipts_lecture ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'billing-receipts'
           AND (public.can_configure_company(public.uuid_ou_null((storage.foldername(name))[1]))
                OR public.is_platform_admin()));

-- -----------------------------------------------------------------------------
-- 7. PREPARER / CONSULTER UN PAIEMENT (SERVEUR DE PAIEMENT, CLE DE SERVICE)
-- -----------------------------------------------------------------------------
--  Le serveur de paiement a verifie le jeton de session aupres de Supabase
--  Auth ; il transmet l'identifiant du compte. La base relit le compte
--  (adresse verifiee, non banni), puis applique les MEMES regles qu'en 031 :
--  entreprise deduite des droits, montant lu dans les tarifs, idempotence.

/**
 * Identite de travail pour les controles existants (auth.uid(), auth.email()),
 * le temps de la transaction en cours. Interne : appelee par les fonctions v2.
 */
CREATE OR REPLACE FUNCTION public.billing_agir_pour(p_user UUID, OUT user_id UUID, OUT user_email TEXT)
RETURNS RECORD
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v RECORD;
BEGIN
    SELECT a.id, a.email, a.email_confirmed_at, a.banned_until, a.deleted_at INTO v
      FROM auth.users a WHERE a.id = p_user;
    IF NOT FOUND OR v.email_confirmed_at IS NULL OR v.deleted_at IS NOT NULL
       OR (v.banned_until IS NOT NULL AND v.banned_until > NOW()) THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501', HINT = 'SESSION_INVALIDE';
    END IF;
    -- Portee : la transaction en cours (is_local = TRUE). Les reglages
    -- « claim.* » sont vides pour qu'auth.uid() et auth.email() lisent le JSON.
    PERFORM set_config('request.jwt.claims',
        jsonb_build_object('sub', v.id, 'email', v.email, 'role', 'authenticated')::TEXT, TRUE);
    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claim.email', '', TRUE);
    user_id := v.id;
    user_email := v.email;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_agir_pour(UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.billing_prepare_checkout_v2(
    p_user        UUID,
    p_plan        TEXT,
    p_period      TEXT,
    p_environment TEXT,
    p_allow_smoke BOOLEAN DEFAULT FALSE,
    p_company     UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_compte     RECORD;
    v_plan       TEXT := lower(btrim(COALESCE(p_plan, '')));
    v_periode    TEXT := upper(btrim(COALESCE(p_period, 'MONTHLY')));
    v_env        TEXT := lower(btrim(COALESCE(p_environment, '')));
    v_nb         INT;
    v_company    RECORD;
    v_tarif      RECORD;
    v_normal     INTEGER;
    v_montant    INTEGER;
    v_est_test   BOOLEAN := FALSE;
    v_etat       JSONB;
    v_prix_actuel INTEGER;
    v_usage      JSONB;
    v_depasse    TEXT[] := ARRAY[]::TEXT[];
    v_test       RECORD;
    v_existant   RECORD;
    v_reference  TEXT;
    v_paiement   RECORD;
    v_client     RECORD;
BEGIN
    SELECT a.user_id AS id, a.user_email AS email INTO v_compte FROM public.billing_agir_pour(p_user) a;

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
    IF v_env = 'sandbox' AND NOT public.is_platform_admin(v_compte.id) AND NOT EXISTS (
        SELECT 1 FROM public.billing_settings s
         WHERE lower(COALESCE(v_compte.email, '')) = ANY (SELECT lower(t) FROM unnest(s.testeurs_sandbox) t)
    ) THEN
        RAISE EXCEPTION 'Le paiement en ligne n''est pas encore ouvert. Votre entreprise est enregistrée : revenez bientôt pour l''activer.'
            USING ERRCODE = 'TM403', HINT = 'PAIEMENT_PAS_ENCORE_OUVERT';
    END IF;

    -- Entreprise : celle que le compte administre. Un identifiant fourni n'est
    -- accepte que s'il figure parmi ses propres rattachements.
    SELECT count(*) INTO v_nb
      FROM public.company_memberships m
     WHERE m.user_id = v_compte.id AND m.status = 'ACTIVE'
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
     WHERE m.user_id = v_compte.id AND m.status = 'ACTIVE'
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

    SELECT code, name, monthly_price_fcfa, annual_price_fcfa, currency, self_serve, is_active,
           max_employees, max_sites, max_admins
      INTO v_tarif
      FROM public.platform_plans WHERE code = v_plan;
    IF NOT FOUND OR NOT v_tarif.is_active OR NOT v_tarif.self_serve THEN
        RAISE EXCEPTION 'Cette formule ne se souscrit pas en ligne.'
            USING ERRCODE = 'TM422', HINT = 'FORMULE_INDISPONIBLE';
    END IF;

    v_normal := CASE WHEN v_periode = 'ANNUAL' THEN v_tarif.annual_price_fcfa ELSE v_tarif.monthly_price_fcfa END;
    IF v_normal IS NULL OR v_normal < 100 THEN
        RAISE EXCEPTION 'Cette formule n''a pas de tarif en ligne.'
            USING ERRCODE = 'TM422', HINT = 'FORMULE_INDISPONIBLE';
    END IF;

    -- Abonnement en cours, loin de l'echeance : seule une formule SUPERIEURE
    -- s'achete tout de suite (elle s'applique des le paiement) ; le
    -- renouvellement et le passage a une formule inferieure s'ouvrent 7 jours
    -- avant l'echeance.
    v_etat := public.etat_abonnement_entreprise(v_company.id);
    IF v_etat ->> 'etat' = 'ACTIVE' AND NOT (v_etat ->> 'heritee')::BOOLEAN
       AND (v_etat ->> 'fin') IS NOT NULL
       AND (v_etat ->> 'fin')::TIMESTAMPTZ > NOW() + INTERVAL '7 days' THEN
        SELECT monthly_price_fcfa INTO v_prix_actuel FROM public.platform_plans WHERE code = v_etat ->> 'plan';
        IF v_prix_actuel IS NULL OR v_tarif.monthly_price_fcfa <= v_prix_actuel THEN
            RAISE EXCEPTION 'Votre abonnement est déjà actif. Le renouvellement et le passage à une formule inférieure s''ouvrent 7 jours avant l''échéance.'
                USING ERRCODE = 'TM409', HINT = 'DEJA_ACTIF';
        END IF;
    END IF;

    -- Formule trop petite pour l'usage reel : refusee. Aucun collaborateur,
    -- site ni administrateur n'est jamais retire automatiquement.
    v_usage := public.usage_entreprise(v_company.id);
    IF v_tarif.max_employees IS NOT NULL AND (v_usage ->> 'employees')::INT > v_tarif.max_employees THEN
        v_depasse := v_depasse || ((v_usage ->> 'employees') || ' collaborateurs actifs (' || v_tarif.max_employees || ' inclus)');
    END IF;
    IF v_tarif.max_sites IS NOT NULL AND (v_usage ->> 'sites')::INT > v_tarif.max_sites THEN
        v_depasse := v_depasse || ((v_usage ->> 'sites') || ' sites actifs (' || v_tarif.max_sites || ' inclus)');
    END IF;
    IF v_tarif.max_admins IS NOT NULL AND (v_usage ->> 'admins')::INT > v_tarif.max_admins THEN
        v_depasse := v_depasse || ((v_usage ->> 'admins') || ' administrateurs (' || v_tarif.max_admins || ' inclus)');
    END IF;
    IF array_length(v_depasse, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'La formule % ne couvre pas votre usage actuel : %. Choisissez une formule supérieure.',
            v_tarif.name, array_to_string(v_depasse, ', ')
            USING ERRCODE = 'TM409', HINT = 'PLAN_DOWNGRADE_BLOCKED';
    END IF;

    -- Test de production unique : TOUTES les conditions, sinon tarif normal.
    v_montant := v_normal;
    IF COALESCE(p_allow_smoke, FALSE) AND v_env = 'production' AND v_plan = 'essentiel'
       AND v_periode = 'MONTHLY' AND v_company.status = 'pending_payment' THEN
        SELECT * INTO v_test FROM public.billing_smoke_test WHERE id FOR UPDATE;
        IF v_test.enabled AND NOT v_test.consumed AND v_test.uses < v_test.max_uses
           AND v_test.allowed_email_sha256 IS NOT NULL
           AND v_test.allowed_email_sha256 = public.empreinte_email(v_compte.email)
           AND (v_test.bound_company_id IS NULL OR v_test.bound_company_id = v_company.id)
           AND v_test.amount < v_normal
           AND NOT EXISTS (SELECT 1 FROM public.billing_payments bp WHERE bp.is_smoke_test AND bp.status = 'COMPLETED') THEN
            v_est_test := TRUE;
            v_montant := v_test.amount;
        END IF;
    END IF;

    -- Idempotence : un verrou par entreprise ; un paiement identique en cours
    -- (moins de 45 minutes) est reutilise.
    PERFORM pg_advisory_xact_lock(hashtextextended('billing_checkout:' || v_company.id::TEXT, 0));

    SELECT id, internal_reference, checkout_url, status, created_at, amount, normal_amount, is_smoke_test,
           plan_code, billing_period
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
           AND v_existant.amount = v_montant AND v_existant.is_smoke_test = v_est_test THEN
            IF v_existant.checkout_url IS NOT NULL THEN
                RETURN jsonb_build_object('action', 'REDIRECT', 'reference', v_existant.internal_reference,
                                          'checkout_url', v_existant.checkout_url,
                                          'amount', v_existant.amount, 'normal_amount', v_existant.normal_amount,
                                          'is_smoke_test', v_existant.is_smoke_test, 'currency', 'XOF');
            ELSIF v_existant.created_at > NOW() - INTERVAL '2 minutes' THEN
                RETURN jsonb_build_object('action', 'IN_PROGRESS', 'reference', v_existant.internal_reference);
            END IF;
        END IF;

        -- Autre formule, autre montant, ou creation abandonnee : l'ancien
        -- checkout est clos, un seul paiement reste ouvert a la fois.
        UPDATE public.billing_payments
           SET status = 'CANCELLED', failure_code = 'REMPLACE_PAR_UN_NOUVEAU_PAIEMENT', updated_at = NOW()
         WHERE id = v_existant.id AND status = 'PENDING';
    END IF;

    IF (SELECT count(*) FROM public.billing_payments
         WHERE company_id = v_company.id AND created_at > NOW() - INTERVAL '10 minutes') >= 6 THEN
        RAISE EXCEPTION 'Trop de tentatives de paiement. Réessayez dans quelques minutes.'
            USING ERRCODE = 'TM429', HINT = 'TROP_DE_TENTATIVES';
    END IF;

    v_reference := 'TIMORA-SUB-' || to_char(NOW() AT TIME ZONE 'Africa/Abidjan', 'YYYYMMDD') || '-'
                   || upper(substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8));

    INSERT INTO public.billing_payments (company_id, user_id, environment, plan_code, billing_period,
                                         amount, normal_amount, is_smoke_test, currency, internal_reference, status)
    VALUES (v_company.id, v_compte.id, v_env, v_plan, v_periode, v_montant, v_normal, v_est_test,
            'XOF', v_reference, 'PENDING')
    RETURNING id, internal_reference INTO v_paiement;

    IF v_est_test THEN
        UPDATE public.billing_smoke_test
           SET bound_company_id = v_company.id, reserved_payment_id = v_paiement.id
         WHERE id;
    END IF;

    SELECT u.full_name, u.phone_number INTO v_client FROM public.users u WHERE u.id = v_compte.id;

    PERFORM public.billing_log('PAYMENT_CREATED', v_env, v_reference,
        jsonb_build_object('plan', v_plan, 'period', v_periode, 'amount', v_montant,
                           'normal_amount', v_normal, 'smoke_test', v_est_test));

    RETURN jsonb_build_object(
        'action',          'CREATE',
        'payment_id',      v_paiement.id,
        'reference',       v_paiement.internal_reference,
        'amount',          v_montant,
        'normal_amount',   v_normal,
        'is_smoke_test',   v_est_test,
        'currency',        'XOF',
        'plan',            v_plan,
        'plan_name',       v_tarif.name,
        'period',          v_periode,
        'company_id',      v_company.id,
        'company_name',    v_company.name,
        'company_country', v_company.country,
        'customer',        jsonb_build_object(
                               'name',  COALESCE(NULLIF(btrim(v_client.full_name), ''), 'Client Timora'),
                               'email', v_compte.email,
                               'phone', v_client.phone_number)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_prepare_checkout_v2(UUID, TEXT, TEXT, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_prepare_checkout_v2(UUID, TEXT, TEXT, TEXT, BOOLEAN, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.billing_payment_status_v2(p_user UUID, p_reference TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_compte RECORD;
    v_p      RECORD;
    v_r      RECORD;
BEGIN
    SELECT a.user_id AS id, a.user_email AS email INTO v_compte FROM public.billing_agir_pour(p_user) a;

    SELECT p.*, c.name AS company_name INTO v_p
      FROM public.billing_payments p
      JOIN public.companies c ON c.id = p.company_id
     WHERE p.internal_reference = p_reference;

    -- Reference inconnue et reference d'une autre entreprise : meme reponse,
    -- on ne revele pas l'existence d'un paiement (anti-IDOR).
    IF NOT FOUND OR NOT (public.can_configure_company(v_p.company_id) OR v_p.user_id = v_compte.id) THEN
        RAISE EXCEPTION 'Paiement introuvable.' USING ERRCODE = 'TM404', HINT = 'PAIEMENT_INCONNU';
    END IF;

    SELECT number, storage_path IS NOT NULL AS pret, email_status INTO v_r
      FROM public.billing_receipts WHERE payment_id = v_p.id;

    RETURN jsonb_build_object(
        'reference',              v_p.internal_reference,
        'status',                 v_p.status,
        'plan',                   v_p.plan_code,
        'period',                 v_p.billing_period,
        'amount',                 v_p.amount,
        'normal_amount',          v_p.normal_amount,
        'is_smoke_test',          v_p.is_smoke_test,
        'currency',               v_p.currency,
        'environment',            v_p.environment,
        'company_id',             v_p.company_id,
        'company_name',           v_p.company_name,
        'failure_code',           v_p.failure_code,
        'provider_payment_id',    v_p.provider_payment_id,
        'checkout_url',           CASE WHEN v_p.status IN ('PENDING', 'PROCESSING') THEN v_p.checkout_url END,
        'last_provider_check_at', v_p.last_provider_check_at,
        'created_at',             v_p.created_at,
        'completed_at',           v_p.completed_at,
        'receipt',                CASE WHEN v_r.number IS NULL THEN NULL
                                       ELSE jsonb_build_object('number', v_r.number, 'ready', v_r.pret,
                                                               'email_status', v_r.email_status) END,
        'subscription',           public.etat_abonnement_entreprise(v_p.company_id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_payment_status_v2(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_payment_status_v2(UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 8. APPLIQUER UN ETAT CONFIRME PAR JOONAPAY — ATOMIQUE ET IDEMPOTENT
-- -----------------------------------------------------------------------------
--  Meme contrat qu'en 031, plus :
--    - montant ET montant paye controles contre le montant REELLEMENT
--      demande (AMOUNT_MISMATCH), devise XOF (CURRENCY_MISMATCH) ;
--    - test de production : consomme et desactive dans la MEME transaction
--      que l'activation ; un second paiement de test est encaisse et trace
--      (DUPLICATE_PAYMENT), sans nouvelle activation ;
--    - recu emis dans la MEME transaction (jamais « paye » sans recu, jamais
--      de recu sans activation).
--  Tout echoue ou tout reussit : paiement COMPLETED, abonnement ACTIVE,
--  entreprise active, grand livre, recu, journal.

DROP FUNCTION IF EXISTS public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.billing_apply_provider_status(
    p_environment         TEXT,
    p_provider_payment_id TEXT,
    p_merchant_reference  TEXT,
    p_status              TEXT,
    p_payment_status      TEXT,
    p_amount              NUMERIC,
    p_paid_amount         NUMERIC,
    p_currency            TEXT,
    p_source              TEXT DEFAULT 'webhook',
    p_payment_method      TEXT DEFAULT NULL
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
    v_moyen      TEXT := NULLIF(upper(regexp_replace(COALESCE(p_payment_method, ''), '[^A-Za-z0-9_]', '', 'g')), '');
    v_nouveau    TEXT;
    v_abo        RECORD;
    v_debut      TIMESTAMPTZ;
    v_fin        TIMESTAMPTZ;
    v_abo_id     UUID;
    v_max        INTEGER;
    v_test       RECORD;
    v_recu       UUID;
    v_numero     TEXT;
BEGIN
    IF v_moyen IS NOT NULL AND v_moyen !~ '^[A-Z0-9_]{2,40}$' THEN
        v_moyen := NULL;
    END IF;

    SELECT * INTO v_p FROM public.billing_payments
     WHERE provider_payment_id = p_provider_payment_id
     FOR UPDATE;

    IF NOT FOUND THEN
        PERFORM public.billing_log('UNKNOWN_PAYMENT', p_environment, left(p_merchant_reference, 64),
            jsonb_build_object('source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'PAIEMENT_INCONNU');
    END IF;

    -- La reference Timora renvoyee par JoonaPay doit etre la notre.
    IF p_merchant_reference IS NOT NULL AND p_merchant_reference <> v_p.internal_reference THEN
        PERFORM public.billing_log('ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'REFERENCE_INCOHERENTE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'REFERENCE_INCOHERENTE', 'reference', v_p.internal_reference);
    END IF;

    IF v_p.environment <> p_environment THEN
        PERFORM public.billing_log('ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'ENVIRONNEMENT_INCOMPATIBLE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'ENVIRONNEMENT_INCOMPATIBLE', 'reference', v_p.internal_reference);
    END IF;

    UPDATE public.billing_payments
       SET provider_status = NULLIF(v_statut, ''), provider_payment_status = NULLIF(v_financier, ''),
           payment_method = COALESCE(v_moyen, payment_method),
           last_provider_check_at = NOW(), updated_at = NOW()
     WHERE id = v_p.id;

    -- Deja applique : rien a refaire.
    IF v_p.status = 'COMPLETED' THEN
        SELECT r.id, r.number INTO v_recu, v_numero FROM public.billing_receipts r WHERE r.payment_id = v_p.id;
        RETURN jsonb_build_object('ok', TRUE, 'status', 'COMPLETED', 'deja_traite', TRUE,
                                  'reference', v_p.internal_reference, 'company_id', v_p.company_id,
                                  'receipt_id', v_recu, 'receipt_number', v_numero,
                                  'is_smoke_test', v_p.is_smoke_test);
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
            PERFORM public.billing_log('PAYMENT_FAILED', p_environment, v_p.internal_reference,
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
        UPDATE public.billing_payments SET status = 'PROCESSING', failure_code = 'CURRENCY_MISMATCH', updated_at = NOW()
         WHERE id = v_p.id;
        PERFORM public.billing_log('CURRENCY_MISMATCH', p_environment, v_p.internal_reference,
            jsonb_build_object('attendue', v_p.currency, 'recue', left(p_currency, 8), 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'CURRENCY_MISMATCH', 'reference', v_p.internal_reference);
    END IF;

    IF v_paye IS NULL OR v_paye <> v_p.amount OR (p_amount IS NOT NULL AND p_amount <> v_p.amount) THEN
        UPDATE public.billing_payments SET status = 'PROCESSING', failure_code = 'AMOUNT_MISMATCH', updated_at = NOW()
         WHERE id = v_p.id;
        PERFORM public.billing_log('AMOUNT_MISMATCH', p_environment, v_p.internal_reference,
            jsonb_build_object('attendu', v_p.amount, 'annonce', p_amount, 'paye', p_paid_amount, 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'AMOUNT_MISMATCH', 'reference', v_p.internal_reference);
    END IF;

    SELECT id, billing_environment INTO v_c FROM public.companies WHERE id = v_p.company_id FOR UPDATE;
    IF v_c.billing_environment <> v_p.environment THEN
        PERFORM public.billing_log('ACTIVATION_FAILED', p_environment, v_p.internal_reference,
            jsonb_build_object('raison', 'ENVIRONNEMENT_INCOMPATIBLE', 'source', p_source));
        RETURN jsonb_build_object('ok', FALSE, 'code', 'ENVIRONNEMENT_INCOMPATIBLE', 'reference', v_p.internal_reference);
    END IF;

    -- ---- Test de production : deja consomme par un AUTRE paiement ----
    IF v_p.is_smoke_test THEN
        SELECT * INTO v_test FROM public.billing_smoke_test WHERE id FOR UPDATE;
        IF v_test.consumed AND v_test.consumed_payment_id IS DISTINCT FROM v_p.id THEN
            -- Argent recu : encaisse, trace et recu emis ; aucune nouvelle
            -- activation. A rembourser a la main si necessaire.
            UPDATE public.billing_payments
               SET status = 'COMPLETED', completed_at = NOW(), confirmed_amount = v_paye::INTEGER,
                   failure_code = 'DUPLICATE_PAYMENT', updated_at = NOW()
             WHERE id = v_p.id;
            v_recu := public.billing_emettre_recu(v_p.id, NULL, NULL);
            PERFORM public.billing_log('DUPLICATE_PAYMENT', p_environment, v_p.internal_reference,
                jsonb_build_object('raison', 'TEST_DE_PRODUCTION_DEJA_CONSOMME', 'amount', v_p.amount, 'source', p_source));
            RETURN jsonb_build_object('ok', FALSE, 'code', 'DUPLICATE_PAYMENT', 'reference', v_p.internal_reference,
                                      'receipt_id', v_recu);
        END IF;
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

    -- Montant compte au chiffre d'affaires : le montant REELLEMENT encaisse,
    -- jamais un paiement de test sandbox.
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

    -- Grand livre des encaissements (console plateforme) : production seulement.
    IF v_p.environment = 'production' THEN
        INSERT INTO public.platform_payments (company_id, method, status, amount_fcfa, external_ref, paid_at, notes)
        VALUES (v_p.company_id, 'OTHER', 'CONFIRMED', v_p.amount, v_p.internal_reference, NOW(),
                'JoonaPay ' || COALESCE(v_p.provider_reference, '')
                || CASE WHEN v_p.is_smoke_test THEN ' — test de production contrôlé (tarif normal '
                                                    || v_p.normal_amount || ' XOF)' ELSE '' END);
    END IF;

    UPDATE public.billing_payments
       SET status = 'COMPLETED', completed_at = NOW(), confirmed_amount = v_paye::INTEGER,
           subscription_id = v_abo_id, failure_code = NULL, updated_at = NOW()
     WHERE id = v_p.id;

    -- Test de production : consomme ET desactive, dans cette transaction.
    IF v_p.is_smoke_test THEN
        UPDATE public.billing_smoke_test
           SET consumed = TRUE, uses = uses + 1, consumed_payment_id = v_p.id, consumed_at = NOW(),
               enabled = FALSE, disabled_at = NOW(), reserved_payment_id = NULL
         WHERE id;
        PERFORM public.billing_log('SMOKE_TEST_CONSUMED', p_environment, v_p.internal_reference,
            jsonb_build_object('amount', v_p.amount, 'normal_amount', v_p.normal_amount));
    END IF;

    PERFORM public.billing_log('PAYMENT_PROVIDER_CONFIRMED', p_environment, v_p.internal_reference,
        jsonb_build_object('amount', v_p.amount, 'payment_method', v_moyen, 'source', p_source));
    PERFORM public.billing_log('SUBSCRIPTION_ACTIVATED', p_environment, v_p.internal_reference,
        jsonb_build_object('plan', v_p.plan_code, 'period', v_p.billing_period, 'fin', v_fin,
                           'smoke_test', v_p.is_smoke_test));

    v_recu := public.billing_emettre_recu(v_p.id, v_debut, v_fin);
    SELECT number INTO v_numero FROM public.billing_receipts WHERE id = v_recu;

    RETURN jsonb_build_object('ok', TRUE, 'status', 'COMPLETED', 'deja_traite', FALSE,
                              'reference', v_p.internal_reference, 'company_id', v_p.company_id,
                              'is_smoke_test', v_p.is_smoke_test,
                              'receipt_id', v_recu, 'receipt_number', v_numero,
                              'subscription', jsonb_build_object('status', 'ACTIVE', 'fin', v_fin,
                                                                 'plan', v_p.plan_code));
END;
$$;

REVOKE ALL ON FUNCTION public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_apply_provider_status(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 9. HISTORIQUE DE FACTURATION (cockpit, jeton de l'utilisateur)
-- -----------------------------------------------------------------------------
--  Proprietaire et administrateurs de L'entreprise seulement ; aucun champ
--  technique (identifiant JoonaPay, adresse de paiement...).

CREATE OR REPLACE FUNCTION public.billing_history(p_company UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company UUID := p_company;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    IF v_company IS NULL THEN
        SELECT m.company_id INTO v_company
          FROM public.company_memberships m
         WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
         ORDER BY (public.normaliser_role_membre(m.role) = 'OWNER') DESC, m.created_at
         LIMIT 1;
    END IF;

    IF v_company IS NULL OR NOT public.can_configure_company(v_company) THEN
        RAISE EXCEPTION 'Réservé au propriétaire et aux administrateurs.' USING ERRCODE = '42501', HINT = 'DROITS_INSUFFISANTS';
    END IF;

    RETURN jsonb_build_object(
        'company_id', v_company,
        'abonnement', public.etat_abonnement_entreprise(v_company),
        'limites',    public.limites_entreprise(v_company),
        'usage',      public.usage_entreprise(v_company),
        'paiements',  COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'reference',      p.internal_reference,
                       'date',           COALESCE(p.completed_at, p.created_at),
                       'plan',           p.plan_code,
                       'plan_name',      COALESCE(pl.name, p.plan_code),
                       'period',         p.billing_period,
                       'amount',         p.amount,
                       'normal_amount',  p.normal_amount,
                       'currency',       p.currency,
                       'status',         p.status,
                       'is_smoke_test',  p.is_smoke_test,
                       'receipt_number', r.number,
                       'receipt_path',   r.storage_path)
                   ORDER BY p.created_at DESC)
              FROM (SELECT * FROM public.billing_payments bp
                     WHERE bp.company_id = v_company
                       AND (bp.status IN ('COMPLETED', 'FAILED')
                            OR (bp.status IN ('PENDING', 'PROCESSING') AND bp.created_at > NOW() - INTERVAL '24 hours'))
                     ORDER BY bp.created_at DESC
                     LIMIT 50) p
              LEFT JOIN public.platform_plans pl ON pl.code = p.plan_code
              LEFT JOIN public.billing_receipts r ON r.payment_id = p.id), '[]'::JSONB)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_history(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_history(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. EXPIRATION, RAPPROCHEMENT DES PAIEMENTS EN ATTENTE
-- -----------------------------------------------------------------------------
--  A echeance, rien n'est supprime : l'abonnement passe EXPIRED (l'etat de
--  facturation de l'entreprise aussi : etat_abonnement_entreprise), les
--  fonctions payantes se ferment, le proprietaire est invite a renouveler.
--  L'entreprise reste « active » dans companies.status pour que son
--  proprietaire atteigne l'ecran de renouvellement.

CREATE OR REPLACE FUNCTION public.billing_expire_due()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v   RECORD;
    v_n INTEGER := 0;
BEGIN
    FOR v IN
        UPDATE public.company_subscriptions s
           SET status = 'EXPIRED', updated_at = NOW()
         WHERE s.status = 'ACTIVE' AND s.provider = 'JOONAPAY'
           AND s.current_period_end IS NOT NULL AND s.current_period_end <= NOW()
        RETURNING s.company_id, s.plan_code, s.environment, s.current_period_end
    LOOP
        v_n := v_n + 1;
        INSERT INTO public.billing_events (event, environment, company_id, detail)
        VALUES ('SUBSCRIPTION_EXPIRED', v.environment, v.company_id,
                jsonb_build_object('plan', v.plan_code, 'fin', v.current_period_end));
    END LOOP;
    RETURN jsonb_build_object('expires', v_n);
END;
$$;

/** Paiements en attente a relire chez JoonaPay (webhook perdu, client parti). */
CREATE OR REPLACE FUNCTION public.billing_payments_a_reconcilier(p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(jsonb_agg(x.provider_payment_id), '[]'::JSONB)
      FROM (SELECT p.provider_payment_id
              FROM public.billing_payments p
             WHERE p.status IN ('PENDING', 'PROCESSING')
               AND p.provider_payment_id IS NOT NULL
               AND p.environment = public.billing_mode()
               AND p.created_at > NOW() - INTERVAL '3 days'
               AND p.created_at < NOW() - INTERVAL '2 minutes'
               AND (p.last_provider_check_at IS NULL OR p.last_provider_check_at < NOW() - INTERVAL '5 minutes')
             ORDER BY p.last_provider_check_at NULLS FIRST, p.created_at
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)) x;
$$;

REVOKE ALL ON FUNCTION public.billing_expire_due() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_payments_a_reconcilier(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_expire_due() TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_payments_a_reconcilier(INTEGER) TO service_role;

-- -----------------------------------------------------------------------------
-- 11. DROITS : LE NAVIGATEUR N'APPELLE PLUS LES FONCTIONS DE PAIEMENT
-- -----------------------------------------------------------------------------
--  Versions 031 (jeton de l'utilisateur) : remplacees par les v2, appelees
--  par le serveur de paiement seulement.

REVOKE EXECUTE ON FUNCTION public.billing_prepare_checkout(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.billing_payment_status(TEXT) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
