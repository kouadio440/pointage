-- =============================================================================
--  MIGRATION 025 — Connexion Google : e-mail verifie obligatoire
-- =============================================================================
--
--  AVANT GOOGLE
--  ------------
--  La confirmation d'adresse est exigee a l'inscription par mot de passe :
--  aucune session n'existe tant que le lien n'a pas ete suivi. Les fonctions
--  `register_company()` et `join_company()` ne pouvaient donc etre appelees
--  que par une adresse deja prouvee — sans avoir a le verifier elles-memes.
--
--  AVEC GOOGLE
--  -----------
--  Une session s'ouvre des le retour de Google. C'est Google qui atteste
--  l'adresse, et un compte Google peut porter une adresse NON verifiee (compte
--  cree avec une adresse professionnelle jamais confirmee). Supabase renseigne
--  alors `email_confirmed_at` a NULL.
--
--  Sans garde, un tel compte pourrait creer une entreprise ou deposer une
--  demande de rattachement sous une adresse qu'il ne possede peut-etre pas —
--  et une demande de rattachement est precisement ce que le service RH
--  approuve en se fiant au nom et a l'adresse affiches.
--
--  La verification est faite ici, cote serveur, et vaut pour TOUS les modes de
--  connexion presents et futurs.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.compte_email_verifie()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM auth.users u
         WHERE u.id = auth.uid()
           AND u.email_confirmed_at IS NOT NULL
    );
$$;

REVOKE ALL ON FUNCTION public.compte_email_verifie() FROM PUBLIC, anon, authenticated;

-- Code SQLSTATE dedie, TM401 : le client doit distinguer ce refus d'une session
-- absente (42501). Les confondre ferait rejouer la demande indefiniment a
-- chaque connexion, sans jamais expliquer a l'utilisateur pourquoi.

-- -----------------------------------------------------------------------------
-- register_company : garde ajoutee en tete, corps inchange (migration 021)
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

    IF NOT public.compte_email_verifie() THEN
        RAISE EXCEPTION 'Adresse e-mail non vérifiée : confirmez-la avant de créer une entreprise.'
            USING ERRCODE = 'TM401', HINT = 'EMAIL_NON_VERIFIE';
    END IF;

    IF length(v_nom) < 2 THEN
        RAISE EXCEPTION 'Le nom de l''entreprise est trop court.';
    END IF;

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

-- -----------------------------------------------------------------------------
-- join_company : meme garde
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

-- CREATE OR REPLACE conserve les droits existants ; on les reaffirme pour que
-- ce fichier reste correct meme rejoue sur une base neuve.
REVOKE ALL ON FUNCTION public.register_company(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_company(TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_company(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
