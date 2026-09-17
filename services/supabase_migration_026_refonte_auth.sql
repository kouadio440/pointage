-- =============================================================================
--  MIGRATION 026 — Refonte de l'authentification (etape 1, compatible)
-- =============================================================================
--
--  CE QUI NE VA PAS (constate sur la base reelle)
--  ----------------------------------------------
--  1. Le createur d'une entreprise etait enregistre correctement en base
--     (rattachement CEO / ACTIVE) mais l'interface le traitait comme employe :
--     cinq endroits du front decidaient du role, plusieurs retombant sur
--     EMPLOYEE faute d'information. Cas reel : compte confirme a 17:08,
--     entreprise creee a 17:13 — entre les deux, « EMPLOYEE » a ete memorise.
--
--  2. `register_company()` ne generait aucun code : « Winner Digital »,
--     creee le 16/09, n'en a pas. Aucun employe ne peut la rejoindre.
--
--  3. Aucune source unique ne disait « qui est cet utilisateur, dans quelle
--     entreprise, avec quel role, et ou doit-il aller ».
--
--  POURQUOI DEUX ETAPES
--  --------------------
--  Le vocabulaire cible est OWNER / ADMIN / MANAGER / EMPLOYEE. Mais la version
--  du site actuellement en ligne ne reconnait que CEO et HR : 16 controles
--  (`peutConfigurerPointage`) retireraient toute la configuration du pointage
--  aux dirigeants si les roles etaient renommes avant son remplacement.
--
--    026 (celle-ci) : tout ce qui est compatible avec les deux versions du site.
--                     Les fonctions comprennent l'ancien ET le nouveau vocabulaire.
--    027            : le renommage des roles, a appliquer au deploiement.
--
--  AUCUNE DONNEE N'EST SUPPRIMEE NI MODIFIEE, hormis l'attribution d'un code
--  aux entreprises qui n'en avaient pas.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. VOCABULAIRE DES ROLES
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normaliser_role_membre(p_role TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE upper(btrim(COALESCE(p_role, '')))
        WHEN 'OWNER'         THEN 'OWNER'
        WHEN 'CEO'           THEN 'OWNER'
        WHEN 'ADMIN'         THEN 'ADMIN'
        WHEN 'HR'            THEN 'ADMIN'
        WHEN 'COMPANY_ADMIN' THEN 'ADMIN'
        -- SUPER_ADMIN designait un administrateur de la plateforme : dans une
        -- entreprise, il ne vaut qu'un administrateur, jamais un proprietaire.
        WHEN 'SUPER_ADMIN'   THEN 'ADMIN'
        WHEN 'MANAGER'       THEN 'MANAGER'
        WHEN 'FIELD_AGENT'   THEN 'EMPLOYEE'
        WHEN 'EMPLOYEE'      THEN 'EMPLOYEE'
        -- Role inconnu : le moins privilegie, jamais un role d'administration.
        ELSE 'EMPLOYEE'
    END;
$$;

REVOKE ALL ON FUNCTION public.normaliser_role_membre(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normaliser_role_membre(TEXT) TO authenticated;

/**
 * Libelle STOCKE pour un proprietaire.
 *
 * « CEO » tant que la version du site en ligne ne connait que ce mot ; la
 * migration 027 le fait passer a « OWNER ». Les fonctions de creation passent
 * par ici plutot que d'ecrire le mot en dur.
 */
CREATE OR REPLACE FUNCTION public.role_proprietaire_stocke()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 'CEO'::text; $$;

REVOKE ALL ON FUNCTION public.role_proprietaire_stocke() FROM PUBLIC, anon, authenticated;

-- Le nouveau vocabulaire est accepte des maintenant sur la fiche `users`.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (upper(role::text) = ANY (ARRAY[
    'OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE',
    'SUPER_ADMIN', 'COMPANY_ADMIN', 'FIELD_AGENT', 'CEO', 'HR']));

-- -----------------------------------------------------------------------------
-- 2. AUTORISATIONS : les deux vocabulaires sont compris
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_configure_company(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.company_id = p_company_id
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
    );
$$;

CREATE OR REPLACE FUNCTION public.can_view_company_attendance(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid()
           AND m.company_id = p_company_id
           AND m.status = 'ACTIVE'
           AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN', 'MANAGER')
    );
$$;

/**
 * Anti-escalade (migration 020), ajuste : un utilisateur qui vient de devenir
 * proprietaire d'une entreprise doit pouvoir faire pointer sa fiche vers elle.
 * `can_configure_company(NEW.company_id)` n'est vrai que s'il l'administre
 * DEJA : impossible de s'attribuer ainsi une entreprise tierce.
 */
CREATE OR REPLACE FUNCTION public.users_bloquer_escalade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF public.is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF public.can_configure_company(OLD.company_id)
       OR public.can_configure_company(NEW.company_id) THEN
        RETURN NEW;
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'Changement de role interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
        RAISE EXCEPTION 'Changement d''entreprise interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
        RAISE EXCEPTION 'Changement d''etat du compte interdit.' USING ERRCODE = '42501';
    END IF;

    IF NEW.attendance_required IS DISTINCT FROM OLD.attendance_required THEN
        RAISE EXCEPTION 'Changement de l''obligation de pointage interdit.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

-- Un seul rattachement par personne et par entreprise (verifie : aucun doublon).
ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_user_company_key;
ALTER TABLE public.company_memberships ADD CONSTRAINT company_memberships_user_company_key
    UNIQUE (user_id, company_id);

-- -----------------------------------------------------------------------------
-- 3. ENTREPRISE : informations d'onboarding et code d'adhesion
-- -----------------------------------------------------------------------------

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS employee_range TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS created_by UUID;

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_employee_range_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_employee_range_check
    CHECK (employee_range IS NULL OR employee_range IN ('1-10', '11-30', '31-100', '100+'));

-- Les entreprises en activite ont un code : leur onboarding est considere
-- comme termine. Celles creees par l'ancien `register_company()` n'en ont ni
-- code, ni pays, ni ville : leur proprietaire completera le formulaire court.
--
-- Calcule UNE SEULE FOIS, a l'ajout de la colonne : relancer la migration
-- apres l'attribution des codes (plus bas) marquerait sinon ces entreprises
-- comme terminees.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'companies'
                      AND column_name = 'onboarding_completed') THEN
        ALTER TABLE public.companies ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE public.companies SET onboarding_completed = (company_code IS NOT NULL AND btrim(company_code) <> '');
    END IF;
END;
$$;

/**
 * Code d'adhesion : TIM-XXXX-XXXX, alphabet de Crockford (sans I, L, O, U :
 * aucune confusion a la lecture ni a la dictee). 8 caracteres parmi 32, soit
 * 40 bits d'alea issus de `gen_random_uuid()`.
 *
 * Le code IDENTIFIE une entreprise ; il ne donne acces a rien. Une adhesion
 * exige une authentification, puis l'approbation du service RH.
 */
CREATE OR REPLACE FUNCTION public.generer_code_entreprise()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    octets   BYTEA;
    brut     TEXT;
    code     TEXT;
    i        INT;
BEGIN
    LOOP
        octets := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
        brut := '';
        -- Octets 0-3 puis 16-19 : on evite les octets 6 et 8 de chaque UUID,
        -- qui portent la version et la variante (non aleatoires).
        -- 256 est un multiple de 32 : le modulo ne biaise aucun caractere.
        FOR i IN 0..7 LOOP
            brut := brut || substr(alphabet,
                (get_byte(octets, CASE WHEN i < 4 THEN i ELSE i + 12 END) % 32) + 1, 1);
        END LOOP;
        code := 'TIM-' || substr(brut, 1, 4) || '-' || substr(brut, 5, 4);
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.companies c WHERE upper(c.company_code) = code);
    END LOOP;
    RETURN code;
