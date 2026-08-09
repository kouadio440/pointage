# 🛡️ Winner Pointage — Documentation Technique & Mémoire Projet AI (gemini.md)

Ce fichier est la référence technique permanente du projet **Winner Pointage**. Il résume la vision de l'application, l'ensemble des fonctionnalités implémentées, la structure des fichiers, les choix de design ainsi que les consignes strictes à suivre pour tout modèle d'IA devant intervenir sur ce projet.

---

## 1. 📌 Aperçu du Projet & Vision

**Winner Pointage** est une plateforme B2B SaaS multi-entreprises de pointage mobile et web anti-fraude spécialement conçue pour les entreprises, PME et commerciaux sur le terrain en Côte d'Ivoire et en Afrique de l'Ouest.

### Problème résolu :
- Élimination des faux pointages et de la triche GPS (fake GPS, usurpation d'identité).
- Calcul automatique de la paie, des heures supplémentaires et des pénalités de retard.
- Pilotage commercial et RH centralisé pour le propriétaire SaaS (Super Admin) et les clients RH.

---

## 2. ⚡ Fonctionnalités Clés Implémentées

L'application est divisée en **3 vues principales** accessibles depuis la barre de navigation :

### A. 🏠 Vue 1 : Accueil Vitrine (Landing Page SaaS)
- **Hero Banner Interactif** : Présentation du pointage par géolocalisation geofence et QR code anti-usurpation.
- **Calculateur de ROI dynamique** : Saisie du nombre d'employés et du salaire moyen pour estimer les économies mensuelles générées en luttant contre les retards.
- **Grille des Tarifs & Abonnements** : Formules Starter, Pro et Entreprise avec switch annuel/mensuel.
- **Démonstrateur de Kiosque QR Code** : Simulation du pointage en temps réel avec timer de rotation de 30 secondes.
- **Gestion des Thèmes de Couleur** : Switcher de thèmes graphiques (Terracotta, Emerald, Amber).

### B. 📊 Vue 2 : Cockpit Client RH (Espace Entreprise)
- **Vue d'Ensemble des Présences** : KPIs d'effectif, présent(e)s, retardataires, absents et congés.
- **Pointage GPS & Geofence** : Carte interactive des zones autorisées avec rayon de tolérance.
- **Registre des Employés & Commerciaux Terrain** :
  - Barre de recherche textuelle en temps réel pour filtrer les employés par nom, rôle ou matricule.
  - Statistiques individuelles, statut de présence et raccourcis d'appel / action.
- **Gestion des Congés & Absences** : Validation/Refus des demandes avec mise à jour du quota.
- **Calculateur Automatique de Retards & Heures Supps** : Grille d'impact financier et majorations (+25%, +50%).
- **Sécurité & Alertes Faux GPS** : Journal d'audit des tentatives d'altération de position GPS et des blocages automatiques.
- **QR Code Kiosque** : Compteur dynamique 30s réinitialisant le code pour empêcher les captures d'écran transmises entre collègues.
- **Exportation de Rapports** : Téléchargement simulé de synthèses mensuelles au format PDF/Excel.

### C. 👑 Vue 3 : Tableau de Bord Propriétaire SaaS (Super Admin)
Accessible via le bouton **"Mon Dashboard SaaS"**, il regroupe l'ensemble des 11 KPIs stratégiques :
1. **Nombre d'Entreprises Total** (ex: 42 entreprises)
2. **Entreprises Actives** (ex: 38 actives)
3. **Nombre d'Abonnements Actifs**
4. **Paiements & Historique des Transactions**
5. **Revenus Mensuels (MRR)** (ex: 4.050.000 FCFA)
6. **Revenus Annuels (ARR)** (ex: 48.600.000 FCFA)
7. **Nombre d'Employés Actifs Global** (ex: 1.280 collaborateurs)
8. **Essais Expirés & Relances Commerciales** (ex: 3 en relance)
9. **Comptes Suspendus / Impayés** (ex: 1 compte bloqué)
10. **Tickets Support Client** (ex: 2 ouverts)
11. **Logs Système & Journal d'Audit Technique**

### D. 📅 Calendrier Interactif & Planning des Échéances SaaS
Inclus dans le Dashboard SaaS pour piloter les revenus et opérations :
- **Sélecteur de Date Natif dans l'En-tête (`Datepicker`)** : Permet de choisir n'importe quelle date et de mettre à jour le dashboard.
- **Grille Mensuelle Interactive** : Navigation mois par mois avec raccourci *"Aujourd'hui"*.
- **Points d'Indicateurs par Catégorie** :
  - 🟢 **Prélèvements / Abonnements Clients**
  - 🟠 **Fins de Périodes d'Essai**
  - 🔵 **Maintenances Système & Serveurs**
  - 🟣 **Renouvellements Grands Comptes**
- **Saisie & Gestion des Plages Horaires (`08:00 - 18:00`)** :
  - Champs `Heure Début` et `Heure Fin` dans le formulaire modal.
  - Alternance entre `📋 Vue Liste` et `⏰ Plages Horaires (08h - 18h)`.
  - Réservation directe sur créneaux horaires libres en 1 clic.
- **Formulaire Modal d'Ajout (`+ Ajouter Échéance`)** & Bouton de suppression.

### E. 🔐 Authentification & Inscription
- Boutons **"Se Connecter"** et **"Inscription"** dans la barre de navigation fixe et le menu mobile burger.
- Modale d'authentification réactive.

---

## 3. 📂 Structure Répertoire du Projet (Monorepo)

```
pointage/
├── apps/
│   ├── web/                     # Single Page Application (Front-end principal)
│   │   ├── index.html           # Structure HTML5 principale (Nav, Hero, Dashboard RH, SaaS, Modales)
│   │   ├── app.js               # Logique JS (Gestion du d’État, Calendrier, Barre de recherche, Modales, Toast)
│   │   └── styles.css           # Custom CSS glassmorphism & effets
│   ├── api/                     # Backend Node.js / Express / Prisma API
│   │   ├── package.json
│   │   └── src/
│   └── app/                     # React / Mobile Web App (@pointage/app)
│       └── package.json
├── packages/                    # Paquets partagés Monorepo
│   ├── design-tokens/           # Constantes de style
│   └── shared/                  # Utilities TS/JS partagées
├── services/                    # Microservices
│   └── face/                    # Service de reconnaissance faciale anti-fraude
├── scripts/
│   └── serve-web.mjs            # Serveur Web Node.js ultra-léger zéro-dépendance (port 8080)
├── docker-compose.yml           # Configuration Docker & services
├── gemini.md                    # 🧠 Ce document de référence pour les modèles IA
├── package.json                 # Pnpm workspace root
├── pnpm-workspace.yaml          # Conf workspaces
└── turbo.json                   # Conf TurboRepo
```

---

## 4. 🛠️ Stack Technique & Dépendances

| Composant | Technologie Utilisée |
| :--- | :--- |
| **Front-End** | HTML5 Sémantique, Vanilla JavaScript (ES6+), Tailwind CSS (via CDN) |
| **Iconographie** | Lucide Icons (`data-lucide="..."`) |
| **Serveur Local Dev** | Node.js (Script léger `scripts/serve-web.mjs` sans dépendance lourde) |
| **Gestionnaire de Monorepo** | `pnpm` workspaces + `TurboRepo` |
| **Back-End (Stack API)** | Node.js, Express, Prisma ORM, PostgreSQL (via Docker) |
| **Thème Visuel** | Dark Mode Premium (Glassmorphism, Slate-900/95, accents Amber & Emerald) |

---

## 5. 🎨 Décisions de Design & UX

1. **Largeur Maximale des Conteneurs (`max-w-7xl`)** :
   - La navigation `<nav>` et le conteneur principal `<main>` doivent impérativement conserver les classes `max-w-7xl mx-auto px-4 sm:px-6` pour offrir une vue aérée et spacieuse aussi bien sur l'Accueil que sur le Cockpit RH.
2. **Design Glassmorphism Slate-900** :
   - Fond sombre haut de gamme avec des effets de transparence floutée (`backdrop-blur-md`), des bordures fines `border-slate-800` et des touches de brillance amber/emerald (`glow-amber`).
3. **Navigation Fluide sans Rechargement** :
   - Le basculement entre les vues est géré par la fonction JS `switchView(viewName)` qui affiche/masque les sections `.view-section`.
4. **Feedback Utilisateur par Toasts** :
   - Toutes les actions (filtres, enregistrements, suppressions, notifications) déclenchent un Toast élégant via `showToast(title, message, type)`.

---

## 6. 🤖 Instructions Strictes pour les Modèles IA Futurs

Lorsque vous intervenez sur ce projet, vous **DEVEZ** respecter les consignes suivantes :

1. **Conteneurs de Page (`max-w-7xl`)** :
   - **Ne restreignez JAMAIS** la largeur globale de `<nav>` ou de `<main>` (garder `max-w-7xl mx-auto px-4 sm:px-6`).
2. **Sécurité des IDs HTML & State JS** :
   - Ne modifiez ni ne supprimez les IDs principaux servant au ciblage DOM (`view-hero`, `view-saas`, `view-dashboard`, `saas-section-calendar`, `saas-calendar-days`, `saas-calendar-events`, `saas-header-datepicker`, `company-search-input`, `modal-add-event`).
3. **Synchronisation du State Calendrier** :
   - Tout événement ajouté ou supprimé doit mettre à jour l'objet global `calendarState.events` et rappeler immédiatement `renderSaasCalendar()`.
4. **Maintien de l'Exécution du Serveur Web** :
   - Le serveur local tourne via `node scripts/serve-web.mjs 8080`. Ne modifiez pas l'adresse d'écoute `http://localhost:8080` de l'application web.
5. **Conventions des Commits Git** :
   - Formatez vos messages de commit de manière claire :
     - `feat(web): ...` pour une nouvelle fonctionnalité.
     - `fix(web): ...` pour une correction de bug ou de disposition.
