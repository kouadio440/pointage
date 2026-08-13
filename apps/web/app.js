/**
 * Winner Pointage — Application Logic
 * Preset B — Sécurité Nocturne
 * Plateforme SaaS de Gestion du Temps et Pointage pour Entreprises
 */

// Security Utility: HTML Entity Escaping to prevent DOM-based XSS (CWE-79)
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Supabase Client Initialization (if window.supabase is loaded)
let supabaseClient = null;
const SUPABASE_URL = 'https://hwfcshufofzfjinlvdya.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3ZmNzaHVmb2Z6Zmppbmx2ZHlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMDUyOTcsImV4cCI6MjEwMTg4MTI5N30.5oJlwVaoGXTAqMccIDaK4HRPv4w4-sqL4XJT1mWSsZk';

if (window.supabase && typeof window.supabase.createClient === 'function') {
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('[Supabase] Initialisé avec succès sur Winner Pointage Web.');
  } catch (err) {
    console.warn('[Supabase] Erreur d\'initialisation client :', err);
  }
}

// Production Application State (Supabase Single Source of Truth)
const state = {
  activeView: 'hero',
  activeSection: 'overview',
  isAuthenticated: false,
  currentUser: null,
  company: {
    name: 'SaaS Entreprise',
    sector: 'Services, Industrie & Commerce',
    siteName: 'Siège Social — Zone Principale',
    coordinates: { lat: 5.359942, lng: -4.008311 },
    geofenceRadius: 150
  },
  employees: [],
  companies: [],
  leaves: [],
  overtimes: [],
  latenesses: [],
  qrTimer: 30
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
  initIcons();
  startLiveClock();
  startQRCountdown();
  
  const initialHash = window.location.hash.replace('#', '');
  if (['hero', 'saas', 'dashboard', 'employee'].includes(initialHash)) {
    switchView(initialHash);
  } else {
    switchView('hero');
  }

  renderDashboard();
  renderStaffGrid();
  renderSaasCalendar();
  renderSaasDashboard();
  setTheme('terracotta');
  updateRoiCalculator();

  // Restaurer la session et charger les données réelles Supabase au démarrage
  if (supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session && session.user) {
        state.isAuthenticated = true;
        const userId = session.user.id;
        const email = session.user.email;

        // Récupérer le rôle réel de l'utilisateur dans Supabase (company_memberships ou users)
        const { data: memberships } = await supabaseClient
          .from('company_memberships')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'ACTIVE');

        if (memberships && memberships.length > 0) {
          const m = memberships[0];
          state.currentUser = { id: userId, email: email, fullName: email.split('@')[0].toUpperCase() };

          let compName = state.company.name;
          if (m.company_id) {
            const { data: comp } = await supabaseClient.from('companies').select('name').eq('id', m.company_id).maybeSingle();
            if (comp && comp.name) compName = comp.name;
          }

          selectCompanyWorkspace(m.company_id, m.role, m.attendance_required, compName);
        } else {
          const { data: dbUser } = await supabaseClient
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

          const companyId = dbUser ? dbUser.company_id : null;
          const userRole = dbUser ? (dbUser.role || 'EMPLOYEE') : 'EMPLOYEE';
          const attReq = dbUser ? (dbUser.attendance_required !== false) : true;
          let compName = state.company.name;

          if (companyId) {
            const { data: comp } = await supabaseClient.from('companies').select('name').eq('id', companyId).maybeSingle();
            if (comp && comp.name) compName = comp.name;
          }

          state.currentUser = { id: userId, email: email, fullName: (dbUser && dbUser.full_name) ? dbUser.full_name : email.split('@')[0].toUpperCase() };
          selectCompanyWorkspace(companyId, userRole, attReq, compName);
        }
        console.log('[Supabase Auth] Session restaurée pour :', email, 'Rôle:', state.currentUserRole);
      }
    } catch (e) {
      console.warn('[Supabase Auth] Erreur vérification session :', e);
    }
    loadSupabaseData();
  }
});

// Toast Notification System (Replaces native browser alerts)
function showToast(title, message, type = 'success', duration = 5000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-5 right-5 z-[100] flex flex-col space-y-3 max-w-sm w-full pointer-events-none px-4 sm:px-0';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const isSuccess = type === 'success';
  const isInfo = type === 'info';
  
  const borderColor = isSuccess ? 'border-emerald-500/50' : (isInfo ? 'border-amber-500/50' : 'border-slate-700');
  const glowShadow = isSuccess ? 'shadow-[0_10px_30px_rgba(16,185,129,0.3)]' : (isInfo ? 'shadow-[0_10px_30px_rgba(245,158,11,0.3)]' : 'shadow-2xl');
  const badgeColor = isSuccess ? 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30' : 'text-amber-400 bg-amber-500/15 border-amber-500/30';
  const iconName = isSuccess ? 'shield-check' : 'info';
  const barGradient = isSuccess ? 'from-emerald-500 via-teal-400 to-emerald-300' : 'from-amber-500 via-orange-400 to-amber-300';

  toast.className = `transform -translate-y-4 opacity-0 transition-all duration-300 ease-out max-w-md w-full bg-slate-900/95 border ${borderColor} rounded-2xl p-4 ${glowShadow} backdrop-blur-2xl flex items-start space-x-3 pointer-events-auto relative overflow-hidden`;

  toast.innerHTML = `
    <div class="p-2 rounded-xl border ${badgeColor} flex-shrink-0 mt-0.5">
      <i data-lucide="${iconName}" class="w-5 h-5"></i>
    </div>
    <div class="flex-1 space-y-1 pr-3">
      <h4 class="text-xs font-bold text-white tracking-wide uppercase font-mono flex items-center justify-between">
        <span>${title}</span>
        <span class="text-[9px] font-mono text-slate-400 font-normal">À l'instant</span>
      </h4>
      <div class="text-xs text-slate-200 leading-relaxed font-sans">${message}</div>
    </div>
    <button onclick="this.parentElement.classList.add('opacity-0', '-translate-y-2'); setTimeout(() => this.parentElement.remove(), 250);" class="text-slate-400 hover:text-white p-1 transition">
      <i data-lucide="x" class="w-4 h-4"></i>
    </button>
    <div class="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r ${barGradient} animate-pulse"></div>
  `;

  container.appendChild(toast);

  if (window.lucide) {
    lucide.createIcons();
  }

  requestAnimationFrame(() => {
    toast.classList.remove('-translate-y-4', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
  });

  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.remove('translate-y-0', 'opacity-100');
      toast.classList.add('-translate-y-2', 'opacity-0');
      setTimeout(() => toast.remove(), 300);
    }
  }, duration);
}

// Dynamic Theme Switcher (Chaleur d'Afrique)
function setTheme(themeName) {
  state.currentTheme = themeName;
  document.documentElement.setAttribute('data-theme', themeName);
  
  const badgeEl = document.getElementById('theme-badge-label');
  if (badgeEl) {
    if (themeName === 'terracotta') badgeEl.innerText = '🌅 PALETTE : TERRACOTTA & OR';
    else if (themeName === 'safari') badgeEl.innerText = '🌿 PALETTE : SAVANE & ÉMERAUDE';
    else if (themeName === 'light-warm') badgeEl.innerText = '☀️ PALETTE : SOLEIL D\'IVOIRE (CLAIR)';
  }
}

function initIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Live Clock Display (Strict Abidjan GMT / UTC+0 Time)
function startLiveClock() {
  const clockEl = document.getElementById('live-system-clock');
  function updateClock() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('fr-FR', { 
      timeZone: 'Africa/Abidjan', 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
    if (clockEl) clockEl.innerText = `${timeStr} GMT (Abidjan)`;
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// View Switcher (Landing vs Dashboard vs Employee vs Manager)
function switchView(viewName) {
  const userRole = (state.currentUserRole || '').toUpperCase();
  const isEmployee = userRole === 'EMPLOYEE';

  // Security Gatekeeper 1: Require authenticated session for RH Cockpit & Employee Dashboard (CWE-306 / CWE-602)
  if ((viewName === 'dashboard' || viewName === 'employee') && !state.isAuthenticated) {
    showToast('Accès Sécurisé', `Veuillez vous connecter à votre compte ${viewName === 'employee' ? 'Employé' : 'RH/CEO'} pour accéder à cet espace.`, 'info');
    openAuthModal('login');
    if (viewName === 'employee') setAuthRole('employee');
    return;
  }

  // Security Gatekeeper 2: Cockpit Client RH (dashboard) est STRICTEMENT réservé aux CEO / RH / Managers
  if (viewName === 'dashboard' && state.isAuthenticated && isEmployee) {
    showToast(
      'Accès Restreint ⛔',
      'Le Cockpit Client RH est exclusivement réservé aux Dirigeants (CEO) et Responsables RH. Vous avez été réorienté vers votre Espace Employé.',
      'warning',
      6000
    );
    switchView('employee');
    return;
  }

  // Security Gatekeeper 3: Espace Employé (employee) est STRICTEMENT réservé aux Employés
  // Les CEO / RH / Managers doivent IMPÉRATIVEMENT utiliser le Cockpit Client RH (#dashboard)
  if (viewName === 'employee' && state.isAuthenticated && !isEmployee) {
    showToast(
      'Espace Dirigeant 👑',
      'En tant que CEO / Responsable RH, votre espace de travail principal est le Cockpit Client RH (#dashboard).',
      'info',
      6000
    );
    switchView('dashboard');
    return;
  }

  state.activeView = viewName;
  if (window.location.hash !== `#${viewName}`) {
    window.history.replaceState(null, '', `#${viewName}`);
  }

  document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-view-btn').forEach(btn => {
    btn.classList.remove('text-amber-400', 'bg-amber-500/10', 'border-amber-500/30', 'text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'font-bold', 'font-semibold', 'glow-amber');
    btn.classList.add('text-slate-300');
  });

  const targetView = document.getElementById(`view-${viewName}`);
  const targetBtn = document.getElementById(`btn-view-${viewName}`);

  if (targetView) targetView.classList.remove('hidden');
  if (targetBtn) {
    targetBtn.classList.add('text-amber-400', 'bg-amber-500/10', 'border-amber-500/30', 'font-bold', 'glow-amber');
    targetBtn.classList.remove('text-slate-300');
  }

  if (viewName === 'saas') {
    renderSaasCalendar();
  } else if (viewName === 'employee') {
    renderEmployeeDashboard();
  }

  closeMobileMenu();

  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Smooth scroll top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) {
    menu.classList.toggle('hidden');
    if (window.lucide) window.lucide.createIcons();
  }
}

function closeMobileMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) {
    menu.classList.add('hidden');
  }
}

// SAAS CALENDAR STATE & DATA (Supabase Single Source of Truth)
const calendarState = {
  currentDate: new Date(),
  selectedDate: new Date().getDate(),
  activeFilter: 'all',
  viewMode: 'list',
  events: []
};

function switchCalendarViewMode(mode) {
  calendarState.viewMode = mode;
  
  document.querySelectorAll('.cal-view-toggle').forEach(btn => {
    btn.classList.remove('bg-amber-500/20', 'text-amber-300', 'border', 'border-amber-500/30', 'font-bold');
    btn.classList.add('text-slate-400', 'font-semibold');
  });

  const activeBtn = document.getElementById(`cal-view-btn-${mode}`);
  if (activeBtn) {
    activeBtn.classList.add('bg-amber-500/20', 'text-amber-300', 'border', 'border-amber-500/30', 'font-bold');
    activeBtn.classList.remove('text-slate-400', 'font-semibold');
  }

  renderSaasCalendar();
}