END;
$$;

REVOKE ALL ON FUNCTION public.generer_code_entreprise() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.companies_code_par_defaut()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.company_code IS NULL OR btrim(NEW.company_code) = '' THEN
        NEW.company_code := public.generer_code_entreprise();
    END IF;
    RETURN NEW;
END;
$$;

-- Toute entreprise recoit un code, quel que soit le chemin qui la cree.
DROP TRIGGER IF EXISTS aa_code_entreprise ON public.companies;
CREATE TRIGGER aa_code_entreprise
    BEFORE INSERT ON public.companies
    FOR EACH ROW EXECUTE FUNCTION public.companies_code_par_defaut();

UPDATE public.companies SET company_code = public.generer_code_entreprise()
 WHERE company_code IS NULL OR btrim(company_code) = '';

CREATE UNIQUE INDEX IF NOT EXISTS companies_company_code_upper_key
    ON public.companies (upper(company_code));

-- -----------------------------------------------------------------------------
-- 4. JOURNAL D'AUTHENTIFICATION
-- -----------------------------------------------------------------------------
--  Supabase ne conserve plus ses journaux d'authentification en base
--  (auth.audit_log_entries : aucune entree sur 14 jours). Pour comprendre
--  pourquoi un code n'est pas arrive, il faut donc les consigner nous-memes.
--
--  JAMAIS STOCKES : le code, l'adresse en clair, un jeton, un mot de passe.
--  STOCKES : le type d'evenement, l'empreinte SHA-256 de l'adresse (on
--  retrouve les evenements d'une personne a partir de son adresse), le domaine
--  (un probleme propre a icloud.com se voit immediatement) et le code d'erreur
--  renvoye par Supabase.

