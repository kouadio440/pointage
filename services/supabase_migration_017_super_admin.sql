-- =============================================================================
--  MIGRATION 017 — Socle du tableau de bord super admin
-- =============================================================================
--
--  POURQUOI CETTE MIGRATION EXISTE
--  -------------------------------
--  Le tableau de bord super admin devait afficher un chiffre d'affaires et un
--  MRR. Or la base ne contenait AUCUNE donnee de facturation exploitable :
--
--    - les tables `plan`, `subscription`, `invoice`, `payment` heritees du
--      schema Prisma initial sont vides (0 ligne) ET rattachees a `company`
--      (singulier, vide elle aussi), pas a `companies` (pluriel, la table
--      reellement utilisee par l'application). Elles ne peuvent donc jamais
--      decrire un client reel ;
--    - l'ancien code calculait `mrr = nombre_d_entreprises_actives * 350000`
--      et affichait « 350.000 FCFA » en dur sur chaque ligne. C'etait une
--      invention pure.
--
--  Cette migration cree la facturation MANQUANTE, rattachee aux vraies
--  entreprises. Elle n'invente aucun montant : les tarifs sont NULS tant que
--  le super admin n'a pas saisi les siens. Un abonnement sans tarif est
--  compte a part (`abonnements_non_tarifes`) au lieu d'etre approxime, pour
--  qu'un MRR affiche ne soit jamais un MRR devine.
--
--  CE QUI EST REPRIS DE L'EXISTANT (et n'est donc pas une invention)
--  ----------------------------------------------------------------
--  Chaque entreprise possede deja `companies.plan` et `companies.status`.
--  Le remplissage initial de `company_subscriptions` recopie ces valeurs
--  reelles ainsi que `companies.created_at` comme date de debut. Seule la
--  periodicite (mensuelle) est un defaut neutre, modifiable dans l'interface.
--
--  CONTROLE D'ACCES
--  ----------------
--  `platform_admins` est une liste blanche explicite. Le role `SUPER_ADMIN`
--  existe deja dans la contrainte de `users.role`, mais s'appuyer dessus
--  aurait force le proprietaire a quitter son role de CEO sur sa propre
--  entreprise. Les deux notions restent donc separees.
--
--  IMPORTANT — LES POLITIQUES RLS DE LA PLATEFORME SONT PERMISSIVES
--  ---------------------------------------------------------------
--  `companies`, `users` et `company_memberships` portent des politiques
--  `{public}` en `USING (true)` : la cle anonyme lit toute la plateforme.
--  C'est un defaut anterieur, non corrige ici (le durcir casserait les flux
--  d'inscription qui lisent `companies` par code avant authentification).
--  Consequence directe pour ce tableau de bord : il NE lit PAS ces tables
--  depuis le navigateur. Tout passe par les fonctions ci-dessous, qui
--  verifient `is_platform_admin()` avant de renvoyer quoi que ce soit.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. QUI EST SUPER ADMIN
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_admins (
    user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by  UUID REFERENCES public.users(id),
    note        TEXT
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Aucune politique : la table est INVISIBLE depuis le navigateur, y compris
-- pour un super admin. Seules les fonctions SECURITY DEFINER la consultent.
-- Se donner les droits doit passer par la base, jamais par l'application.

COMMENT ON TABLE public.platform_admins IS
    'Liste blanche des administrateurs de la plateforme Timora. Volontairement '
    'sans politique RLS : seules les fonctions SECURITY DEFINER la lisent.';

-- Le proprietaire de la plateforme. Ce compte existe reellement ; c'est celui
-- qui administre le projet Supabase.
INSERT INTO public.platform_admins (user_id, note)
SELECT u.id, 'Proprietaire de la plateforme (compte fondateur).'
  FROM public.users u
 WHERE lower(u.email) = 'eliseemouaheba2001@gmail.com'
 LIMIT 1
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = p_user);
$$;