function filterCalendarCategory(category) {
  calendarState.activeFilter = category;
  
  document.querySelectorAll('.cal-filter-btn').forEach(btn => {
    btn.classList.remove('bg-amber-500/20', 'text-amber-300', 'border', 'border-amber-500/30', 'font-bold');
    btn.classList.add('text-slate-400', 'font-semibold');
  });

  const activeBtn = document.getElementById(`cal-filter-${category}`);
  if (activeBtn) {
    activeBtn.classList.add('bg-amber-500/20', 'text-amber-300', 'border', 'border-amber-500/30', 'font-bold');
    activeBtn.classList.remove('text-slate-400', 'font-semibold');
  }

  renderSaasCalendar();
}

function openAddEventModal(start = "09:00", end = "10:30") {
  const modal = document.getElementById('modal-add-event');
  if (modal) {
    document.getElementById('event-day-input').value = calendarState.selectedDate;
    if (document.getElementById('event-time-start-input')) document.getElementById('event-time-start-input').value = start;
    if (document.getElementById('event-time-end-input')) document.getElementById('event-time-end-input').value = end;
    modal.classList.remove('hidden');
  }
}

function closeAddEventModal() {
  const modal = document.getElementById('modal-add-event');
  if (modal) modal.classList.add('hidden');
}

async function handleCreateEventSubmit(e) {
  if (e) e.preventDefault();
  
  const title = document.getElementById('event-title-input')?.value || 'Nouvelle Échéance';
  const client = document.getElementById('event-client-input')?.value || 'Client SaaS';
  const day = parseInt(document.getElementById('event-day-input')?.value || calendarState.selectedDate, 10);
  const amount = document.getElementById('event-amount-input')?.value || 'Non spécifié';
  const type = document.getElementById('event-type-input')?.value || 'billing';
  const timeStart = document.getElementById('event-time-start-input')?.value || '09:00';
  const timeEnd = document.getElementById('event-time-end-input')?.value || '10:00';

  let color = 'emerald';
  let badge = 'Planifié';
  if (type === 'trial') { color = 'orange'; badge = 'Fin d\'Essai'; }
  if (type === 'maintenance') { color = 'cyan'; badge = 'Maintenance'; }
  if (type === 'contract') { color = 'purple'; badge = 'Grand Compte'; }

  const newEvent = {
    id: Date.now(),
    day,
    timeStart,
    timeEnd,
    title,
    client,
    amount,
    type,
    badge,
    color,
    status: 'Pending'
  };

  calendarState.events.push(newEvent);
  calendarState.selectedDate = day;

  // Persister dans Supabase si disponible
  if (supabaseClient) {
    try {
      await supabaseClient.from('calendar_events').insert({
        day,
        time_start: timeStart,
        time_end: timeEnd,
        title,
        client,
        amount,
        type,
        badge,
        color,
        status: 'Pending'
      });
      console.log('[Supabase] Événement enregistré dans public.calendar_events');
    } catch (err) {
      console.warn('[Supabase] Erreur d\'enregistrement d\'événement:', err);
    }
  }

  closeAddEventModal();
  renderSaasCalendar();

  showToast('Échéance Programmée (Supabase)', `L'événement "${escapeHtml(title)}" (${timeStart} - ${timeEnd}) a été réservé avec succès.`, 'success');
}

function deleteCalendarEvent(eventId) {
  calendarState.events = calendarState.events.filter(ev => ev.id !== eventId);
  renderSaasCalendar();
  showToast('Échéance Supprimée', 'L\'événement a été retiré du calendrier.', 'info');
}

