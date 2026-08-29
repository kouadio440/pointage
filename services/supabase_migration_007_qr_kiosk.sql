-- =============================================================================
-- Winner Pointage — Migration 007 : QR code kiosque dynamique
--
-- Idempotente. A executer apres les migrations precedentes.
--
-- PRINCIPE
-- --------
-- Le QR affiche sur la borne n'est PAS un identifiant statique : c'est un jeton
-- signe par le serveur, valable une fenetre de quelques dizaines de secondes,
-- et consommable une seule fois par employe.
--
-- Sans cela, un QR imprime ou photographie permettrait de pointer depuis
-- n'importe ou, ce qui viderait le geofencing de son sens.
--
-- Trois protections, toutes evaluees cote serveur :
--   1. SIGNATURE  — HMAC-SHA256 avec un secret propre au site. Un jeton forge
--                   ailleurs est rejete (QR_FORGED).
--   2. FENETRE    — le compteur derive de l'horloge serveur ; on accepte la
--                   fenetre courante et la precedente, pour tolerer le temps
--                   de scan. Au-dela : QR_EXPIRED.
--   3. ANTI-REJEU — le triplet (site, compteur, employe) n'est utilisable
--                   qu'une fois. Une capture d'ecran partagee echoue : QR_REPLAY.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- =============================================================================
-- 1. Parametres QR par site
-- =============================================================================

ALTER TABLE public.geofences
    ADD COLUMN IF NOT EXISTS qr_enabled      BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS qr_rotation_sec INT DEFAULT 30,
    -- Secret propre au site. Sa rotation invalide instantanement tous les QR
    -- en circulation, y compris les captures d'ecran.
    ADD COLUMN IF NOT EXISTS qr_secret       TEXT;

ALTER TABLE public.geofences
    DROP CONSTRAINT IF EXISTS geofences_qr_rotation_sane;
ALTER TABLE public.geofences
    ADD CONSTRAINT geofences_qr_rotation_sane
    CHECK (qr_rotation_sec BETWEEN 15 AND 300);

-- Attribution d'un secret aux sites qui n'en ont pas encore.
UPDATE public.geofences
SET qr_secret = encode(gen_random_bytes(32), 'hex')
WHERE qr_secret IS NULL;


-- =============================================================================
-- 2. Jetons consommes — anti-rejeu
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.qr_consumed (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
    site_id    UUID REFERENCES public.geofences(id) ON DELETE CASCADE NOT NULL,
    user_id    UUID REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
    counter    BIGINT NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Le coeur de la protection anti-rejeu.
    CONSTRAINT qr_consumed_unique UNIQUE (site_id, counter, user_id)
);

CREATE INDEX IF NOT EXISTS idx_qr_consumed_cleanup
    ON public.qr_consumed (consumed_at);

ALTER TABLE public.qr_consumed ENABLE ROW LEVEL SECURITY;

-- Aucune politique d'ecriture : seule record_attendance (SECURITY DEFINER)
-- insere ici. Un client ne doit pas pouvoir « pre-consommer » un jeton.
DROP POLICY IF EXISTS "qr_consumed_select_company" ON public.qr_consumed;
CREATE POLICY "qr_consumed_select_company" ON public.qr_consumed
FOR SELECT TO authenticated
USING (public.can_view_company_attendance(company_id));


-- =============================================================================
-- 3. Signature d'un jeton
--
-- Fonction interne, jamais exposee au client : elle donnerait le moyen de
-- fabriquer un jeton valide pour n'importe quelle fenetre.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.qr_sign(p_site_id UUID, p_counter BIGINT, p_secret TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT substr(
        translate(
            encode(
                hmac(p_site_id::text || ':' || p_counter::text, p_secret, 'sha256'),
                'base64'
            ),
            '+/=', '-_'
        ),
        1, 22
    );
$$;

REVOKE ALL ON FUNCTION public.qr_sign(UUID, BIGINT, TEXT) FROM PUBLIC;


