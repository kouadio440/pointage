-- =============================================================================
-- Winner Pointage — Migration 005 : colonnes manquantes sur public.companies
--
-- Idempotente. A executer apres les migrations precedentes.
--
-- CORRECTIF
-- ---------
-- supabase_schema.sql declare company_code, employee_prefix et employee_counter,
-- mais la base en production ne les possede pas : le schema a ete applique
-- partiellement, ou la base est anterieure a leur ajout.
--
-- Consequence observee : loadSupabaseData() tente
--     update companies set company_code = ... 
-- ce qui echoue avec « column company_code does not exist ». L'exception
-- interrompt la fonction AVANT loadPendingRegistrations(), et le Cockpit RH
-- n'affiche donc aucune demande d'inscription, alors qu'elles existent bien.
-- =============================================================================

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS company_code     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS employee_prefix  VARCHAR(20) DEFAULT 'EMP',
    ADD COLUMN IF NOT EXISTS employee_counter INT DEFAULT 0;

-- Unicite du code d'entreprise (utilise pour l'auto-inscription des employes).
CREATE UNIQUE INDEX IF NOT EXISTS companies_company_code_key
    ON public.companies (company_code)
    WHERE company_code IS NOT NULL;

-- Attribution d'un code aux entreprises existantes qui n'en ont pas.
-- Format aligne sur celui de l'application : trois lettres, puis deux groupes.
UPDATE public.companies c
SET company_code = upper(
        substr(regexp_replace(c.name, '[^a-zA-Z]', '', 'g') || 'XXX', 1, 2)
        || '-' || substr(md5(c.id::text), 1, 4)
        || '-' || substr(md5(c.id::text), 5, 4)
    )
WHERE c.company_code IS NULL;

-- Compteur de matricules aligne sur l'effectif deja cree, afin que la prochaine
-- generation ne reattribue pas un matricule existant.
UPDATE public.companies c
SET employee_counter = GREATEST(
        COALESCE(c.employee_counter, 0),
        COALESCE((
            SELECT max(NULLIF(regexp_replace(u.registration_number, '\D', '', 'g'), '')::int)
            FROM public.users u
            WHERE u.company_id = c.id AND u.registration_number IS NOT NULL
        ), 0)
    );
