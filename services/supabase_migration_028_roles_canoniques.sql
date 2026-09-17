-- =============================================================================
--  MIGRATION 028 — VOCABULAIRE DE ROLES UNIQUE : OWNER, ADMIN, MANAGER, EMPLOYEE
-- =============================================================================
--
--  A APPLIQUER APRES LE DEPLOIEMENT DU NOUVEAU SITE (auth/auth-flow.js).
--  ---------------------------------------------------------------------
--  Le site precedent ne reconnaissait que CEO et HR pour ouvrir la
--  configuration du pointage et les preuves de pointage : applique avant le
--  deploiement, ce renommage fermerait ces ecrans aux dirigeants. Le nouveau
--  site comprend les deux vocabulaires (roleCanonique), et la base aussi
--  depuis la migration 026 (normaliser_role_membre) : l'ordre « deployer,
--  puis appliquer » ne cree aucune interruption.
--
--  CE QUI CHANGE
--  -------------
--    CEO                          -> OWNER
--    HR, COMPANY_ADMIN, SUPER_ADMIN -> ADMIN   (dans une entreprise ; les
--                                               administrateurs de la plateforme
--                                               restent dans platform_admins)
--    FIELD_AGENT, tout role inconnu -> EMPLOYEE
--
--  Toute ecriture future est convertie au vol : un ancien onglet encore ouvert
--  qui ecrit « CEO » ou « HR » produit OWNER ou ADMIN, sans erreur.
--
--  AUCUNE DONNEE N'EST PERDUE
--  --------------------------
--  Le role d'origine de chaque ligne est copie dans `legacy_role` avant
--  conversion. Retour arriere :
--
--    BEGIN;
--    DROP TRIGGER IF EXISTS aa_normaliser_role ON public.company_memberships;
--    DROP TRIGGER IF EXISTS aa_normaliser_role ON public.users;
--    ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_role_check;
--    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
--    UPDATE public.company_memberships SET role = legacy_role WHERE legacy_role IS NOT NULL;
--    UPDATE public.users SET role = legacy_role WHERE legacy_role IS NOT NULL;
--    ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (upper(role::text) = ANY (ARRAY[
--        'OWNER','ADMIN','MANAGER','EMPLOYEE','SUPER_ADMIN','COMPANY_ADMIN','FIELD_AGENT','CEO','HR']));
--    CREATE OR REPLACE FUNCTION public.role_proprietaire_stocke() RETURNS TEXT
--        LANGUAGE sql IMMUTABLE AS $f$ SELECT 'CEO'::TEXT $f$;
--    COMMIT;
-- =============================================================================

BEGIN;

-- 1. Sauvegarde du role d'origine (une seule fois : une relance ne l'ecrase pas).
ALTER TABLE public.company_memberships ADD COLUMN IF NOT EXISTS legacy_role TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS legacy_role TEXT;

UPDATE public.company_memberships SET legacy_role = role WHERE legacy_role IS NULL;
UPDATE public.users SET legacy_role = role WHERE legacy_role IS NULL;

-- 2. Conversion au vol de toute ecriture.
--    Nom en « aa_ » : s'execute avant `users_bloquer_escalade` (ordre
--    alphabetique), sinon une ecriture « CEO » sur une fiche deja « OWNER »
--    passerait pour un changement de role.
CREATE OR REPLACE FUNCTION public.normaliser_role_ecriture()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.role := public.normaliser_role_membre(NEW.role);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_normaliser_role ON public.company_memberships;
CREATE TRIGGER aa_normaliser_role
    BEFORE INSERT OR UPDATE OF role ON public.company_memberships
    FOR EACH ROW EXECUTE FUNCTION public.normaliser_role_ecriture();

DROP TRIGGER IF EXISTS aa_normaliser_role ON public.users;
CREATE TRIGGER aa_normaliser_role
    BEFORE INSERT OR UPDATE OF role ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.normaliser_role_ecriture();

-- 3. Conversion des donnees existantes. Les controles de la migration 027 ne
--    s'appliquent pas ici : une migration ne s'execute pas sous le role
--    `authenticated`.
UPDATE public.company_memberships SET role = public.normaliser_role_membre(role)
 WHERE role IS DISTINCT FROM public.normaliser_role_membre(role);

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE public.users SET role = public.normaliser_role_membre(role)
 WHERE role IS DISTINCT FROM public.normaliser_role_membre(role);

-- 4. Vocabulaire strict.
ALTER TABLE public.users ADD CONSTRAINT users_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'));

ALTER TABLE public.company_memberships DROP CONSTRAINT IF EXISTS company_memberships_role_check;
ALTER TABLE public.company_memberships ADD CONSTRAINT company_memberships_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'));

-- 5. Les fonctions serveur ecrivent desormais OWNER pour le createur.
CREATE OR REPLACE FUNCTION public.role_proprietaire_stocke()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT 'OWNER'::TEXT;
$$;

COMMIT;