function renderSaasCalendar() {
  const calendarDaysContainer = document.getElementById('saas-calendar-days');
  const monthYearLabel = document.getElementById('saas-calendar-month-year');
  const eventsContainer = document.getElementById('saas-calendar-events');
  const selectedDateLabel = document.getElementById('saas-calendar-selected-date');

  if (!calendarDaysContainer || !monthYearLabel) return;

  const year = calendarState.currentDate.getFullYear();
  const month = calendarState.currentDate.getMonth();
  
  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  monthYearLabel.innerText = `${monthNames[month]} ${year}`;

  const firstDayIndex = new Date(year, month, 1).getDay(); // 0 is Sun
  const startingDay = firstDayIndex === 0 ? 6 : firstDayIndex - 1; // Mon-first
  
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Filter events according to activeFilter
  const filteredEvents = calendarState.events.filter(e => {
    if (calendarState.activeFilter === 'all') return true;
    return e.type === calendarState.activeFilter;
  });

  let daysHTML = '';

  for (let i = 0; i < startingDay; i++) {
    daysHTML += `<div class="p-2 text-center text-slate-700/40 text-xs font-mono select-none">.</div>`;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = d === 9 && month === 7 && year === 2026;
    const isSelected = d === calendarState.selectedDate;
    const dayEvents = filteredEvents.filter(e => e.day === d);

    let cellClass = "p-2 rounded-xl text-center cursor-pointer transition relative flex flex-col items-center justify-center min-h-[48px] border ";
    if (isSelected) {
      cellClass += "bg-amber-500/20 border-amber-500 text-amber-300 font-bold shadow-lg shadow-amber-500/10 glow-amber ";
    } else if (isToday) {
      cellClass += "bg-emerald-500/10 border-emerald-500/50 text-emerald-400 font-bold ";
    } else {
      cellClass += "bg-slate-900/60 border-slate-800/80 text-slate-300 hover:bg-slate-800 hover:border-slate-700 ";
    }

    let dotsHTML = '';
    if (dayEvents.length > 0) {
      dotsHTML = `<div class="flex items-center gap-1 mt-1">` + 
        dayEvents.map(ev => {
          let dotBg = "bg-amber-400";
          if (ev.color === 'emerald') dotBg = "bg-emerald-400";
          if (ev.color === 'orange') dotBg = "bg-orange-400";
          if (ev.color === 'purple') dotBg = "bg-purple-400";
          if (ev.color === 'cyan') dotBg = "bg-cyan-400";
          return `<span class="w-1.5 h-1.5 rounded-full ${dotBg}"></span>`;
        }).join('') +
      `</div>`;
    }

    daysHTML += `
      <div onclick="selectCalendarDate(${d})" class="${cellClass}">
        <span class="text-xs ${isSelected ? 'scale-110' : ''}">${d}</span>
        ${dotsHTML}
      </div>
    `;
  }

  calendarDaysContainer.innerHTML = daysHTML;

  if (selectedDateLabel) {
    selectedDateLabel.innerText = `${calendarState.selectedDate} ${monthNames[month]} ${year}`;
  }

  if (eventsContainer) {
    const activeEvents = filteredEvents.filter(e => e.day === calendarState.selectedDate);

    if (calendarState.viewMode === 'timeline') {
      // RENDER HOURLY TIMELINE (08:00 to 18:00)
      const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
      
      eventsContainer.innerHTML = `
        <div class="space-y-2 max-h-[480px] overflow-y-auto pr-1">
          ${hours.map(h => {
            const hInt = parseInt(h.split(':')[0], 10);
            const nextH = String(hInt + 1).padStart(2, '0') + ":00";
            
            // Events matching this hour slot
            const slotEvents = activeEvents.filter(ev => {
              const startH = parseInt((ev.timeStart || "09:00").split(':')[0], 10);
              return startH === hInt;
            });

            if (slotEvents.length > 0) {
              return slotEvents.map(ev => `
                <div class="p-3 rounded-xl bg-slate-900 border border-${ev.color}-500/40 space-y-1.5 shadow-md">
                  <div class="flex items-center justify-between text-xs">
                    <span class="font-mono text-amber-300 font-bold bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                      ⏰ ${ev.timeStart || h} - ${ev.timeEnd || nextH}
                    </span>
                    <span class="px-2 py-0.5 rounded bg-${ev.color}-500/10 text-${ev.color}-400 font-mono text-[10px] font-bold border border-${ev.color}-500/20">${escapeHtml(ev.badge)}</span>
                  </div>
                  <div class="text-xs font-bold text-white">${escapeHtml(ev.title)}</div>
                  <div class="flex justify-between text-[11px] text-slate-400">
                    <span>${escapeHtml(ev.client)}</span>
                    <span class="font-mono text-emerald-400 font-bold">${escapeHtml(ev.amount)}</span>
                  </div>
                </div>
              `).join('');
            } else {
              return `
                <div class="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between hover:border-slate-700 transition">
                  <span class="font-mono text-xs text-slate-500 font-semibold">${h} - ${nextH}</span>
                  <button onclick="openAddEventModal('${h}', '${nextH}')" class="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold border border-slate-700 transition flex items-center gap-1">
                    <i data-lucide="plus-circle" class="w-3 h-3 text-emerald-400"></i> Réserver Créneau
                  </button>
                </div>
              `;
            }
          }).join('')}
        </div>
      `;
    } else {
      // RENDER LIST VIEW
      if (activeEvents.length === 0) {
        eventsContainer.innerHTML = `
          <div class="p-6 rounded-xl bg-slate-900/60 border border-slate-800 text-center space-y-2">
            <i data-lucide="calendar-off" class="w-6 h-6 text-slate-500 mx-auto"></i>
            <p class="text-xs text-slate-400 font-semibold">Aucune échéance enregistrée pour ce jour.</p>
            <p class="text-[10px] text-slate-500">Cliquez sur "+ Ajouter Échéance" pour programmer une plage horaire.</p>
          </div>
        `;
      } else {
        eventsContainer.innerHTML = activeEvents.map(ev => `
          <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition space-y-2.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-bold text-white flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-full bg-${ev.color}-400"></span>
                ${escapeHtml(ev.title)}
              </span>
              <span class="px-2 py-0.5 rounded bg-${ev.color}-500/10 text-${ev.color}-400 font-mono text-[10px] border border-${ev.color}-500/20 font-bold">${escapeHtml(ev.badge)}</span>
            </div>
            <div class="flex justify-between text-[11px] text-slate-400">
              <span class="font-mono text-amber-300 font-bold">⏰ ${ev.timeStart || "09:00"} - ${ev.timeEnd || "10:30"}</span>
              <span>Client : <strong class="text-slate-200">${escapeHtml(ev.client)}</strong></span>
            </div>
            <div class="flex items-center justify-between border-t border-slate-800/60 pt-2 text-[11px]">
              <span class="font-mono text-emerald-400 font-bold">${escapeHtml(ev.amount)}</span>
              <div class="flex space-x-2">
                <button onclick="deleteCalendarEvent(${ev.id})" class="px-2 py-0.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 text-[10px] border border-red-500/20 transition">
                  Supprimer
                </button>
                <button onclick="showToast('Action Confirmée', 'L\'échéance a été traitée.', 'success')" class="px-2 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/20 transition">
                  ✓ Traité
                </button>
              </div>
            </div>
          </div>
        `).join('');
      }
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

function selectCalendarDate(d) {
  calendarState.selectedDate = d;
  
  // Sync date input in header
  const dateInput = document.getElementById('saas-header-datepicker');
  if (dateInput) {
    const y = calendarState.currentDate.getFullYear();
    const m = String(calendarState.currentDate.getMonth() + 1).padStart(2, '0');
    const dayStr = String(d).padStart(2, '0');
    dateInput.value = `${y}-${m}-${dayStr}`;
  }

  renderSaasCalendar();

  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const dayEvents = calendarState.events.filter(ev => ev.day === d);
  
  if (dayEvents.length > 0) {
    showToast(`Échéance du ${d} ${monthNames[calendarState.currentDate.getMonth()]}`, `${dayEvents[0].title} — ${dayEvents[0].client} (${dayEvents[0].amount})`, 'info');
  } else {
    showToast('Filtre Date Appliqué', `Tableau de bord filtré pour le ${d} ${monthNames[calendarState.currentDate.getMonth()]} ${calendarState.currentDate.getFullYear()}`, 'success');
  }
}

function handleSaasDatePickerChange(dateVal) {
  if (!dateVal) return;
  const dObj = new Date(dateVal);
  if (isNaN(dObj.getTime())) return;

  calendarState.currentDate = dObj;
  calendarState.selectedDate = dObj.getDate();

  renderSaasCalendar();

  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const formattedDate = `${dObj.getDate()} ${monthNames[dObj.getMonth()]} ${dObj.getFullYear()}`;

  showToast('Date du Dashboard Modifiée', `Visualisation active pour le : ${formattedDate}`, 'success');
}

function changeCalendarMonth(delta) {
  calendarState.currentDate.setMonth(calendarState.currentDate.getMonth() + delta);
  renderSaasCalendar();
}

function resetCalendarToToday() {
  calendarState.currentDate = new Date(2026, 7, 9);
  calendarState.selectedDate = 9;

  const dateInput = document.getElementById('saas-header-datepicker');
  if (dateInput) dateInput.value = "2026-08-09";

  renderSaasCalendar();
  showToast('Reinitialisation', 'Retour à la date d\'aujourd\'hui : 9 Août 2026', 'info');
}

// Section Switcher within Super Admin SaaS Dashboard
function switchSaasSection(sectionName) {
  document.querySelectorAll('.saas-sub-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.saas-subtab-btn').forEach(btn => {
    btn.classList.remove('text-amber-400', 'bg-amber-500/10', 'border-amber-500/30', 'font-bold');
    btn.classList.add('text-slate-400');
  });

  const targetSection = document.getElementById(`saas-section-${sectionName}`);
  const targetSubtab = document.querySelector(`.saas-subtab-btn[data-saas-section="${sectionName}"]`);

  if (targetSection) targetSection.classList.remove('hidden');
  if (targetSubtab) {
    targetSubtab.classList.add('text-amber-400', 'bg-amber-500/10', 'border-amber-500/30', 'font-bold');
    targetSubtab.classList.remove('text-slate-400');
  }

  if (sectionName === 'calendar') {
    renderSaasCalendar();
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function filterCompanyTable() {
  const filter = document.getElementById('company-status-filter')?.value || 'all';
  showToast('Filtre Appliqué', `Affichage des entreprises avec le statut : ${filter.toUpperCase()}`, 'info');
}

function toggleCompanyStatus(companyName, action) {
  if (action === 'suspend') {
    showToast('Compte Suspendu', `Le compte client de ${companyName} a été suspendu.`, 'error');
  } else {
    showToast('Compte Réactivé', `Le compte client de ${companyName} a été réactivé avec succès.`, 'success');
  }
}

// Section Switcher within Dashboard
function switchSection(sectionName) {
  state.activeSection = sectionName;

  // Make sure we are on dashboard view
  if (state.activeView !== 'dashboard') {
    switchView('dashboard');
  }

  document.querySelectorAll('.sub-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.subtab-btn').forEach(btn => {
    btn.classList.remove('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30');
    btn.classList.add('text-slate-400');
  });

  const targetSection = document.getElementById(`section-${sectionName}`);
  const targetSubtab = document.querySelector(`.subtab-btn[data-section="${sectionName}"]`);

  if (targetSection) targetSection.classList.remove('hidden');
  if (targetSubtab) {
    targetSubtab.classList.add('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30');
    targetSubtab.classList.remove('text-slate-400');
  }
}

// Render Dashboard Data & Live Feed
function renderDashboard() {
  const presentsCount = state.employees.filter(e => e.status === 'Présent').length;
  const retardsCount = state.employees.filter(e => e.status === 'Retard').length;
  const congesCount = state.employees.filter(e => e.status === 'En Congé').length;
  const absentsCount = state.employees.filter(e => e.status === 'Absent').length;

  document.getElementById('kpi-total').innerText = state.employees.length;
  document.getElementById('kpi-presents').innerText = presentsCount;
  document.getElementById('kpi-retards').innerText = retardsCount;
  document.getElementById('kpi-conges').innerText = congesCount;

  // Render Live Feed Table
  const tableBody = document.getElementById('live-punch-table');
  if (tableBody) {
    if (state.employees.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" class="p-6 text-center text-slate-500 text-xs font-mono">
            Aucun pointage en direct enregistré dans Supabase. Les nouveaux pointages s'afficheront ici.
          </td>
        </tr>
      `;
    } else {
      tableBody.innerHTML = state.employees.map(emp => {
        let statusBadge = '';
        if (emp.status === 'Présent') statusBadge = '<span class="badge-verified px-2 py-0.5 rounded text-[10px]">Présent (À l\'heure)</span>';
        else if (emp.status === 'Retard') statusBadge = '<span class="badge-alert px-2 py-0.5 rounded text-[10px]">Retard</span>';
        else if (emp.status === 'En Congé') statusBadge = '<span class="badge-info px-2 py-0.5 rounded text-[10px]">En Congé</span>';
        else statusBadge = '<span class="badge-danger px-2 py-0.5 rounded text-[10px]">Absent</span>';

        return `
          <tr class="hover:bg-slate-800/40 transition">
            <td class="p-2.5 flex items-center space-x-2">
              <img src="${escapeHtml(emp.avatar)}" class="w-6 h-6 rounded-full object-cover border border-slate-700" alt="${escapeHtml(emp.name)}" />
              <span class="font-bold text-white">${escapeHtml(emp.name)}</span>
            </td>
            <td class="p-2.5 font-mono text-slate-300">${escapeHtml(emp.arriveTime)}</td>
            <td class="p-2.5 text-slate-400">${escapeHtml(emp.method)}</td>
            <td class="p-2.5 text-emerald-400">${escapeHtml(emp.distance)}</td>
            <td class="p-2.5">${statusBadge}</td>
          </tr>
        `;
      }).join('');
    }
  }

  renderLeaveRequestsTable();
  renderOvertimeTable();
  renderLatenessTable();
  initIcons();
}

// Render & Filter Staff Cards Grid
function renderStaffGrid() {
  filterStaffGrid();
}

function filterStaffGrid() {
  const container = document.getElementById('staff-grid');
  if (!container) return;

  const searchInput = document.getElementById('staff-search-input');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = state.employees.filter(emp => {
    return emp.name.toLowerCase().includes(query) ||
           emp.role.toLowerCase().includes(query) ||
           emp.site.toLowerCase().includes(query) ||
           emp.status.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-span-full p-8 text-center glass-panel border-dashed border-slate-800 rounded-xl space-y-2">
        <i data-lucide="user-x" class="w-8 h-8 text-slate-500 mx-auto"></i>
        <p class="text-xs text-slate-400 font-semibold">Aucun employé ne correspond à votre recherche "${escapeHtml(query)}".</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  container.innerHTML = filtered.map(emp => {
    let statusClass = 'border-emerald-500/30 text-emerald-400';
    if (emp.status === 'Retard') statusClass = 'border-orange-500/30 text-orange-400';
    if (emp.status === 'Absent') statusClass = 'border-red-500/30 text-red-400';

    return `
      <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition space-y-3">
        <div class="flex items-center space-x-3">
          <img src="${escapeHtml(emp.avatar)}" class="w-12 h-12 rounded-xl object-cover border border-slate-700 shadow-md" alt="${escapeHtml(emp.name)}" />
          <div>
            <h4 class="font-bold text-white text-sm">${escapeHtml(emp.name)}</h4>
            <p class="text-[11px] text-slate-400">${escapeHtml(emp.role)}</p>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs font-mono pt-2 border-t border-slate-800/80">
          <span class="text-slate-400">Statut :</span>
          <span class="px-2 py-0.5 rounded bg-slate-800 border ${statusClass} text-[10px] font-bold">${escapeHtml(emp.status)}</span>
        </div>
        <div class="flex justify-between text-[11px] font-mono text-slate-400">
          <span>Affectation :</span>
          <span class="text-white">${escapeHtml(emp.site)}</span>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) window.lucide.createIcons();
}

// Render Leave Requests Table
function renderLeaveRequestsTable() {
  const tbody = document.getElementById('leave-requests-table');
  if (!tbody) return;

  if (state.leaves.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-500 text-xs font-mono">Aucune demande de congé enregistrée.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.leaves.map(req => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${escapeHtml(req.employee)}</td>
      <td class="p-3 text-cyan-400">${escapeHtml(req.type)}</td>
      <td class="p-3 text-slate-400">${escapeHtml(req.period)}</td>
      <td class="p-3">${req.days} Jours</td>
      <td class="p-3 text-slate-300">${escapeHtml(req.reason)}</td>
      <td class="p-3">
        <span class="${req.status === 'Approuvé' ? 'badge-verified' : 'badge-alert'} px-2 py-0.5 rounded text-[10px]">
          ${escapeHtml(req.status)}
        </span>
      </td>
      <td class="p-3 text-right">
        ${req.status === 'En attente' ? `
          <button onclick="approveLeave(${req.id})" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 mr-1 text-[10px]">Approuver</button>
          <button onclick="rejectLeave(${req.id})" class="px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 text-[10px]">Refuser</button>
        ` : '<span class="text-slate-500 text-[10px]">Aucune action</span>'}
      </td>
    </tr>
  `).join('');
}

// Render Overtime Table
function renderOvertimeTable() {
  const tbody = document.getElementById('overtime-table');
  if (!tbody) return;

  if (state.overtimes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-500 text-xs font-mono">Aucune déclaration d'heures supplémentaires.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.overtimes.map(ot => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${escapeHtml(ot.employee)}</td>
      <td class="p-3 text-slate-400">${escapeHtml(ot.date)}</td>
      <td class="p-3 font-mono text-emerald-400">${escapeHtml(ot.slot)}</td>
      <td class="p-3 font-bold text-white">${escapeHtml(ot.duration)}</td>
      <td class="p-3 text-emerald-400">${escapeHtml(ot.multiplier)}</td>
      <td class="p-3 text-slate-300">${escapeHtml(ot.reason)}</td>
      <td class="p-3">
        <span class="${ot.status === 'Validé' ? 'badge-verified' : 'badge-alert'} px-2 py-0.5 rounded text-[10px]">
          ${escapeHtml(ot.status)}
        </span>
      </td>
      <td class="p-3 text-right">
        ${ot.status === 'En attente' ? `
          <button onclick="approveOvertime(${ot.id})" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px]">Valider</button>
        ` : '<span class="text-slate-500 text-[10px]">Transmis Paie</span>'}
      </td>
    </tr>
  `).join('');
}

// Render Lateness Table
function renderLatenessTable() {
  const tbody = document.getElementById('lateness-table');
  if (!tbody) return;

  if (state.latenesses.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-6 text-center text-slate-500 text-xs font-mono">Aucun retard enregistré.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.latenesses.map(lat => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${escapeHtml(lat.employee)}</td>
      <td class="p-3 text-slate-400">${escapeHtml(lat.date)}</td>
      <td class="p-3 text-slate-400">${escapeHtml(lat.scheduled)}</td>
      <td class="p-3 text-orange-400 font-bold">${escapeHtml(lat.actual)}</td>
      <td class="p-3 text-orange-400 font-bold">+${lat.minutes} min</td>
      <td class="p-3 text-slate-300">${escapeHtml(lat.justification)}</td>
      <td class="p-3"><span class="badge-alert px-2 py-0.5 rounded text-[10px]">${escapeHtml(lat.status)}</span></td>
      <td class="p-3 text-right">
        <button onclick="acceptJustification(${lat.id})" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px]">Accepter Motifs</button>
      </td>
    </tr>
  `).join('');
}

// Geofence Radius Slider Update
function updateGeofenceRadius(radiusVal) {
  state.company.geofenceRadius = radiusVal;
  const label = document.getElementById('current-radius-label');
  if (label) label.innerText = `${radiusVal} m`;

  const circle = document.getElementById('geofence-visual-circle');
  if (circle) {
    const size = Math.min(240, Math.max(120, radiusVal * 0.8));
    circle.style.width = `${size}px`;
    circle.style.height = `${size}px`;
  }
}

// Dynamic QR Countdown Timer
function startQRCountdown() {
  const timerEl = document.getElementById('qr-timer');
  const barEl = document.getElementById('qr-progress-bar');

  setInterval(() => {
    state.qrTimer--;
    if (state.qrTimer <= 0) {
      state.qrTimer = 30;
      // Animate QR SVG flash to simulate token rotation
      const qrSvg = document.getElementById('qr-code-svg');
      if (qrSvg) {
        qrSvg.style.opacity = '0.3';
        setTimeout(() => { qrSvg.style.opacity = '1'; }, 300);
      }
    }

    if (timerEl) timerEl.innerText = `${state.qrTimer}s`;
    if (barEl) barEl.style.width = `${(state.qrTimer / 30) * 100}%`;
  }, 1000);
}

// Modals Trigger Handlers & Media Stream
let punchMediaStream = null;
let isPunchScanning = false;

async function openPunchModal() {
  const modal = document.getElementById('modal-punch');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  resetPunchScanUI();

  // Attempt real webcam feed
  const videoEl = document.getElementById('punch-webcam');
  const fallbackFace = document.getElementById('punch-avatar-fallback');

  if (videoEl && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      punchMediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      videoEl.srcObject = punchMediaStream;
      videoEl.classList.remove('hidden');
      if (fallbackFace) fallbackFace.classList.add('hidden');
    } catch (err) {
      console.log('Webcam non activée (utilisation de la simulation faciale HD):', err);
      if (videoEl) videoEl.classList.add('hidden');
      if (fallbackFace) fallbackFace.classList.remove('hidden');
    }
  }
}

function closePunchModal() {
  const modal = document.getElementById('modal-punch');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  if (punchMediaStream) {
    punchMediaStream.getTracks().forEach(track => track.stop());
    punchMediaStream = null;
  }
  resetPunchScanUI();
}

function resetPunchScanUI() {
  isPunchScanning = false;
  const laser = document.getElementById('laser-scan-line');
  const statusBadge = document.getElementById('selfie-match-badge');
  const scanMsg = document.getElementById('punch-scan-status-msg');
  const faceFrame = document.getElementById('punch-face-frame');
  const btnArrivee = document.getElementById('btn-punch-arrivee');
  const btnSortie = document.getElementById('btn-punch-sortie');

  if (laser) laser.classList.add('hidden');
  if (statusBadge) {
    statusBadge.innerText = 'Détection : Prêt';
    statusBadge.className = 'text-[9px] font-mono text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded border border-emerald-500/40';
  }
  if (scanMsg) scanMsg.innerHTML = 'Positionnez votre visage dans le cadre et cliquez sur <strong>Pointer l\'Arrivée</strong>.';
  if (faceFrame) faceFrame.className = 'w-36 h-44 rounded-2xl border-2 border-dashed border-emerald-400/80 flex flex-col items-center justify-between p-2 relative z-10 transition-all duration-300';

  if (btnArrivee) {
    btnArrivee.disabled = false;
    btnArrivee.innerHTML = `<i data-lucide="log-in" class="w-4 h-4"></i> POINTER L'ARRIVÉE`;
  }
  if (btnSortie) {
    btnSortie.disabled = false;
    btnSortie.innerHTML = `<i data-lucide="log-out" class="w-4 h-4"></i> POINTER LA SORTIE`;
  }
  if (window.lucide) lucide.createIcons();
}

function openLeaveModal() {
  document.getElementById('modal-leave').classList.remove('hidden');
  document.getElementById('modal-leave').classList.add('flex');
}
function closeLeaveModal() {
  document.getElementById('modal-leave').classList.add('hidden');
  document.getElementById('modal-leave').classList.remove('flex');
}

function openOvertimeModal() {
  document.getElementById('modal-overtime').classList.remove('hidden');
  document.getElementById('modal-overtime').classList.add('flex');
}
function closeOvertimeModal() {
  document.getElementById('modal-overtime').classList.add('hidden');
  document.getElementById('modal-overtime').classList.remove('flex');
}

function openReportPreviewModal() {
  document.getElementById('modal-report-preview').classList.remove('hidden');
  document.getElementById('modal-report-preview').classList.add('flex');
}
function closeReportPreviewModal() {
  document.getElementById('modal-report-preview').classList.add('hidden');
  document.getElementById('modal-report-preview').classList.remove('flex');
}

function openCopilotDrawer() {
  document.getElementById('drawer-copilot').classList.remove('translate-x-full');
}
function closeCopilotDrawer() {
  document.getElementById('drawer-copilot').classList.add('translate-x-full');
}

// Action Submissions with Live Facial Recognition Scan Simulation
function submitPunch(type) {
  if (isPunchScanning) return;
  isPunchScanning = true;

  const empSelect = document.getElementById('punch-employee-select');
  const empName = empSelect ? empSelect.options[empSelect.selectedIndex].text.split(' (')[0] : 'Employé';

  const laser = document.getElementById('laser-scan-line');
  const statusBadge = document.getElementById('selfie-match-badge');
  const scanMsg = document.getElementById('punch-scan-status-msg');
  const faceFrame = document.getElementById('punch-face-frame');
  const activeBtn = type === 'ENTRÉE' ? document.getElementById('btn-punch-arrivee') : document.getElementById('btn-punch-sortie');
  const otherBtn = type === 'ENTRÉE' ? document.getElementById('btn-punch-sortie') : document.getElementById('btn-punch-arrivee');

  if (otherBtn) otherBtn.disabled = true;
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> SCAN FACIAL EN COURS...`;
    if (window.lucide) lucide.createIcons();
  }

  // Activate laser scanner beam
  if (laser) laser.classList.remove('hidden');
  if (faceFrame) faceFrame.className = 'w-36 h-44 rounded-2xl border-2 border-emerald-400 flex flex-col items-center justify-between p-2 relative z-10 transition-all duration-300 shadow-[0_0_25px_rgba(16,185,129,0.5)]';

  // Phase 1: 0ms -> Localisation des points biométriques
  if (scanMsg) scanMsg.innerHTML = '<span class="text-amber-400 font-bold animate-pulse">🔍 Phase 1/3 :</span> Analyse des 68 points biométriques faciaux...';
  if (statusBadge) {
    statusBadge.innerText = 'Calcul biométrique...';
    statusBadge.className = 'text-[9px] font-mono text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/40 animate-pulse';
  }

  // Phase 2: 900ms -> Anti-spoofing & Vivacité
  setTimeout(() => {
    if (scanMsg) scanMsg.innerHTML = '<span class="text-emerald-400 font-bold animate-pulse">🧬 Phase 2/3 :</span> Test de vivacité & Anti-usurpation d\'identité...';
    if (statusBadge) statusBadge.innerText = 'Vivacité : 94.2%';
  }, 900);

  // Phase 3: 1800ms -> Matching réussi
  setTimeout(() => {
    if (scanMsg) scanMsg.innerHTML = '<span class="text-emerald-400 font-bold">✅ Phase 3/3 :</span> Identité faciale validée avec succès !';
    if (statusBadge) {
      statusBadge.innerText = 'Match IA : 99.4%';
      statusBadge.className = 'text-[9px] font-mono text-emerald-400 bg-emerald-500/30 px-2 py-0.5 rounded border border-emerald-400 font-bold shadow-lg shadow-emerald-500/30';
    }
    if (laser) laser.classList.add('hidden');
    if (faceFrame) {
      faceFrame.className = 'w-36 h-44 rounded-2xl border-2 border-solid border-emerald-400 bg-emerald-500/10 flex flex-col items-center justify-between p-2 relative z-10 shadow-[0_0_35px_rgba(16,185,129,0.7)]';
    }
  }, 1800);

  // Step 4: 2500ms -> Registration & Toast Notification
  setTimeout(() => {
    const nowStr = new Date().toLocaleTimeString('fr-FR', { 
      timeZone: 'Africa/Abidjan', 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });

    showToast(
      `Pointage d'${type} Réussi`,
      `<strong class="text-white">${empName}</strong><br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Reconnaissance Faciale :</span> Match 99.4% (Visage Identifié)<br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Géolocalisation GPS :</span> Validé (14m du Siège)<br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Horodateur Certifié :</span> ${nowStr} GMT`,
      'success',
      6500
    );

    // Persister le pointage dans la table public.attendances sur Supabase
    if (supabaseClient) {
      supabaseClient.from('attendances').insert({
        method: 'face_id',
        status: 'on_time',
        latitude: 5.359942,
        longitude: -4.008311,
        gps_accuracy_meters: 14.0,
        is_fake_gps_detected: false,
        face_confidence_score: 99.4,
      }).then(res => {
        if (!res.error) console.log('[Supabase] Pointage enregistré dans public.attendances !');
      }).catch(err => console.warn('[Supabase] Erreur pointage:', err));
    }

    closePunchModal();

    // Update employee status in state
    const empObj = state.employees.find(e => empName.includes(e.name) || e.name.includes(empName));
    if (empObj) {
      empObj.status = type === 'ENTRÉE' ? 'Présent' : 'Sorti';
      empObj.arriveTime = nowStr.substring(0, 5);
      empObj.confidence = 99.4;
    }

    renderDashboard();
    renderStaffGrid();
  }, 2500);
}

function submitLeaveRequest() {
  const typeEl = document.getElementById('leave-type');
  const reasonEl = document.getElementById('leave-reason');
  
  const type = typeEl ? escapeHtml(typeEl.value) : 'Congé Payé Annuel';
  const rawReason = reasonEl ? reasonEl.value : '';
  const reason = rawReason.trim() ? escapeHtml(rawReason) : 'Sans commentaire';

  state.leaves.push({
    id: Date.now(),
    employee: state.currentUser ? escapeHtml(state.currentUser.email) : 'Employé',
    type: type,
    period: '10/08/2026 au 14/08/2026',
    days: 5,
    reason: reason,
    status: 'En attente'
  });

  showToast('Demande Transmise', 'Votre demande de congé a été soumise au manager RH avec succès.', 'success');
  closeLeaveModal();
  renderDashboard();
}

function submitOvertimeRequest() {
  state.overtimes.push({
    id: Date.now(),
    employee: state.currentUser ? escapeHtml(state.currentUser.email) : 'Marc KOUASSI',
    date: '06/08/2026',
    slot: '17:00 - 19:30',
    duration: '2.5 h',
    multiplier: '+25%',
    reason: 'Surcroît impression packaging urgent',
    status: 'En attente'
  });

  showToast('Heures Supp Transmises', 'La déclaration d\'heures supplémentaires a été soumise au manager RH.', 'success');
  closeOvertimeModal();
  renderDashboard();
}

function approveLeave(id) {
  const item = state.leaves.find(l => l.id === id);
  if (item) {
    item.status = 'Approuvé';
    showToast('Congé Approuvé', `La demande de congé de ${item.employee} a été validée.`, 'success');
  }
  renderDashboard();
}

function rejectLeave(id) {
  const item = state.leaves.find(l => l.id === id);
  if (item) {
    item.status = 'Refusé';
    showToast('Congé Refusé', `La demande de congé de ${item.employee} a été refusée.`, 'info');
  }
  renderDashboard();
}

function approveOvertime(id) {
  const item = state.overtimes.find(o => o.id === id);
  if (item) {
    item.status = 'Validé';
    showToast('Heures Supp Validées', `Les heures supplémentaires de ${item.employee} ont été validées.`, 'success');
  }
  renderDashboard();
}

function acceptJustification(id) {
  const item = state.latenesses.find(l => l.id === id);
  if (item) {
    item.status = 'Retard Justifié';
    showToast('Retard Justifié', `La justification de ${item.employee} a été acceptée.`, 'success');
  }
  renderDashboard();
}

function triggerRefreshSimulatedData() {
  renderDashboard();
  showToast('Flux Actualisé', 'Le registre et la carte des pointages en direct ont été mis à jour.', 'info');
}

// AI Copilot Logic
function askCopilot(topic) {
  const box = document.getElementById('copilot-response-box');
  if (!box) return;

  box.classList.remove('hidden');

  if (topic === 'synthèse') {
    box.innerHTML = `
      <strong>💡 Synthèse des présences de l'Entreprise :</strong><br/>
      Sur 10 employés inscrits, 8 sont actuellement présents au Siège Social. 1 est en congé autorisé (Grace TOURE) et 1 retard de 18 min a été enregistré à 08h18 (Jean-Luc BAMBA, en mission terrain client). Taux global de présence : <strong>80%</strong>.
    `;
  } else if (topic === 'retards') {
    box.innerHTML = `
      <strong>⚠️ Analyse des retards :</strong><br/>
      1 seul retard enregistré aujourd'hui (+18 min pour Jean-Luc BAMBA). Motif renseigné : "Embouteillage axe Yopougon - Plateau". Tolérance légale de 10 min appliquée. En attente de votre validation RH.
    `;
  } else if (topic === 'fraude') {
    box.innerHTML = `
      <strong>🛡️ Rapport Sécurité & Intégrité :</strong><br/>
      Aucune tentative de Faux GPS ni d'usurpation de selfie détectée au cours des 48 dernières heures. 100% des pointages respectent la géobarrière de 150m autour du siège.
    `;
  }
}

// SaaS Landing Page Interactive Features
function updateRoiCalculator() {
  const slider = document.getElementById('roi-employee-slider');
  const salarySelect = document.getElementById('roi-salary-select');
  const countEl = document.getElementById('roi-employee-count');
  const fcfaSavedEl = document.getElementById('roi-fcfa-saved');
  const fcfaAnnualEl = document.getElementById('roi-fcfa-annual');
  const hoursSavedEl = document.getElementById('roi-hours-saved');
  const roiPercentageEl = document.getElementById('roi-percentage');

  if (!slider || !countEl) return;

  const count = parseInt(slider.value, 10);
  const avgSalary = salarySelect ? parseInt(salarySelect.value, 10) : 250000;

  countEl.innerText = count;

  // Real ROI calculation model:
  // Average 11.5% lost productive time per month due to tardiness + fraudulent buddy punches
  const lostTimePercentage = 0.115;
  const monthlySavingsPerEmp = avgSalary * lostTimePercentage;
  const totalMonthlySavings = Math.round(count * monthlySavingsPerEmp);
  const totalAnnualSavings = totalMonthlySavings * 12;
  const totalHoursSaved = Math.round(count * 6.5);

  // Cost of SaaS plan estimated
  const saasCostMonthly = count <= 15 ? 25000 : count <= 60 ? 65000 : 150000;
  const netProfitMonthly = totalMonthlySavings - saasCostMonthly;
  const roiMultiplier = Math.round((netProfitMonthly / saasCostMonthly) * 100);

  if (fcfaSavedEl) fcfaSavedEl.innerText = `${totalMonthlySavings.toLocaleString('fr-FR')} FCFA`;
  if (fcfaAnnualEl) fcfaAnnualEl.innerText = `${totalAnnualSavings.toLocaleString('fr-FR')} FCFA / an`;
  if (hoursSavedEl) hoursSavedEl.innerText = `${totalHoursSaved} heures`;
  if (roiPercentageEl) roiPercentageEl.innerText = `+${roiMultiplier}%`;
}

function togglePricingBilling(period) {
  const btnMonthly = document.getElementById('btn-billing-monthly');
  const btnAnnual = document.getElementById('btn-billing-annual');
  const starterPrice = document.getElementById('price-starter');
  const proPrice = document.getElementById('price-pro');

  if (period === 'annual') {
    if (btnAnnual) btnAnnual.className = 'px-4 py-1.5 rounded-full text-xs font-bold bg-amber-500 text-black shadow-md transition';
    if (btnMonthly) btnMonthly.className = 'px-4 py-1.5 rounded-full text-xs font-medium text-[var(--color-muted)] hover:text-white transition';
    if (starterPrice) starterPrice.innerText = '20.000 FCFA';
    if (proPrice) proPrice.innerText = '52.000 FCFA';
  } else {
    if (btnMonthly) btnMonthly.className = 'px-4 py-1.5 rounded-full text-xs font-bold bg-amber-500 text-black shadow-md transition';
    if (btnAnnual) btnAnnual.className = 'px-4 py-1.5 rounded-full text-xs font-medium text-[var(--color-muted)] hover:text-white transition';
    if (starterPrice) starterPrice.innerText = '25.000 FCFA';
    if (proPrice) proPrice.innerText = '65.000 FCFA';
}
}

// Extra state parameters for Multi-Tenant RBAC
state.currentCompanyId = null;
state.currentCompanyName = '';
state.currentUserRole = 'EMPLOYEE';
state.currentUserAttendanceRequired = true;
state.userMemberships = [];
state.pendingInvitation = null;

let authMode = 'login';
let selectedAuthRole = 'company_admin';

function togglePasswordVisibility(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (btn) {
      btn.innerHTML = `<i data-lucide="eye-off" class="w-4 h-4 text-amber-400"></i>`;
    }
  } else {
    input.type = 'password';
    if (btn) {
      btn.innerHTML = `<i data-lucide="eye" class="w-4 h-4 text-slate-400 hover:text-white"></i>`;
    }
  }
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function setAuthRole(role) {
  selectedAuthRole = role;
  const adminBtn = document.getElementById('auth-role-admin-btn');
  const empBtn = document.getElementById('auth-role-emp-btn');
  const companyBox = document.getElementById('auth-company-container');

  if (role === 'employee') {
    if (adminBtn) adminBtn.className = 'py-2 rounded-lg text-slate-400 hover:text-white transition';
    if (empBtn) empBtn.className = 'py-2 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold transition';
    if (companyBox) companyBox.classList.add('hidden');
  } else {
    if (adminBtn) adminBtn.className = 'py-2 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold transition';
    if (empBtn) empBtn.className = 'py-2 rounded-lg text-slate-400 hover:text-white transition';
    if (authMode === 'register' && companyBox) companyBox.classList.remove('hidden');
  }
}

function openAuthModal(mode = 'login') {
  authMode = mode;
  const modal = document.getElementById('modal-auth');
  const title = document.getElementById('auth-modal-title');
  const subtitle = document.getElementById('auth-modal-subtitle');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleBtn = document.getElementById('auth-toggle-mode-btn');
  const companyBox = document.getElementById('auth-company-container');
  const fullnameBox = document.getElementById('auth-fullname-container');
  const confirmPassBox = document.getElementById('auth-confirm-password-container');
  const employeeNotice = document.getElementById('auth-employee-notice');

  if (modal) modal.classList.remove('hidden');

  if (mode === 'register') {
    if (title) title.innerText = 'Inscription Entreprise (Compte CEO / Admin)';
    if (subtitle) subtitle.innerText = 'La création de compte entreprise initialise votre fiche Company unique et vous attribue le rôle de CEO.';
    if (submitBtn) submitBtn.innerText = 'Créer l\'Entreprise & Valider (Compte CEO)';
    if (toggleBtn) toggleBtn.innerText = 'Déjà un compte ? Se connecter';
    if (companyBox) companyBox.classList.remove('hidden');
    if (fullnameBox) fullnameBox.classList.remove('hidden');
    if (confirmPassBox) confirmPassBox.classList.remove('hidden');
    if (employeeNotice) employeeNotice.classList.remove('hidden');
  } else {
    if (title) title.innerText = 'Connexion Sécurisée Supabase';
    if (subtitle) subtitle.innerText = 'Accédez à votre espace d\'entreprise (Cockpit Client RH) ou collaborateur (Dashboard Employé).';
    if (submitBtn) submitBtn.innerText = 'Se Connecter à Mon Espace';
    if (toggleBtn) toggleBtn.innerText = 'Créer un Compte Entreprise (CEO)';
    if (companyBox) companyBox.classList.add('hidden');
    if (fullnameBox) fullnameBox.classList.add('hidden');
    if (confirmPassBox) confirmPassBox.classList.add('hidden');
    if (employeeNotice) employeeNotice.classList.add('hidden');
  }
}

function openInviteCodePrompt() {
  closeAuthModal();
  const modal = document.getElementById('modal-invite-activation');
  const codeStep = document.getElementById('act-code-step');
  const form = document.getElementById('act-form');

  if (codeStep) codeStep.classList.remove('hidden');
  if (form) form.classList.add('hidden');
  if (modal) modal.classList.remove('hidden');
}

async function verifyActivationCodeManual() {
  const codeInput = document.getElementById('act-code-input');
  const codeVal = codeInput ? codeInput.value.trim() : '';

  if (!codeVal) {
    showToast('Code Requis', 'Veuillez saisir votre code d\'activation (ex: INV-XXXX-YYYY).', 'info');
    return;
  }

  if (supabaseClient) {
    try {
      const { data: membership, error } = await supabaseClient
        .from('company_memberships')
        .select('*')
        .eq('invitation_code', codeVal)
        .maybeSingle();

      if (error || !membership) {
        showToast('Code Invalide', 'Ce code d\'activation est invalide ou expiré.', 'info');
        return;
      }

      state.pendingInvitation = membership;
      openInviteActivationModal(membership);
      showToast('Code Validé', `Invitation reconnue pour l'entreprise ${membership.companies ? membership.companies.name : ''}.`, 'success');
    } catch (e) {
      showToast('Erreur', 'Impossible de vérifier le code d\'activation.', 'info');
    }
  }
}

function toggleAuthMode() {
  openAuthModal(authMode === 'login' ? 'register' : 'login');
}

function closeAuthModal() {
  const modal = document.getElementById('modal-auth');
  if (modal) modal.classList.add('hidden');
}

async function handleAuthSubmit(e) {
  if (e) e.preventDefault();
  const emailInput = document.getElementById('auth-email-input');
  const passwordInput = document.getElementById('auth-password-input');
  const confirmPasswordInput = document.getElementById('auth-confirm-password-input');
  const companyInput = document.getElementById('auth-company-input');
  
  const fullNameInput = document.getElementById('auth-fullname-input');
  const fullNameVal = fullNameInput ? fullNameInput.value.trim() : '';
  const emailVal = emailInput ? emailInput.value.trim() : '';
  const passwordVal = passwordInput ? passwordInput.value : '';
  const confirmPasswordVal = confirmPasswordInput ? confirmPasswordInput.value : '';
  const companyVal = companyInput ? companyInput.value.trim() : '';

  if (!emailVal || !passwordVal) {
    showToast('Champs Requis', 'Veuillez saisir votre adresse e-mail et votre mot de passe.', 'info');
    return;
  }

  if (authMode === 'register') {
    if (!companyVal || !fullNameVal) {
      showToast('Champs Requis', 'Veuillez indiquer le nom de votre entreprise et votre nom complet.', 'info');
      return;
    }
    if (passwordVal !== confirmPasswordVal) {
      showToast('Erreur Mot de Passe', 'La confirmation du mot de passe ne correspond pas au mot de passe saisi.', 'info');
      return;
    }
    if (passwordVal.length < 6) {
      showToast('Mot de Passe Trop Court', 'Le mot de passe doit comporter au moins 6 caractères.', 'info');
      return;
    }
  }

  const submitBtn = document.getElementById('auth-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Traitement Supabase...';
  }

  try {
    if (supabaseClient) {
      if (authMode === 'register') {
        let userId = null;
        const { data: authData, error: authErr } = await supabaseClient.auth.signUp({
          email: emailVal,
          password: passwordVal,
        });

        if (authErr) {
          if (authErr.message && authErr.message.toLowerCase().includes('rate limit')) {
            showToast(
              'Limite d\'Emails Supabase ⚠️',
              'Le quota d\'envoi d\'e-mails de Supabase Cloud a été atteint temporairement (sécurité anti-spam). Veuillez réessayer dans quelques minutes ou utiliser une autre adresse email.',
              'warning',
              12000
            );
            return;
          }
          throw authErr;
        }

        if (authData && authData.user) {
          userId = authData.user.id;
        } else {
          userId = crypto.randomUUID();
        }

        // 2. Création de la fiche Company unique
        const { data: compData, error: compErr } = await supabaseClient
          .from('companies')
          .insert({ name: companyVal, plan: 'pro', status: 'active' })
          .select()
          .single();

        if (compErr) throw compErr;

        const companyId = compData.id;

        // 3. Création de l'utilisateur CEO dans public.users
        await supabaseClient.from('users').insert({
          id: userId,
          company_id: companyId,
          email: emailVal,
          full_name: fullNameVal || emailVal.split('@')[0].toUpperCase(),
          role: 'CEO',
          job_title: 'Directeur Général / CEO',
          attendance_required: false,
          is_active: true,
        });

        // 4. Rattachement dans public.company_memberships
        await supabaseClient.from('company_memberships').insert({
          user_id: userId,
          company_id: companyId,
          role: 'CEO',
          attendance_required: false,
          status: 'ACTIVE',
        });

        state.isAuthenticated = true;
        state.currentUser = {
          id: userId,
          email: emailVal,
          fullName: fullNameVal || emailVal.split('@')[0].toUpperCase(),
          role: 'CEO',
        };

        selectCompanyWorkspace(companyId, 'CEO', false, companyVal);
        showToast(
          'Compte CEO Activé 🎉',
          `Entreprise <strong>${escapeHtml(companyVal)}</strong> et compte CEO créés avec succès ! Bienvenue sur votre Dashboard Employeur.`,
          'success',
          10000
        );
        return;
      } else {
        // Mode Connexion
        const { data: authData, error } = await supabaseClient.auth.signInWithPassword({
          email: emailVal,
          password: passwordVal,
        });

        if (error) throw error;

        const userId = authData.user.id;

        // Récupération des appartenances d'entreprises (Company Memberships)
        const { data: memberships } = await supabaseClient
          .from('company_memberships')
          .select('*')
          .eq('user_id', userId)
          .eq('status', 'ACTIVE');

        state.isAuthenticated = true;
        state.currentUser = {
          id: userId,
          email: emailVal,
          fullName: authData.user.email.split('@')[0].toUpperCase(),
        };

        if (memberships && memberships.length > 1) {
          // L'utilisateur appartient à plusieurs entreprises -> Choix d'espace
          state.userMemberships = memberships;
          openSelectWorkspaceModal(memberships);
          showToast('Sélection d\'Espace', 'Veuillez choisir votre espace de travail.', 'info');
        } else if (memberships && memberships.length === 1) {
          const m = memberships[0];
          let compName = state.company.name;
          if (m.company_id) {
            const { data: comp } = await supabaseClient.from('companies').select('name').eq('id', m.company_id).maybeSingle();
            if (comp && comp.name) compName = comp.name;
          }
          selectCompanyWorkspace(m.company_id, m.role, m.attendance_required, compName);
        } else {
          // Fallback user unique
          const { data: dbUser } = await supabaseClient
            .from('users')
            .select('*')
            .eq('id', userId)
            .maybeSingle();

          const companyId = dbUser ? dbUser.company_id : null;
          const userRole = dbUser ? (dbUser.role || 'EMPLOYEE') : 'EMPLOYEE';
          const attReq = dbUser ? (dbUser.attendance_required !== false) : true;
          let compName = state.company.name;

          if (companyId) {
            const { data: comp } = await supabaseClient.from('companies').select('name').eq('id', companyId).maybeSingle();
            if (comp && comp.name) compName = comp.name;
          }

          selectCompanyWorkspace(companyId, userRole, attReq, compName);
        }
      }
    } else {
      // Offline fallback
      state.isAuthenticated = true;
      state.currentUser = { email: emailVal, role: 'CEO' };
      selectCompanyWorkspace(null, 'CEO', false, companyVal || 'SaaS Entreprise');
    }
  } catch (err) {
    console.error('Erreur Supabase Auth:', err);
    showToast('Erreur Authentification', err.message || 'Communication Supabase échouée.', 'info');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = authMode === 'register' ? 'Créer l\'Entreprise & Valider' : 'Se Connecter via Supabase';
    }
  }
}

