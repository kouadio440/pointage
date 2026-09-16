-- =============================================================================
--  MIGRATION 021 — Inscription et rattachement apres fermeture de la RLS
-- =============================================================================
--
--  La migration 020 ferme l'INSERT direct sur `companies` et impose que toute
--  fiche `users` porte l'identifiant du compte authentifie. Trois chemins
--  legitimes s'appuyaient sur les anciennes politiques ouvertes ; ils passent
--  desormais par les fonctions ci-dessous.
--
--  POURQUOI DES FONCTIONS PLUTOT QUE DES POLITIQUES
--  ------------------------------------------------
--  Creer une entreprise, sa fiche CEO et le rattachement correspondant, c'est
--  trois ecritures dans trois tables qui n'ont de sens qu'ensemble. Le client
--  les envoyait separement : une coupure entre la deuxieme et la troisieme
--  laissait un compte sans rattachement. Ici, la transaction est unique.
--
--  CE QUE CES FONCTIONS NE FONT PAS
--  --------------------------------
--  Aucune n'accepte d'identifiant d'utilisateur en parametre. L'identite vient
--  toujours de `auth.uid()`. C'est le meme principe que `record_attendance()` :
--  un client ne declare jamais qui il est.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. RECONNAITRE UN CODE ENTREPRISE (avant authentification)
-- -----------------------------------------------------------------------------
--  Seul chemin de lecture laisse a un visiteur sans compte, et volontairement
--  etroit : il faut connaitre le code exact, et la reponse ne contient que le
--  nom et l'etat. Ni reglages de reconnaissance faciale, ni secret QR, ni
--  effectif — l'ancienne version renvoyait la ligne `companies` entiere.

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
    IF p_code IS NULL OR length(btrim(p_code)) < 4 THEN
        RETURN NULL;
    END IF;

    SELECT c.id, c.name, lower(COALESCE(c.status, 'active')) AS status
      INTO v
      FROM public.companies c
     WHERE upper(btrim(c.company_code)) = upper(btrim(p_code))
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object('id', v.id, 'name', v.name, 'status', v.status);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.lookup_company_by_code(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.lookup_company_by_code(TEXT) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. CREER SON ENTREPRISE (compte CEO)
-- -----------------------------------------------------------------------------

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

    IF length(v_nom) < 2 THEN
        RAISE EXCEPTION 'Le nom de l''entreprise est trop court.';
    END IF;

    -- Idempotence : un double clic, ou une reprise apres confirmation de
    -- l'adresse, ne doit pas creer une seconde entreprise.
    SELECT m.company_id INTO v_exist
      FROM public.company_memberships m
     WHERE m.user_id = v_user AND m.role = 'CEO' AND m.status = 'ACTIVE'
     LIMIT 1;

    IF v_exist IS NOT NULL THEN
        RETURN jsonb_build_object('ok', TRUE, 'deja_cree', TRUE,
                                  'company_id', v_exist, 'user_id', v_user);
    END IF;

    INSERT INTO public.companies (name, plan, status)
    VALUES (v_nom, 'pro', 'active')
    RETURNING id INTO v_company;

    INSERT INTO public.users (id, company_id, email, full_name, role, job_title,
                              attendance_required, is_active)
    VALUES (v_user, v_company, v_email,
            COALESCE(NULLIF(btrim(p_full_name), ''), split_part(COALESCE(v_email, 'CEO'), '@', 1)),
            'CEO', 'Directeur Général / CEO', FALSE, TRUE)
    ON CONFLICT (id) DO UPDATE
        SET company_id = EXCLUDED.company_id,
            role       = 'CEO',
            full_name  = COALESCE(NULLIF(btrim(p_full_name), ''), public.users.full_name);

    INSERT INTO public.company_memberships (user_id, company_id, role, attendance_required, status)
    VALUES (v_user, v_company, 'CEO', FALSE, 'ACTIVE')
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object('ok', TRUE, 'deja_cree', FALSE,
                              'company_id', v_company, 'user_id', v_user);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. DEMANDER A REJOINDRE UNE ENTREPRISE (compte employe)
-- -----------------------------------------------------------------------------

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

    SELECT c.id, c.name, lower(COALESCE(c.status, 'active')) AS status
      INTO v_company
      FROM public.companies c
     WHERE upper(btrim(c.company_code)) = upper(btrim(COALESCE(p_code, '')))
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aucune entreprise ne correspond à ce code.';
    END IF;

    IF v_company.status IN ('suspended', 'expired', 'cancelled') THEN
        RAISE EXCEPTION 'L''abonnement de cette entreprise est suspendu.';
    END IF;

    INSERT INTO public.users (id, company_id, email, full_name, role, job_title,
                              phone_number, attendance_required, is_active)
    VALUES (v_user, v_company.id, v_email,
            COALESCE(NULLIF(btrim(p_full_name), ''), split_part(COALESCE(v_email, 'Employe'), '@', 1)),
            'EMPLOYEE', NULLIF(btrim(p_job_title), ''), NULLIF(btrim(p_phone), ''), TRUE, TRUE)
    ON CONFLICT (id) DO UPDATE
        SET full_name    = COALESCE(NULLIF(btrim(p_full_name), ''), public.users.full_name),
            phone_number = COALESCE(NULLIF(btrim(p_phone), ''), public.users.phone_number);

    -- Un rattachement deja actif n'est pas rejete : on renvoie son etat, et
    -- l'employe est dirige vers son tableau de bord plutot que vers une
    -- seconde demande d'approbation.
    SELECT m.status INTO v_statut
      FROM public.company_memberships m
     WHERE m.user_id = v_user AND m.company_id = v_company.id
     LIMIT 1;

    IF v_statut IS NULL THEN
        INSERT INTO public.company_memberships (user_id, company_id, role, attendance_required, status)
        VALUES (v_user, v_company.id, 'EMPLOYEE', TRUE, 'PENDING_APPROVAL');
        v_statut := 'PENDING_APPROVAL';
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

REVOKE EXECUTE ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