CREATE TABLE IF NOT EXISTS public.auth_events (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event        TEXT NOT NULL CHECK (event IN (
                     'OTP_REQUESTED', 'OTP_SENT', 'OTP_SEND_FAILED', 'OTP_RATE_LIMITED',
                     'OTP_VERIFIED', 'OTP_INVALID', 'OTP_EXPIRED',
                     'GOOGLE_STARTED', 'GOOGLE_FAILED',
                     'COMPANY_CREATED', 'JOIN_REQUESTED')),
    flow         TEXT CHECK (flow IS NULL OR flow IN ('company_login', 'company_signup', 'employee_join')),
    email_hash   TEXT,
    email_domain TEXT,
    error_code   TEXT,
    user_id      UUID
);

CREATE INDEX IF NOT EXISTS auth_events_email_hash_idx ON public.auth_events (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_events_created_idx ON public.auth_events (created_at DESC);

ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.auth_events_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.empreinte_email(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE WHEN p_email IS NULL OR btrim(p_email) = '' THEN NULL
                ELSE encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') END;
$$;

REVOKE ALL ON FUNCTION public.empreinte_email(TEXT) FROM PUBLIC, anon, authenticated;

/**
 * Consigne un evenement d'authentification.
 *
 * Appelable sans session : les echecs d'envoi surviennent AVANT toute
 * connexion. Les entrees sont donc bornees — evenements et parcours en liste
 * fermee, code d'erreur en caracteres simples, plafonds par adresse et global.
 * Un visiteur malveillant peut au pire bruiter le journal ; il n'y lit rien.
 *
 * Ces evenements sont DECLARES par le navigateur : « OTP_SENT » signifie que
 * Supabase a accepte la demande d'envoi, pas que l'e-mail est arrive.
 */
CREATE OR REPLACE FUNCTION public.log_auth_event(
    p_event      TEXT,
    p_email      TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_flow       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash    TEXT := public.empreinte_email(p_email);
    v_domaine TEXT := NULLIF(lower(split_part(btrim(COALESCE(p_email, '')), '@', 2)), '');
    v_erreur  TEXT := NULLIF(left(regexp_replace(COALESCE(p_error_code, ''), '[^a-zA-Z0-9_]', '', 'g'), 64), '');
    v_flux    TEXT := p_flow;
BEGIN
    IF p_event IS NULL OR p_event NOT IN ('OTP_REQUESTED', 'OTP_SENT', 'OTP_SEND_FAILED', 'OTP_RATE_LIMITED',
                                          'OTP_VERIFIED', 'OTP_INVALID', 'OTP_EXPIRED',
                                          'GOOGLE_STARTED', 'GOOGLE_FAILED') THEN
        RETURN;
    END IF;

    IF v_flux IS NOT NULL AND v_flux NOT IN ('company_login', 'company_signup', 'employee_join') THEN
        v_flux := NULL;
    END IF;

    IF v_domaine IS NOT NULL AND v_domaine !~ '^[a-z0-9.-]{1,253}$' THEN
        v_domaine := NULL;
    END IF;

    -- Plafonds : 30 evenements par adresse sur 10 minutes, 600 par minute au total.
    IF v_hash IS NOT NULL AND (SELECT count(*) FROM public.auth_events
                                WHERE email_hash = v_hash AND created_at > NOW() - INTERVAL '10 minutes') >= 30 THEN
        RETURN;
    END IF;
    IF (SELECT count(*) FROM public.auth_events WHERE created_at > NOW() - INTERVAL '1 minute') >= 600 THEN
        RETURN;
    END IF;

    INSERT INTO public.auth_events (event, flow, email_hash, email_domain, error_code, user_id)
    VALUES (p_event, v_flux, v_hash, v_domaine, v_erreur, auth.uid());

    -- Conservation limitee a 30 jours, purgee au fil de l'eau.
    IF random() < 0.02 THEN
        DELETE FROM public.auth_events WHERE created_at < NOW() - INTERVAL '30 days';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.log_auth_event(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_auth_event(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

/** Diagnostic pour l'administrateur de la plateforme : « pourquoi ce code n'arrive-t-il pas ? » */
CREATE OR REPLACE FUNCTION public.platform_auth_events(p_email TEXT, p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash       TEXT := public.empreinte_email(p_email);
    v_compte     JSONB;
    v_evenements JSONB;
BEGIN
    IF NOT public.is_platform_admin() THEN
        RAISE EXCEPTION 'Acces refuse : compte non administrateur de la plateforme.' USING ERRCODE = '42501';
    END IF;

    SELECT jsonb_build_object(
               'existe', TRUE,
               'email_confirme', u.email_confirmed_at IS NOT NULL,
               'derniere_connexion', u.last_sign_in_at,
               'fournisseurs', (SELECT COALESCE(jsonb_agg(DISTINCT i.provider), '[]'::jsonb)
                                  FROM auth.identities i WHERE i.user_id = u.id),
               'code_en_attente', EXISTS (SELECT 1 FROM auth.one_time_tokens t WHERE t.user_id = u.id))
      INTO v_compte
      FROM auth.users u
     WHERE lower(u.email) = lower(btrim(p_email))
     LIMIT 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'quand', e.created_at, 'evenement', e.event, 'parcours', e.flow,
               'erreur', e.error_code, 'domaine', e.email_domain) ORDER BY e.created_at DESC), '[]'::jsonb)
      INTO v_evenements
      FROM (SELECT * FROM public.auth_events WHERE email_hash = v_hash
             ORDER BY created_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))) e;

    RETURN jsonb_build_object('compte', COALESCE(v_compte, jsonb_build_object('existe', FALSE)),
                              'evenements', v_evenements);
END;
$$;

REVOKE ALL ON FUNCTION public.platform_auth_events(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_auth_events(TEXT, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. CREATION D'ENTREPRISE — atomique et idempotente
-- -----------------------------------------------------------------------------

/** Nom affichable du compte connecte : fiche existante, puis profil Google, puis adresse. */
CREATE OR REPLACE FUNCTION public.nom_compte_connecte()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(btrim(u.full_name), '') FROM public.users u WHERE u.id = auth.uid()),
        NULLIF(btrim((SELECT raw_user_meta_data->>'full_name' FROM auth.users WHERE id = auth.uid())), ''),
        NULLIF(btrim((SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = auth.uid())), ''),
        split_part(COALESCE(auth.email(), 'Utilisateur'), '@', 1)
    );
$$;

REVOKE ALL ON FUNCTION public.nom_compte_connecte() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_company(
    p_name           TEXT,
    p_country        TEXT,
    p_city           TEXT,
    p_employee_range TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user    UUID := auth.uid();
    v_email   TEXT := auth.email();
    v_nom     TEXT := btrim(COALESCE(p_name, ''));
    v_pays    TEXT := btrim(COALESCE(p_country, ''));
    v_ville   TEXT := btrim(COALESCE(p_city, ''));
    v_existe  RECORD;
    v_company RECORD;
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

            RETURN jsonb_build_object('status', 'COMPLETED', 'company_id', v_company.id,
                                      'company_name', v_company.name, 'company_code', v_company.company_code,
                                      'role', 'owner', 'destination', 'company_dashboard');
        END IF;

        RETURN jsonb_build_object('status', 'ALREADY_EXISTS', 'company_id', v_existe.id,
                                  'company_name', v_existe.name, 'company_code', v_existe.company_code,
                                  'role', lower(v_existe.role), 'destination', 'company_dashboard');
    END IF;

    -- Tout ce qui suit forme UNE transaction : si une etape echoue, rien ne
    -- subsiste — ni entreprise sans proprietaire, ni proprietaire sans entreprise.
    INSERT INTO public.companies (name, country, city, employee_range, onboarding_completed,
                                  created_by, plan, status)
    VALUES (v_nom, v_pays, v_ville, p_employee_range, TRUE, v_user, 'pro', 'active')
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
                              'role', 'owner', 'destination', 'company_dashboard');
END;
$$;

REVOKE ALL ON FUNCTION public.create_company(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_company(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Conservee pour la version du site deja en ligne. Deux corrections : la
-- verification d'existence comprend les deux vocabulaires (sinon un double
-- clic creait deux entreprises), et un code est desormais attribue (par le
-- declencheur). L'entreprise reste « onboarding incomplet », faute de pays.
CREATE OR REPLACE FUNCTION public.register_company(
    p_company_name TEXT,
    p_full_name    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user    UUID := auth.uid();
    v_email   TEXT := auth.email();
    v_company UUID;
    v_nom     TEXT := btrim(COALESCE(p_company_name, ''));
    v_exist   UUID;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Session requise.' USING ERRCODE = '42501';
    END IF;

    IF NOT public.compte_email_verifie() THEN
        RAISE EXCEPTION 'Adresse e-mail non vérifiée : confirmez-la avant de créer une entreprise.'
            USING ERRCODE = 'TM401', HINT = 'EMAIL_NON_VERIFIE';
    END IF;

    IF length(v_nom) < 2 THEN
        RAISE EXCEPTION 'Le nom de l''entreprise est trop court.';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('create_company:' || v_user::text, 0));

    SELECT m.company_id INTO v_exist
      FROM public.company_memberships m
     WHERE m.user_id = v_user AND m.status = 'ACTIVE'
       AND public.normaliser_role_membre(m.role) IN ('OWNER', 'ADMIN')
     LIMIT 1;

    IF v_exist IS NOT NULL THEN
        RETURN jsonb_build_object('ok', TRUE, 'deja_cree', TRUE, 'company_id', v_exist, 'user_id', v_user);
    END IF;

    INSERT INTO public.companies (name, plan, status, created_by, onboarding_completed)
    VALUES (v_nom, 'pro', 'active', v_user, FALSE)
    RETURNING id INTO v_company;

    INSERT INTO public.company_memberships (user_id, company_id, role, attendance_required, status)
    VALUES (v_user, v_company, public.role_proprietaire_stocke(), FALSE, 'ACTIVE');

    INSERT INTO public.users (id, company_id, email, full_name, role, job_title, attendance_required, is_active)
    VALUES (v_user, v_company, v_email,
            COALESCE(NULLIF(btrim(p_full_name), ''), public.nom_compte_connecte()),
            public.role_proprietaire_stocke(), 'Directeur Général / CEO', FALSE, TRUE)
    ON CONFLICT (id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            role       = EXCLUDED.role,
            full_name  = COALESCE(NULLIF(btrim(p_full_name), ''), public.users.full_name);

    RETURN jsonb_build_object('ok', TRUE, 'deja_cree', FALSE, 'company_id', v_company, 'user_id', v_user);
END;
$$;

REVOKE ALL ON FUNCTION public.register_company(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. REJOINDRE UNE ENTREPRISE — comportement inchange, journal et codes d'erreur
-- -----------------------------------------------------------------------------
--  L'adhesion reste EN ATTENTE d'approbation RH : un code entreprise se
--  transmet, s'affiche, se retrouve dans un message. S'il suffisait a devenir
--  membre actif, quiconque le connait lirait l'annuaire des salaries.

CREATE OR REPLACE FUNCTION public.join_company(
    p_code      TEXT,
    p_full_name TEXT DEFAULT NULL,
    p_phone     TEXT DEFAULT NULL,
    p_job_title TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. RECONNAITRE UN CODE (sans compte) : la ville s'ajoute au nom
-- -----------------------------------------------------------------------------

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

    RETURN jsonb_build_object('id', v.id, 'name', v.name, 'city', v.city, 'status', v.status);
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_company_by_code(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_company_by_code(TEXT) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. REGENERER LE CODE D'UNE ENTREPRISE (proprietaire uniquement)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.regenerate_company_code(p_company UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_code TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.company_memberships m
         WHERE m.user_id = auth.uid() AND m.company_id = p_company
           AND m.status = 'ACTIVE' AND public.normaliser_role_membre(m.role) = 'OWNER'
    ) THEN
        RAISE EXCEPTION 'Seul le propriétaire peut régénérer le code.' USING ERRCODE = '42501';
    END IF;

    v_code := public.generer_code_entreprise();
    UPDATE public.companies SET company_code = v_code, updated_at = NOW() WHERE id = p_company;

    RETURN jsonb_build_object('ok', TRUE, 'company_code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_company_code(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_company_code(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. RESOLUTION : QUI, QUELLE ENTREPRISE, QUEL ROLE, OU ALLER
-- -----------------------------------------------------------------------------
--  Source de verite UNIQUE apres toute authentification (code e-mail, Google,
--  mot de passe) et a chaque rechargement. Le navigateur n'en deduit rien : il
--  suit `destination`. Les roles renvoyes sont toujours canoniques, en
--  minuscules (owner, admin, manager, employee), quel que soit le mot stocke.
--
--  p_intent            ce que l'utilisateur a choisi a l'ecran ; il n'oriente
--                      qu'un compte SANS entreprise, jamais les droits d'un
--                      compte qui en a une.
--  p_preferred_company entreprise souhaitee quand il y en a plusieurs ;
--                      ignoree sans rattachement actif a celle-ci.
--
--  Destinations :
--    company_dashboard   owner, admin, manager
--    employee_dashboard  employee
--    select_company      plusieurs rattachements actifs, aucun choix valide
--    company_onboarding  creation d'entreprise demandee, ou entreprise a completer
--    pending_approval    demande d'adhesion en attente du service RH
--    company_suspended   seulement des entreprises suspendues
--    no_membership       compte authentifie sans aucune entreprise

CREATE OR REPLACE FUNCTION public.resolve_auth_context(
    p_intent            TEXT DEFAULT NULL,
    p_preferred_company UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user        UUID := auth.uid();
    v_compte      RECORD;
    v_membres     JSONB;
    v_actif       RECORD;
    v_nb_actifs   INT;
    v_destination TEXT;
    v_attente     JSONB := NULL;
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
            v_destination := CASE WHEN v_actif.company_id IS NULL THEN 'select_company' ELSE 'company_dashboard' END;
        ELSE
            v_destination := 'company_onboarding';
        END IF;
    ELSIF v_actif.company_id IS NOT NULL THEN
        IF v_actif.role = 'OWNER' AND NOT v_actif.onboarding_completed THEN
            v_destination := 'company_onboarding';
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
        'pending', v_attente,
        'destination', v_destination
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_auth_context(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_auth_context(TEXT, UUID) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