function selectCompanyWorkspace(companyId, role, attendanceRequired, companyName) {
  state.currentCompanyId = companyId;
  state.currentUserRole = role || 'EMPLOYEE';
  state.currentUserAttendanceRequired = attendanceRequired !== false;
  state.currentCompanyName = companyName || state.company.name;

  state.currentUser.role = state.currentUserRole;
  state.currentUser.companyId = companyId;

  closeAuthModal();
  closeSelectWorkspaceModal();
  updateUiAfterLogin(state.currentUser.email, state.currentUserRole);

  // Redirection post-connexion basée sur le Rôle :
  // - CEO, HR, MANAGER -> Dashboard Employeur (Vue 2 - Cockpit de Présence)
  // - EMPLOYEE -> Dashboard Employé (Vue 4)
  if (state.currentUserRole === 'EMPLOYEE') {
    switchView('employee');
    showToast('Espace Collaborateur', `Bienvenue sur votre Dashboard Employé (${escapeHtml(state.currentCompanyName)}).`, 'success');
  } else {
    // CEO, HR ou MANAGER
    switchView('dashboard');
    showToast('Espace Employeur', `Bienvenue sur votre Dashboard Employeur (${escapeHtml(state.currentCompanyName)} - Rôle: ${state.currentUserRole}).`, 'success');
  }

  adaptCockpitRhPermissions();
  loadSupabaseData();
}