GRANT EXECUTE ON FUNCTION public.is_platform_admin(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. LES TARIFS — saisis par le super admin, jamais devines
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_plans (
    code                TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    -- NULLABLES A DESSEIN. Un prix inconnu doit rester inconnu : c'est ce qui
    -- empeche le MRR d'etre une estimation deguisee en mesure.
    monthly_price_fcfa  INTEGER CHECK (monthly_price_fcfa IS NULL OR monthly_price_fcfa >= 0),
    annual_price_fcfa   INTEGER CHECK (annual_price_fcfa  IS NULL OR annual_price_fcfa  >= 0),
    max_employees       INTEGER,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order          INTEGER NOT NULL DEFAULT 100,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_plans ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.platform_plans.monthly_price_fcfa IS
    'Tarif mensuel reel en FCFA. NULL tant que le super admin ne l''a pas saisi : '
    'les abonnements concernes sont alors comptes comme « non tarifes » et exclus du MRR.';

-- Les codes de plan REELLEMENT presents sur les entreprises, sans tarif.
INSERT INTO public.platform_plans (code, name, sort_order)
SELECT DISTINCT lower(c.plan), initcap(c.plan), 100
  FROM public.companies c
 WHERE c.plan IS NOT NULL AND btrim(c.plan) <> ''
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. LES ABONNEMENTS — rattaches aux VRAIES entreprises
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    plan_code           TEXT REFERENCES public.platform_plans(code),
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED')),
    billing_period      TEXT NOT NULL DEFAULT 'MONTHLY'
                        CHECK (billing_period IN ('MONTHLY', 'ANNUAL')),
    -- Montant negocie pour CETTE entreprise. NULL = on applique le tarif du plan.
    amount_fcfa         INTEGER CHECK (amount_fcfa IS NULL OR amount_fcfa >= 0),
    seats               INTEGER,
    started_at          TIMESTAMPTZ,
    trial_ends_at       TIMESTAMPTZ,
    current_period_end  TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS company_subscriptions_active_unique
    ON public.company_subscriptions (company_id)
 WHERE status IN ('TRIAL', 'ACTIVE', 'PAST_DUE');

ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;

-- Reprise de l'existant : plan, statut et date de creation sont ceux de
-- l'entreprise. Le montant reste NUL — aucun tarif n'a jamais ete saisi.
INSERT INTO public.company_subscriptions (company_id, plan_code, status, started_at)
SELECT c.id,
       lower(c.plan),
       CASE lower(COALESCE(c.status, 'active'))
            WHEN 'active'    THEN 'ACTIVE'
            WHEN 'trial'     THEN 'TRIAL'
            WHEN 'suspended' THEN 'SUSPENDED'
            WHEN 'cancelled' THEN 'CANCELLED'
            ELSE 'ACTIVE'
       END,
       c.created_at
  FROM public.companies c
 WHERE NOT EXISTS (
        SELECT 1 FROM public.company_subscriptions s WHERE s.company_id = c.id
       );

-- -----------------------------------------------------------------------------
-- 4. FACTURES ET ENCAISSEMENTS — la source du chiffre d'affaires
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES public.company_subscriptions(id) ON DELETE SET NULL,
    reference       TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED')),
    amount_fcfa     INTEGER NOT NULL CHECK (amount_fcfa >= 0),
    period_from     DATE,
    period_to       DATE,
    issued_at       TIMESTAMPTZ,
    due_at          TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.platform_payments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    invoice_id   UUID REFERENCES public.platform_invoices(id) ON DELETE SET NULL,
    method       TEXT NOT NULL DEFAULT 'MOBILE_MONEY'
                 CHECK (method IN ('MOBILE_MONEY', 'BANK_TRANSFER', 'CASH', 'CARD', 'OTHER')),
    status       TEXT NOT NULL DEFAULT 'CONFIRMED'
                 CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED')),
    amount_fcfa  INTEGER NOT NULL CHECK (amount_fcfa >= 0),
    external_ref TEXT,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by  UUID REFERENCES public.users(id),
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_invoices_company_idx ON public.platform_invoices (company_id);
CREATE INDEX IF NOT EXISTS platform_payments_company_idx ON public.platform_payments (company_id);
CREATE INDEX IF NOT EXISTS platform_payments_paid_idx    ON public.platform_payments (paid_at);

ALTER TABLE public.platform_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_payments ENABLE ROW LEVEL SECURITY;

-- Aucune politique sur les quatre tables de facturation : elles sont
-- inaccessibles depuis le navigateur. Le tableau de bord y accede uniquement
-- par les fonctions SECURITY DEFINER ci-dessous.

-- -----------------------------------------------------------------------------
-- 5. LE MONTANT MENSUEL D'UN ABONNEMENT
-- -----------------------------------------------------------------------------
--  Renvoie NULL — et non zero — quand aucun tarif n'est connu. Toute la
--  chaine de calcul repose sur cette distinction : un abonnement non tarife
--  ne doit pas peser 0 F dans le MRR, il doit etre signale comme non tarife.

CREATE OR REPLACE FUNCTION public.subscription_monthly_fcfa(
    p_amount   INTEGER,
    p_period   TEXT,
    p_monthly  INTEGER,
    p_annual   INTEGER
)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        -- Montant negocie pour l'entreprise : il prime sur le tarif du plan.
        WHEN p_amount IS NOT NULL AND p_period = 'ANNUAL'  THEN p_amount::NUMERIC / 12
        WHEN p_amount IS NOT NULL                          THEN p_amount::NUMERIC
        WHEN p_period = 'ANNUAL' AND p_annual  IS NOT NULL THEN p_annual::NUMERIC / 12
        WHEN p_period = 'ANNUAL' AND p_monthly IS NOT NULL THEN p_monthly::NUMERIC
        WHEN p_monthly IS NOT NULL                         THEN p_monthly::NUMERIC
        WHEN p_annual  IS NOT NULL                         THEN p_annual::NUMERIC / 12
        ELSE NULL
    END;
$$;

-- -----------------------------------------------------------------------------
-- 6. LA VUE D'ENSEMBLE — une seule requete pour tout le tableau de bord
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    WITH abos AS (
        SELECT s.id, s.status, s.company_id, s.plan_code, s.billing_period,
               public.subscription_monthly_fcfa(
                   s.amount_fcfa, s.billing_period, p.monthly_price_fcfa, p.annual_price_fcfa
               ) AS mensuel
          FROM public.company_subscriptions s
          LEFT JOIN public.platform_plans p ON p.code = s.plan_code
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
                                                     AND a.mensuel IS NOT NULL),
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
$$;

GRANT EXECUTE ON FUNCTION public.platform_overview() TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. LE DETAIL PAR ENTREPRISE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_companies()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.platform_companies() TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. LES TARIFS ET LEUR SAISIE
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_plans_list()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'code',     p.code,
               'nom',      p.name,
               'mensuel',  p.monthly_price_fcfa,
               'annuel',   p.annual_price_fcfa,
               'actif',    p.is_active,
               'abonnes',  (SELECT COUNT(*) FROM public.company_subscriptions s
                             WHERE s.plan_code = p.code AND s.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE'))
           ) ORDER BY p.sort_order, p.code), '[]'::JSONB) INTO v
      FROM public.platform_plans p;

    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_plans_list() TO authenticated;