-- =============================================================================
-- 4. Jeton courant, pour l'affichage sur la borne
--
-- Reserve aux roles qui configurent l'entreprise : la borne est ouverte par un
-- responsable, pas par un employe. Un employe qui pourrait appeler cette
-- fonction n'aurait plus besoin d'etre devant l'ecran.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.generate_site_qr_token(p_site_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.generate_site_qr_token(UUID) TO authenticated;


-- =============================================================================
-- 5. Rotation du secret d'un site
--
-- Invalide instantanement tous les QR en circulation. A utiliser des qu'une
-- capture d'ecran a pu fuiter.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rotate_site_qr_secret(p_site_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_company UUID;
BEGIN
    SELECT company_id INTO v_company FROM public.geofences WHERE id = p_site_id;
    IF v_company IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'SITE_NOT_FOUND');
    END IF;

    IF NOT public.can_configure_company(v_company) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'FORBIDDEN',
            'message', 'Action réservée au CEO et au service RH.');
    END IF;

    UPDATE public.geofences
       SET qr_secret = encode(gen_random_bytes(32), 'hex')
     WHERE id = p_site_id;

    RETURN jsonb_build_object('ok', TRUE,
        'message', 'Secret régénéré. Tous les QR codes précédents sont invalides.');
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_site_qr_secret(UUID) TO authenticated;


-- =============================================================================
-- 6. Validation d'un jeton, appelee depuis record_attendance
--
-- Renvoie le site_id si le jeton est valide, sinon un code de refus.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.qr_validate(p_token TEXT, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_parts   TEXT[];
    v_site_id UUID;
    v_counter BIGINT;
    v_sig     TEXT;
    v_site    public.geofences%ROWTYPE;
    v_rot     INT;
    v_now     BIGINT;
BEGIN
    IF p_token IS NULL OR length(trim(p_token)) = 0 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_MISSING');
    END IF;

    v_parts := string_to_array(p_token, '.');
    IF array_length(v_parts, 1) <> 3 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_FORGED');
    END IF;

    BEGIN
        v_site_id := v_parts[1]::uuid;
        v_counter := v_parts[2]::bigint;
    EXCEPTION WHEN others THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_FORGED');
    END;
    v_sig := v_parts[3];

    SELECT * INTO v_site FROM public.geofences WHERE id = v_site_id;
    IF NOT FOUND OR v_site.qr_secret IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_FORGED');
    END IF;

    -- Signature d'abord : on ne revele rien sur la fenetre avant de l'avoir verifiee.
    IF v_sig IS DISTINCT FROM public.qr_sign(v_site_id, v_counter, v_site.qr_secret) THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_FORGED');
    END IF;

    v_rot := GREATEST(15, COALESCE(v_site.qr_rotation_sec, 30));
    v_now := FLOOR(EXTRACT(EPOCH FROM NOW()) / v_rot)::BIGINT;

    -- Fenetre courante ou precedente : le scan prend quelques secondes.
    IF v_counter <> v_now AND v_counter <> v_now - 1 THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_EXPIRED',
            'rotation_sec', v_rot);
    END IF;

    -- Anti-rejeu : la contrainte d'unicite fait foi.
    BEGIN
        INSERT INTO public.qr_consumed (company_id, site_id, user_id, counter)
        VALUES (v_site.company_id, v_site_id, p_user_id, v_counter);
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object('ok', FALSE, 'code', 'QR_REPLAY');
    END;

    RETURN jsonb_build_object('ok', TRUE, 'site_id', v_site_id, 'site_name', v_site.name);
END;
$$;

REVOKE ALL ON FUNCTION public.qr_validate(TEXT, UUID) FROM PUBLIC;


-- =============================================================================
-- 7. Purge des jetons consommes
--
-- Une ligne ne sert plus des que sa fenetre est passee. On garde 24 h pour
-- l'audit, puis on nettoie : cette table grossirait sinon indefiniment.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.purge_qr_consumed()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_n INT;
BEGIN
    DELETE FROM public.qr_consumed WHERE consumed_at < NOW() - INTERVAL '24 hours';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;