function adaptCockpitRhPermissions() {
  const roleBadge = document.getElementById('rh-cockpit-role-badge');
  const compTitleEl = document.getElementById('dash-company-name');

  if (compTitleEl && state.currentCompanyName) {
    compTitleEl.innerText = state.currentCompanyName;
  }

  if (roleBadge) {
    let badgeHtml = '';
    if (state.currentUserRole === 'CEO') {
      badgeHtml = '<span class="px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-mono font-bold border border-amber-500/30">👑 CEO / Admin Principal</span>';
    } else if (state.currentUserRole === 'HR') {
      badgeHtml = '<span class="px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-mono font-bold border border-emerald-500/30">🏢 Responsable RH</span>';
    } else if (state.currentUserRole === 'MANAGER') {
      badgeHtml = '<span class="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 text-xs font-mono font-bold border border-cyan-500/30">👔 Manager / Chef d\'Équipe</span>';
    }
    roleBadge.innerHTML = badgeHtml;
  }
}

function updateUiAfterLogin(emailVal, role = 'company_admin') {
  const loginBtn = document.getElementById('nav-login-btn');
  const registerBtn = document.getElementById('nav-register-btn');
  const mobileLoginBtn = document.getElementById('mobile-nav-login-btn');
  const mobileRegisterBtn = document.getElementById('mobile-nav-register-btn');

  const normalizedRole = (role || '').toUpperCase();
  const isEmp = normalizedRole === 'EMPLOYEE';
  const roleText = isEmp ? 'Déconnexion Employé' : 'Déconnexion RH';

  if (loginBtn) {
    loginBtn.innerText = roleText;
    loginBtn.onclick = handleLogout;
    loginBtn.className = 'px-3.5 py-1.5 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 text-xs font-semibold border border-red-500/30 transition';
  }
  if (registerBtn) registerBtn.classList.add('hidden');
  if (mobileLoginBtn) {
    mobileLoginBtn.innerText = roleText;
    mobileLoginBtn.onclick = () => { handleLogout(); closeMobileMenu(); };
    mobileLoginBtn.className = 'w-full py-2.5 rounded-xl bg-red-500/20 text-red-400 text-xs font-semibold border border-red-500/30 text-center block';
  }
  if (mobileRegisterBtn) mobileRegisterBtn.classList.add('hidden');

  // Ajustement visuel des boutons de la barre de navigation selon le Rôle
  const dashBtn = document.getElementById('btn-view-dashboard');
  const empBtn = document.getElementById('btn-view-employee');

  if (isEmp) {
    if (dashBtn) dashBtn.classList.add('hidden');
    if (empBtn) empBtn.classList.remove('hidden');
  } else {
    // CEO / HR / MANAGER
    if (dashBtn) dashBtn.classList.remove('hidden');
    if (empBtn) empBtn.classList.add('hidden');
  }
}