CREATE OR REPLACE FUNCTION public.platform_set_plan_price(
    p_code    TEXT,
    p_monthly INTEGER,
    p_annual  INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    IF p_monthly IS NOT NULL AND p_monthly < 0 THEN
        RAISE EXCEPTION 'Le tarif mensuel ne peut pas etre negatif.';
    END IF;

    UPDATE public.platform_plans
       SET monthly_price_fcfa = p_monthly,
           annual_price_fcfa  = p_annual,
           updated_at         = NOW()
     WHERE code = lower(p_code);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan inconnu : %', p_code;
    END IF;

    RETURN jsonb_build_object('ok', TRUE, 'code', lower(p_code),
                              'mensuel', p_monthly, 'annuel', p_annual);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_set_plan_price(TEXT, INTEGER, INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. SUSPENDRE OU REACTIVER UNE ENTREPRISE
-- -----------------------------------------------------------------------------
--  L'ancien bouton « Suspendre » de l'interface n'ecrivait nulle part.
--  Ici, l'entreprise ET son abonnement changent d'etat ensemble, sinon le
--  MRR continuerait de compter une entreprise coupee.

CREATE OR REPLACE FUNCTION public.platform_set_company_status(
    p_company UUID,
    p_status  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_statut TEXT := lower(p_status);
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    IF v_statut NOT IN ('active', 'suspended') THEN
        RAISE EXCEPTION 'Statut invalide : % (attendu active ou suspended)', p_status;
    END IF;

    UPDATE public.companies SET status = v_statut, updated_at = NOW() WHERE id = p_company;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Entreprise inconnue.';
    END IF;

    UPDATE public.company_subscriptions
       SET status     = CASE WHEN v_statut = 'active' THEN 'ACTIVE' ELSE 'SUSPENDED' END,
           updated_at = NOW()
     WHERE company_id = p_company
       AND status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED');

    RETURN jsonb_build_object('ok', TRUE, 'statut', v_statut);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_set_company_status(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. ENREGISTRER UN ENCAISSEMENT REEL
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_record_payment(
    p_company  UUID,
    p_amount   INTEGER,
    p_method   TEXT DEFAULT 'MOBILE_MONEY',
    p_paid_at  TIMESTAMPTZ DEFAULT NOW(),
    p_ref      TEXT DEFAULT NULL,
    p_notes    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Le montant encaisse doit etre strictement positif.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company) THEN
        RAISE EXCEPTION 'Entreprise inconnue.';
    END IF;

    INSERT INTO public.platform_payments (company_id, amount_fcfa, method, paid_at,
                                          external_ref, notes, recorded_by, status)
    VALUES (p_company, p_amount, upper(COALESCE(p_method, 'MOBILE_MONEY')),
            COALESCE(p_paid_at, NOW()), p_ref, p_notes, auth.uid(), 'CONFIRMED')
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', TRUE, 'id', v_id, 'montant', p_amount);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_record_payment(UUID, INTEGER, TEXT, TIMESTAMPTZ, TEXT, TEXT)
    TO authenticated;

-- -----------------------------------------------------------------------------
-- 11. LES DERNIERS ENCAISSEMENTS
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.platform_payments_list(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'paid_at' DESC), '[]'::JSONB) INTO v
    FROM (
        SELECT jsonb_build_object(
            'id',        pm.id,
            'entreprise', c.name,
            'montant',   pm.amount_fcfa,
            'methode',   pm.method,
            'statut',    pm.status,
            'paid_at',   pm.paid_at,
            'ref',       pm.external_ref
        ) AS x
        FROM public.platform_payments pm
        JOIN public.companies c ON c.id = pm.company_id
        ORDER BY pm.paid_at DESC
        LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
    ) t;

    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_payments_list(INTEGER) TO authenticated;

-- -----------------------------------------------------------------------------
-- 12. LE JOURNAL DE LA PLATEFORME
-- -----------------------------------------------------------------------------
--  Remplace les cinq fausses lignes de log ecrites en dur dans l'interface
--  (« NestJS API Server », « 42 Tenants »...) par les derniers evenements
--  reellement enregistres.

CREATE OR REPLACE FUNCTION public.platform_activity(p_limit INTEGER DEFAULT 40)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(x ORDER BY x->>'quand' DESC), '[]'::JSONB) INTO v
    FROM (
        (SELECT jsonb_build_object(
             'quand',      COALESCE(a.server_time, a.created_at),
             'type',       'POINTAGE',
             'gravite',    CASE WHEN a.decision = 'ACCEPTED' THEN 'ok'
                                WHEN a.decision = 'PENDING_REVIEW' THEN 'attention'
                                ELSE 'refus' END,
             'entreprise', c.name,
             'acteur',     u.full_name,
             'detail',     COALESCE(a.punch_type, '?') || ' — ' || COALESCE(a.decision, 'sans decision')
                           || CASE WHEN COALESCE(a.late_minutes, 0) > 0
                                   THEN ' (retard ' || a.late_minutes || ' min)' ELSE '' END
         ) AS x
           FROM public.attendances a
           LEFT JOIN public.companies c ON c.id = a.company_id
           LEFT JOIN public.users u     ON u.id = a.user_id
          ORDER BY COALESCE(a.server_time, a.created_at) DESC
          LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 40), 100)))
        UNION ALL
        (SELECT jsonb_build_object(
             'quand',      m.created_at,
             'type',       'RATTACHEMENT',
             'gravite',    CASE WHEN m.status = 'ACTIVE' THEN 'ok' ELSE 'attention' END,
             'entreprise', c.name,
             'acteur',     u.full_name,
             'detail',     COALESCE(m.role, '?') || ' — ' || COALESCE(m.status, '?')
         ) AS x
           FROM public.company_memberships m
           LEFT JOIN public.companies c ON c.id = m.company_id
           LEFT JOIN public.users u     ON u.id = m.user_id
          ORDER BY m.created_at DESC
          LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 40), 100)))
    ) t;

    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_activity(INTEGER) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