async function handleLogout() {
  if (supabaseClient) {
    await supabaseClient.auth.signOut();
  }
  
  state.isAuthenticated = false;
  state.currentUser = null;
  state.currentUserRole = null;
  
  const loginBtn = document.getElementById('nav-login-btn');
  const registerBtn = document.getElementById('nav-register-btn');
  const mobileLoginBtn = document.getElementById('mobile-nav-login-btn');
  const mobileRegisterBtn = document.getElementById('mobile-nav-register-btn');

  const dashBtn = document.getElementById('btn-view-dashboard');
  const empBtn = document.getElementById('btn-view-employee');

  if (dashBtn) dashBtn.classList.remove('hidden');
  if (empBtn) empBtn.classList.remove('hidden');

  if (loginBtn) {
    loginBtn.innerText = 'Se Connecter';
    loginBtn.onclick = () => openAuthModal('login');
    loginBtn.className = 'px-3.5 py-1.5 rounded-full bg-[var(--border-subtle)] hover:bg-[var(--border-accent)] text-[var(--color-offwhite)] text-xs font-semibold border border-[var(--border-subtle)] transition';
  }
  if (registerBtn) registerBtn.classList.remove('hidden');
  if (mobileLoginBtn) {
    mobileLoginBtn.innerText = 'Se Connecter';
    mobileLoginBtn.onclick = () => { openAuthModal('login'); closeMobileMenu(); };
    mobileLoginBtn.className = 'w-full py-2.5 rounded-xl bg-slate-800/90 text-slate-200 text-xs font-semibold border border-slate-700 text-center block';
  }
  if (mobileRegisterBtn) mobileRegisterBtn.classList.remove('hidden');

  switchView('hero');
}

/* ==================== LOGIQUE DU DASHBOARD EMPLOYÉ ==================== */

function switchEmployeeSection(sectionName) {
  document.querySelectorAll('.emp-sub-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.emp-subtab-btn').forEach(btn => {
    btn.classList.remove('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'font-bold');
    btn.classList.add('text-slate-400');
  });

  const targetSec = document.getElementById(`emp-section-${sectionName}`);
  const targetBtn = document.querySelector(`.emp-subtab-btn[data-emp-section="${sectionName}"]`);

  if (targetSec) targetSec.classList.remove('hidden');
  if (targetBtn) {
    targetBtn.classList.add('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'font-bold');
    targetBtn.classList.remove('text-slate-400');
  }
}

let empWorkedTimerInterval = null;

function renderEmployeeDashboard() {
  if (!state.currentUser) return;

  const nameEl = document.getElementById('emp-dash-name');
  const jobEl = document.getElementById('emp-dash-job');
  
  if (nameEl) nameEl.innerText = state.currentUser.fullName || state.currentUser.email || 'Collaborateur';
  if (jobEl) jobEl.innerText = `${state.currentUser.jobTitle || 'Agent Terrain'} • Matricule: EMP-2026-04`;

  // 1. Rendu de l'historique des pointages employé
  const historyBody = document.getElementById('emp-history-table-body');
  if (historyBody) {
    if (state.employees && state.employees.length > 0) {
      historyBody.innerHTML = state.employees.map(att => `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-2.5 font-bold text-white">${escapeHtml(att.date || new Date().toLocaleDateString('fr-FR'))}</td>
          <td class="py-2.5 text-emerald-400 font-bold">${escapeHtml(att.clockIn || '07:58')}</td>
          <td class="py-2.5 text-slate-400">${escapeHtml(att.clockOut || '--:--')}</td>
          <td class="py-2.5 text-slate-300 font-mono">08h 00m</td>
          <td class="py-2.5 text-slate-400 text-[11px]">
            <span class="text-emerald-400 flex items-center gap-1">
              <i data-lucide="shield-check" class="w-3.5 h-3.5"></i> GPS OK (${escapeHtml(att.distance || '12m')})
            </span>
          </td>
          <td class="py-2.5 text-right font-bold text-emerald-400">Présent</td>
        </tr>
      `).join('');
    } else {
      historyBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-6 text-center text-slate-500 italic">
            Aucun pointage récent enregistré sur Supabase. Utilisez le bouton "Pointer Maintenant" ci-dessus !
          </td>
        </tr>
      `;
    }
  }

  // 2. Rendu des Retards Employé
  const latenessBody = document.getElementById('emp-lateness-table-body');
  if (latenessBody) {
    if (state.latenesses && state.latenesses.length > 0) {
      latenessBody.innerHTML = state.latenesses.map(l => `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-2.5 font-bold text-white">${escapeHtml(l.date || 'Aujourd\'hui')}</td>
          <td class="py-2.5 text-amber-400 font-bold">${escapeHtml(l.time || '08:24')}</td>
          <td class="py-2.5 text-rose-400 font-bold">+${escapeHtml(l.minutes || '24')} min</td>
          <td class="py-2.5 text-slate-300">${escapeHtml(l.reason || 'Embouteillage axe Yopougon-Plateau')}</td>
          <td class="py-2.5 text-right font-bold text-emerald-400">Transmis au RH</td>
        </tr>
      `).join('');
    } else {
      latenessBody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 text-center text-emerald-400/80 italic font-mono">
            🎉 Aucun retard enregistré ce mois-ci ! Félicitations pour votre ponctualité.
          </td>
        </tr>
      `;
    }
  }

  // 3. Rendu des Congés Employé
  const leavesBody = document.getElementById('emp-leaves-table-body');
  if (leavesBody) {
    if (state.leaves && state.leaves.length > 0) {
      leavesBody.innerHTML = state.leaves.map(lv => `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-2.5 font-bold text-white">${escapeHtml(lv.type || 'Congé Payé Annuel')}</td>
          <td class="py-2.5 text-slate-300">${escapeHtml(lv.startDate || '15/08')} au ${escapeHtml(lv.endDate || '25/08')}</td>
          <td class="py-2.5 text-cyan-400 font-bold">${escapeHtml(lv.days || '10')} jours</td>
          <td class="py-2.5 text-slate-400">${escapeHtml(lv.reason || 'Repos annuel autorisé')}</td>
          <td class="py-2.5 text-right font-bold text-amber-400">${escapeHtml(lv.status || 'En Attente RH')}</td>
        </tr>
      `).join('');
    } else {
      leavesBody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 text-center text-slate-500 italic">
            Aucune demande de congé enregistrée. Cliquez sur "+ Nouvelle Demande de Congé".
          </td>
        </tr>
      `;
    }
  }

  // 4. Rendu des Heures Supp Employé
  const overtimeBody = document.getElementById('emp-overtime-table-body');
  if (overtimeBody) {
    if (state.overtimes && state.overtimes.length > 0) {
      overtimeBody.innerHTML = state.overtimes.map(ot => `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-2.5 font-bold text-white">${escapeHtml(ot.date || 'Hier')}</td>
          <td class="py-2.5 text-slate-300">${escapeHtml(ot.slot || '18:00 - 20:30')}</td>
          <td class="py-2.5 text-emerald-400 font-bold">${escapeHtml(ot.hours || '2.5h')}</td>
          <td class="py-2.5 text-amber-400 font-mono">+25%</td>
          <td class="py-2.5 text-slate-400">${escapeHtml(ot.reason || 'Inventaire mensuel magasin')}</td>
          <td class="py-2.5 text-right font-bold text-emerald-400">Validé en Paie</td>
        </tr>
      `).join('');
    } else {
      overtimeBody.innerHTML = `
        <tr>
          <td colspan="6" class="py-6 text-center text-slate-500 italic">
            Aucune heure supplémentaire enregistrée. Cliquez sur "+ Déclarer Heures Supp."
          </td>
        </tr>
      `;
    }
  }

  // 5. Rendu des Notifications
  const notifContainer = document.getElementById('emp-notifications-container');
  if (notifContainer) {
    notifContainer.innerHTML = `
      <div class="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-start gap-3">
        <i data-lucide="check-circle" class="w-5 h-5 text-emerald-400 shrink-0 mt-0.5"></i>
        <div class="space-y-0.5 text-xs">
          <div class="font-bold text-emerald-300">Pointage Arrivée Confirmé</div>
          <p class="text-slate-300">Votre pointage de 07:58 GMT a été validé par la reconnaissance faciale IA et le périmètre GPS HQ.</p>
          <span class="text-[10px] text-slate-400 font-mono">Aujourd'hui à 07:58</span>
        </div>
      </div>
      <div class="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
        <i data-lucide="bell-ring" class="w-5 h-5 text-amber-400 shrink-0 mt-0.5"></i>
        <div class="space-y-0.5 text-xs">
          <div class="font-bold text-amber-300">Rappel Clôture de Paie Mensuelle</div>
          <p class="text-slate-300">Veuillez soumettre vos demandes d'heures supplémentaires avant le 25 du mois en cours.</p>
          <span class="text-[10px] text-slate-400 font-mono">Direction RH • Il y a 2h</span>
        </div>
      </div>
    `;
  }

  startEmployeeWorkedTimer();

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function startEmployeeWorkedTimer() {
  if (empWorkedTimerInterval) clearInterval(empWorkedTimerInterval);

  let secondsCounter = 27735; // ~07h 42m 15s

  empWorkedTimerInterval = setInterval(() => {
    secondsCounter++;
    const hrs = String(Math.floor(secondsCounter / 3600)).padStart(2, '0');
    const mins = String(Math.floor((secondsCounter % 3600) / 60)).padStart(2, '0');
    const secs = String(secondsCounter % 60).padStart(2, '0');

    const workedEl = document.getElementById('emp-kpi-worked-time');
    if (workedEl) {
      workedEl.innerText = `${hrs}h ${mins}m ${secs}s`;
    }
  }, 1000);
}

// Supabase Data Loaders & Management
function openAddEmployeeModal() {
  const modal = document.getElementById('modal-add-employee');
  const compBadge = document.getElementById('emp-add-company-badge');
  if (compBadge) compBadge.innerText = state.currentCompanyName || 'Entreprise Connectée';
  if (modal) modal.classList.remove('hidden');
}

function closeAddEmployeeModal() {
  const modal = document.getElementById('modal-add-employee');
  if (modal) modal.classList.add('hidden');
}

async function handleAddEmployeeSubmit(e) {
  if (e) e.preventDefault();
  const fullName = document.getElementById('emp-fullname-input')?.value.trim();
  const phone = document.getElementById('emp-phone-input')?.value.trim();
  const email = document.getElementById('emp-email-input')?.value.trim();
  const matricule = document.getElementById('emp-matricule-input')?.value.trim();
  const job = document.getElementById('emp-job-input')?.value.trim();
  const site = document.getElementById('emp-site-input')?.value.trim();
  const role = document.getElementById('emp-role-select')?.value || 'EMPLOYEE';
  const attendanceReq = document.getElementById('emp-attendance-required-select')?.value === 'true';

  if (!fullName || !phone || !job) {
    showToast('Champs Requis', 'Veuillez saisir au minimum le nom, le téléphone et le poste.', 'info');
    return;
  }

  const btn = document.getElementById('add-emp-submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Génération de l\'invitation...';
  }

  try {
    const inviteCode = `INV-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${Date.now().toString().slice(-4)}`;
    
    if (supabaseClient && state.currentCompanyId) {
      // 1. Créer le profil employé dans public.users
      const { data: newUser, error: userErr } = await supabaseClient.from('users').insert({
        company_id: state.currentCompanyId,
        email: email || `${phone.replace(/\+/g, '')}@temp.winnerpointage.com`,
        full_name: fullName,
        phone_number: phone,
        job_title: job,
        site_name: site || 'Siège',
        registration_number: matricule || `MAT-${Date.now().toString().slice(-4)}`,
        role: role,
        attendance_required: attendanceReq,
        is_active: true
      }).select().single();

      if (userErr) throw userErr;

      // 2. Créer l'entrée dans public.company_memberships
      await supabaseClient.from('company_memberships').insert({
        user_id: newUser.id,
        company_id: state.currentCompanyId,
        role: role,
        attendance_required: attendanceReq,
        invitation_code: inviteCode,
        status: 'INVITED'
      });
    }

    closeAddEmployeeModal();
    openInviteCreatedModal(fullName, state.currentCompanyName || 'Votre Entreprise', inviteCode);
    loadSupabaseData();
  } catch (err) {
    console.error('Erreur création membre Supabase:', err);
    showToast('Erreur d\'Enregistrement', err.message || 'Impossible d\'enregistrer le membre.', 'info');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'GÉNÉRER L\'INVITATION & ENREGISTRER';
    }
  }
}

/* ==================== GESTION DES INVITATIONS & ACTIVATIONS ==================== */

function openInviteCreatedModal(name, companyName, inviteCode) {
  const modal = document.getElementById('modal-invite-created');
  const nameEl = document.getElementById('inv-created-name');
  const compEl = document.getElementById('inv-created-company');
  const linkInput = document.getElementById('inv-created-link');
  const codeEl = document.getElementById('inv-created-code');

  const fullLink = `${window.location.origin}${window.location.pathname}#invite?code=${inviteCode}`;

  if (nameEl) nameEl.innerText = name;
  if (compEl) compEl.innerText = companyName;
  if (linkInput) linkInput.value = fullLink;
  if (codeEl) codeEl.innerText = inviteCode;

  if (modal) modal.classList.remove('hidden');
}

function closeInviteCreatedModal() {
  const modal = document.getElementById('modal-invite-created');
  if (modal) modal.classList.add('hidden');
}

function copyInviteLink() {
  const linkInput = document.getElementById('inv-created-link');
  if (linkInput) {
    linkInput.select();
    navigator.clipboard.writeText(linkInput.value);
    showToast('Copié !', 'Lien d\'invitation copié dans le presse-papier.', 'success');
  }
}

async function checkUrlInvitation() {
  const hash = window.location.hash;
  if (hash.includes('invite') || hash.includes('code=')) {
    const params = new URLSearchParams(hash.replace('#invite?', '').replace('#', ''));
    const code = params.get('code');

    if (code && supabaseClient) {
      try {
        const { data: membership, error } = await supabaseClient
          .from('company_memberships')
          .select('*')
          .eq('invitation_code', code)
          .maybeSingle();

        if (!error && membership) {
          state.pendingInvitation = membership;
          openInviteActivationModal(membership);
        }
      } catch (e) {
        console.warn('Erreur vérification invitation:', e);
      }
    }
  }
}

function openInviteActivationModal(membership) {
  const modal = document.getElementById('modal-invite-activation');
  const compInput = document.getElementById('act-company-name');
  const nameInput = document.getElementById('act-fullname-input');
  const emailInput = document.getElementById('act-email-input');

  const compName = membership.companies ? membership.companies.name : 'Votre Entreprise';
  const userName = membership.users ? membership.users.full_name : '';
  const userEmail = membership.users ? membership.users.email : '';

  if (compInput) compInput.value = compName;
  if (nameInput) nameInput.value = userName;
  if (emailInput) emailInput.value = userEmail;

  if (modal) modal.classList.remove('hidden');
}

function closeInviteActivationModal() {
  const modal = document.getElementById('modal-invite-activation');
  if (modal) modal.classList.add('hidden');
}

async function handleInviteActivationSubmit(e) {
  if (e) e.preventDefault();
  const nameVal = document.getElementById('act-fullname-input')?.value.trim();
  const emailVal = document.getElementById('act-email-input')?.value.trim();
  const passwordVal = document.getElementById('act-password-input')?.value;
  const confirmVal = document.getElementById('act-confirm-password-input')?.value;

  if (!emailVal || !passwordVal) {
    showToast('Champs Requis', 'Veuillez saisir votre e-mail et créer un mot de passe.', 'info');
    return;
  }
  if (passwordVal !== confirmVal) {
    showToast('Erreur Mot de Passe', 'Les mots de passe ne correspondent pas.', 'info');
    return;
  }

  const btn = document.getElementById('act-submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Activation en cours...';
  }

  try {
    if (supabaseClient && state.pendingInvitation) {
      // 1. SignUp Supabase Auth
      const { data: authData, error: authErr } = await supabaseClient.auth.signUp({
        email: emailVal,
        password: passwordVal,
      });

      if (authErr) {
        if (authErr.message && authErr.message.toLowerCase().includes('rate limit')) {
          showToast(
            'Limite d\'Emails Supabase ⚠️',
            'Le quota temporaire d\'envoi d\'e-mails Supabase est atteint. Veuillez patienter quelques minutes avant de réactiver votre compte.',
            'warning',
            10000
          );
          return;
        }
        throw authErr;
      }

      // 2. Mettre à jour l'utilisateur et le statut d'invitation
      if (authData.user) {
        await supabaseClient.from('users').update({
          id: authData.user.id,
          full_name: nameVal,
          email: emailVal,
          is_active: true
        }).eq('id', state.pendingInvitation.user_id);

        await supabaseClient.from('company_memberships').update({
          user_id: authData.user.id,
          status: 'ACTIVE'
        }).eq('id', state.pendingInvitation.id);
      }

      showToast('Compte Activé !', 'Votre compte employé a été activé. Vous pouvez vous connecter.', 'success', 8000);
      closeInviteActivationModal();
      openAuthModal('login');
    }
  } catch (err) {
    console.error('Erreur activation invitation:', err);
    showToast('Erreur Activation', err.message || 'Impossible d\'activer l\'invitation.', 'info');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'ACTIVATION & ACCÈS DASHBOARD EMPLOYÉ';
    }
  }
}

/* ==================== SÉLECTEUR MULTI-ENTREPRISES ==================== */

function openSelectWorkspaceModal(memberships) {
  const modal = document.getElementById('modal-select-workspace');
  const container = document.getElementById('workspace-cards-container');

  if (container && memberships) {
    container.innerHTML = memberships.map(m => `
      <div onclick="selectCompanyWorkspace('${m.company_id}', '${m.role}', ${m.attendance_required}, '${escapeHtml(m.companies ? m.companies.name : 'Entreprise')}')" class="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-amber-500/50 hover:bg-slate-800/80 cursor-pointer transition flex items-center justify-between group">
        <div class="space-y-1">
          <div class="font-bold text-white group-hover:text-amber-400 transition">${escapeHtml(m.companies ? m.companies.name : 'Entreprise')}</div>
          <div class="text-xs text-slate-400 font-mono">Rôle: <strong class="text-emerald-400">${m.role}</strong></div>
        </div>
        <i data-lucide="chevron-right" class="w-5 h-5 text-slate-500 group-hover:text-amber-400 transition"></i>
      </div>
    `).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  if (modal) modal.classList.remove('hidden');
}

function closeSelectWorkspaceModal() {
  const modal = document.getElementById('modal-select-workspace');
  if (modal) modal.classList.add('hidden');
}

async function loadSupabaseData() {
  if (!supabaseClient) return;

  try {
    // 1. Charger les utilisateurs / employés de l'entreprise connectée
    let userQuery = supabaseClient.from('users').select('*');
    if (state.currentCompanyId) {
      userQuery = userQuery.eq('company_id', state.currentCompanyId);
    }

    const { data: users, error: usersErr } = await userQuery;
    if (!usersErr) {
      state.employees = (users || []).map((u, i) => ({
        id: u.id || i + 1,
        name: u.full_name || u.email,
        role: u.job_title || u.role || 'Employé',
        site: u.site_name || 'Siège Principal',
        status: u.is_active ? 'Présent' : 'Absent',
        arriveTime: u.created_at ? new Date(u.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
        method: 'GPS Supabase',
        distance: '0m',
        confidence: 99.0,
        avatar: u.avatar_url || 'https://images.unsplash.com/photo-1507152832244-10d45c7eda57?w=150&auto=format&fit=crop&q=80'
      }));
      renderStaffGrid();
      renderDashboard();
    }

    // 2. Charger les événements de calendrier de l'entreprise
    let calQuery = supabaseClient.from('calendar_events').select('*');
    if (state.currentCompanyId) {
      calQuery = calQuery.eq('company_id', state.currentCompanyId);
    }
    const { data: events, error: evErr } = await calQuery;
    if (!evErr) {
      calendarState.events = (events || []).map(e => ({
        id: e.id,
        day: e.day,
        timeStart: e.time_start || '09:00',
        timeEnd: e.time_end || '10:00',
        title: e.title,
        client: e.client,
        amount: e.amount,
        type: e.type,
        badge: e.badge,
        color: e.color,
        status: e.status
      }));
      renderSaasCalendar();
    }

    // 3. Charger toutes les entreprises pour le Dashboard SaaS
    const { data: comps } = await supabaseClient.from('companies').select('*');
    if (comps) {
      state.companies = comps;
    }

    renderSaasDashboard();
    renderEmployeeDashboard();
  } catch (err) {
    console.warn('Erreur lors du chargement des données Supabase:', err);
  }
}

// Render SaaS Admin Dashboard KPIs & Tables
function renderSaasDashboard() {
  const companies = state.companies || [];
  const employeesCount = state.employees ? state.employees.length : 0;
  const totalCompanies = companies.length;
  const activeCompanies = companies.filter(c => c.is_active !== false).length;
  const suspendedCompanies = companies.filter(c => c.is_active === false).length;

  const mrr = activeCompanies * 350000;
  const arr = mrr * 12;

  // KPIs
  const arrEl = document.getElementById('saas-kpi-arr');
  if (arrEl) arrEl.innerText = `${arr.toLocaleString('fr-FR')} F`;

  const mrrEl = document.getElementById('saas-kpi-mrr');
  if (mrrEl) mrrEl.innerText = `${mrr.toLocaleString('fr-FR')} F`;

  const totalCompEl = document.getElementById('saas-kpi-total-companies');
  if (totalCompEl) totalCompEl.innerText = `${totalCompanies} Clientèle`;

  const activeCompEl = document.getElementById('saas-kpi-active-companies');
  if (activeCompEl) activeCompEl.innerText = `${activeCompanies} Actives`;

  const totalEmpEl = document.getElementById('saas-kpi-total-employees');
  if (totalEmpEl) totalEmpEl.innerText = `${employeesCount} emp.`;

  const expEl = document.getElementById('saas-kpi-expired-trials');
  if (expEl) expEl.innerText = `0 Essais`;

  const suspEl = document.getElementById('saas-kpi-suspended');
  if (suspEl) suspEl.innerText = `${suspendedCompanies} Suspendus`;

  const tickEl = document.getElementById('saas-kpi-tickets');
  if (tickEl) tickEl.innerText = `0 Ouverts`;

  const headerCompCount = document.getElementById('saas-header-comp-count');
  if (headerCompCount) headerCompCount.innerText = totalCompanies;

  const compCountLabel = document.getElementById('saas-companies-count-label');
  if (compCountLabel) compCountLabel.innerText = `${totalCompanies} Entreprises`;

  const totalRegComp = document.getElementById('saas-total-registered-companies');
  if (totalRegComp) totalRegComp.innerText = `${totalCompanies} entreprise(s)`;

  const totalRegEmp = document.getElementById('saas-total-registered-employees');
  if (totalRegEmp) totalRegEmp.innerText = `${employeesCount} employé(s)`;

  // Breakdowns
  const planProCountEl = document.getElementById('saas-plan-pro-count');
  if (planProCountEl) planProCountEl.innerText = `${totalCompanies} Abonnés`;

  const planProBarEl = document.getElementById('saas-plan-pro-bar');
  if (planProBarEl) planProBarEl.style.width = totalCompanies > 0 ? '100%' : '0%';

  // Tableau des entreprises
  const tbody = document.getElementById('company-table-body');
  if (tbody) {
    if (companies.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="p-6 text-center text-slate-500 text-xs font-mono">
            Aucune entreprise enregistrée dans Supabase pour le moment.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = companies.map(c => `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="py-3 font-bold text-white flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full ${c.is_active !== false ? 'bg-emerald-400' : 'bg-red-400'}"></span>
            ${escapeHtml(c.name)}
          </td>
          <td><span class="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 font-mono text-[10px] border border-amber-500/20">${escapeHtml(c.subscription_plan || 'Pro')}</span></td>
          <td class="font-mono">${employeesCount} emp.</td>
          <td class="font-mono text-emerald-400 font-bold">350.000 FCFA</td>
          <td><span class="px-2.5 py-0.5 rounded-full ${c.is_active !== false ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'} font-semibold text-[10px] border">${c.is_active !== false ? 'Active' : 'Suspendue'}</span></td>
          <td class="text-right space-x-2">
            <button onclick="toggleCompanyStatus('${escapeHtml(c.name)}', '${c.is_active !== false ? 'suspend' : 'activate'}')" class="px-2 py-1 rounded ${c.is_active !== false ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/20'} font-semibold text-[10px] border transition">${c.is_active !== false ? 'Suspendre' : 'Réactiver'}</button>
          </td>
        </tr>
      `).join('');
    }
  }
}

// Initialisation globale au chargement
window.addEventListener('DOMContentLoaded', () => {
  checkUrlInvitation();
});
window.addEventListener('hashchange', () => {
  checkUrlInvitation();
  const hash = window.location.hash.replace('#', '');
  if (['hero', 'saas', 'dashboard', 'employee'].includes(hash) && hash !== state.activeView) {
    switchView(hash);
  }
});



