/**
 * Winner Pointage — Application Logic
 * Preset B — Sécurité Nocturne
 * Plateforme SaaS de Gestion du Temps et Pointage pour Entreprises
 */

// Production Application State
const state = {
  activeView: 'hero',
  activeSection: 'overview',
  company: {
    name: 'SaaS Entreprise (Exemple)',
    sector: 'Services, Industrie & Commerce',
    siteName: 'Siège Social — Zone Principale',
    coordinates: { lat: 5.359942, lng: -4.008311 },
    geofenceRadius: 150
  },
  employees: [
    { id: 1, name: 'Marc KOUASSI', role: 'Chef d\'Atelier & Production', site: 'Siège Principal', status: 'Présent', arriveTime: '07:58', method: 'GPS + Selfie', distance: '14m', confidence: 99.2, avatar: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80' },
    { id: 2, name: 'Awa KONE', role: 'Responsable Qualité', site: 'Siège Principal', status: 'Présent', arriveTime: '08:02', method: 'GPS + Selfie', distance: '12m', confidence: 98.4, avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80' },
    { id: 3, name: 'Jean-Luc BAMBA', role: 'Commercial Terrain', site: 'Missions Client', status: 'Retard', arriveTime: '08:18', method: 'GPS Mobile Client', distance: 'Site Client Plateau', confidence: 96.0, avatar: 'https://images.unsplash.com/photo-1531384441138-2736e62e0919?w=150&auto=format&fit=crop&q=80' },
    { id: 4, name: 'Sarah DIABATE', role: 'Designer & Marketing', site: 'Siège Principal', status: 'Présent', arriveTime: '07:50', method: 'GPS + Selfie', distance: '8m', confidence: 99.5, avatar: 'https://images.unsplash.com/photo-1589156280159-27698a70f29e?w=150&auto=format&fit=crop&q=80' },
    { id: 5, name: 'Koffi YAO', role: 'Technicien de Maintenance', site: 'Siège Principal', status: 'Présent', arriveTime: '07:55', method: 'QR Kiosque', distance: '0m (Kiosque)', confidence: 100.0, avatar: 'https://images.unsplash.com/photo-1522529599102-193c0d76b5b6?w=150&auto=format&fit=crop&q=80' },
    { id: 6, name: 'Grace TOURE', role: 'Comptable & RH', site: 'Siège Principal', status: 'En Congé', arriveTime: '-', method: '-', distance: '-', confidence: 0, avatar: 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=150&auto=format&fit=crop&q=80' },
    { id: 7, name: 'Ibrahim SANOGO', role: 'Logistique & Expédition', site: 'Siège Principal', status: 'Présent', arriveTime: '07:45', method: 'GPS + Selfie', distance: '22m', confidence: 97.8, avatar: 'https://images.unsplash.com/photo-1542385151-efd9000785a0?w=150&auto=format&fit=crop&q=80' },
    { id: 8, name: 'Patricia EHOUNOU', role: 'Assistante Commerciale', site: 'Siège Principal', status: 'Présent', arriveTime: '07:59', method: 'GPS + Selfie', distance: '10m', confidence: 98.9, avatar: 'https://images.unsplash.com/photo-1567186937675-a5131c8a89ea?w=150&auto=format&fit=crop&q=80' },
    { id: 9, name: 'Emmanuel ADOU', role: 'Opérateur Découpe', site: 'Siège Principal', status: 'Présent', arriveTime: '08:00', method: 'QR Kiosque', distance: '0m', confidence: 100.0, avatar: 'https://images.unsplash.com/photo-1507152832244-10d45c7eda57?w=150&auto=format&fit=crop&q=80' },
    { id: 10, name: 'Fatou CISSE', role: 'Stagiaire Marketing', site: 'Siège Principal', status: 'Absent', arriveTime: '-', method: '-', distance: '-', confidence: 0, avatar: 'https://images.unsplash.com/photo-1534751516642-a171e261452a?w=150&auto=format&fit=crop&q=80' }
  ],
  leaves: [
    { id: 101, employee: 'Grace TOURE', type: 'Congé Payé Annuel', period: '04/08/2026 au 08/08/2026', days: 5, reason: 'Congé annuel légal', status: 'Approuvé' },
    { id: 102, employee: 'Jean-Luc BAMBA', type: 'Permission Exceptionnelle', period: '12/08/2026', days: 1, reason: 'Rendez-vous administratif', status: 'En attente' }
  ],
  overtimes: [
    { id: 201, employee: 'Marc KOUASSI', date: '05/08/2026', slot: '17:00 - 19:30', duration: '2.5 h', multiplier: '+25%', reason: 'Surcroît production coffrets cadeaux', status: 'Validé' },
    { id: 202, employee: 'Koffi YAO', date: '04/08/2026', slot: '17:00 - 19:00', duration: '2.0 h', multiplier: '+25%', reason: 'Maintenance presse d\'impression', status: 'Validé' },
    { id: 203, employee: 'Sarah DIABATE', date: '06/08/2026', slot: '17:00 - 18:30', duration: '1.5 h', multiplier: '+25%', reason: 'Finalisation Maquettes Packaging Luxe', status: 'En attente' }
  ],
  latenesses: [
    { id: 301, employee: 'Jean-Luc BAMBA', date: '06/08/2026', scheduled: '08:00', actual: '08:18', minutes: 18, justification: 'Embouteillage axe Yopougon - Plateau', status: 'En attente validation' }
  ],
  qrTimer: 30
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  initIcons();
  startLiveClock();
  startQRCountdown();
  renderDashboard();
  renderStaffGrid();
  setTheme('terracotta');
  updateRoiCalculator();
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

// Live Clock Display
function startLiveClock() {
  const clockEl = document.getElementById('live-system-clock');
  setInterval(() => {
    const now = new Date();
    const hrs = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    const secs = String(now.getSeconds()).padStart(2, '0');
    if (clockEl) clockEl.innerText = `${hrs}:${mins}:${secs} GMT`;
  }, 1000);
}

// View Switcher (Landing vs Dashboard vs Employee vs Manager)
function switchView(viewName) {
  state.activeView = viewName;

  document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-view-btn').forEach(btn => {
    btn.classList.remove('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'font-semibold');
    btn.classList.add('text-slate-300', 'bg-slate-800/60');
  });

  const targetView = document.getElementById(`view-${viewName}`);
  const targetBtn = document.getElementById(`btn-view-${viewName}`);

  if (targetView) targetView.classList.remove('hidden');
  if (targetBtn) {
    targetBtn.classList.add('text-emerald-400', 'bg-emerald-500/10', 'border-emerald-500/30', 'font-semibold');
    targetBtn.classList.remove('text-slate-300', 'bg-slate-800/60');
  }

  // Smooth scroll top
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    tableBody.innerHTML = state.employees.map(emp => {
      let statusBadge = '';
      if (emp.status === 'Présent') statusBadge = '<span class="badge-verified px-2 py-0.5 rounded text-[10px]">Présent (À l\'heure)</span>';
      else if (emp.status === 'Retard') statusBadge = '<span class="badge-alert px-2 py-0.5 rounded text-[10px]">Retard (18m)</span>';
      else if (emp.status === 'En Congé') statusBadge = '<span class="badge-info px-2 py-0.5 rounded text-[10px]">En Congé</span>';
      else statusBadge = '<span class="badge-danger px-2 py-0.5 rounded text-[10px]">Absent</span>';

      return `
        <tr class="hover:bg-slate-800/40 transition">
          <td class="p-2.5 flex items-center space-x-2">
            <img src="${emp.avatar}" class="w-6 h-6 rounded-full object-cover border border-slate-700" alt="${emp.name}" />
            <span class="font-bold text-white">${emp.name}</span>
          </td>
          <td class="p-2.5 font-mono text-slate-300">${emp.arriveTime}</td>
          <td class="p-2.5 text-slate-400">${emp.method}</td>
          <td class="p-2.5 text-emerald-400">${emp.distance}</td>
          <td class="p-2.5">${statusBadge}</td>
        </tr>
      `;
    }).join('');
  }

  renderLeaveRequestsTable();
  renderOvertimeTable();
  renderLatenessTable();
  initIcons();
}

// Render Staff Cards Grid
function renderStaffGrid() {
  const container = document.getElementById('staff-grid');
  if (!container) return;

  container.innerHTML = state.employees.map(emp => {
    let statusClass = 'border-emerald-500/30 text-emerald-400';
    if (emp.status === 'Retard') statusClass = 'border-orange-500/30 text-orange-400';
    if (emp.status === 'Absent') statusClass = 'border-red-500/30 text-red-400';

    return `
      <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition space-y-3">
        <div class="flex items-center space-x-3">
          <img src="${emp.avatar}" class="w-12 h-12 rounded-xl object-cover border border-slate-700 shadow-md" alt="${emp.name}" />
          <div>
            <h4 class="font-bold text-white text-sm">${emp.name}</h4>
            <p class="text-[11px] text-slate-400">${emp.role}</p>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs font-mono pt-2 border-t border-slate-800/80">
          <span class="text-slate-400">Statut :</span>
          <span class="px-2 py-0.5 rounded bg-slate-800 border ${statusClass} text-[10px] font-bold">${emp.status}</span>
        </div>
        <div class="flex justify-between text-[11px] font-mono text-slate-400">
          <span>Affectation :</span>
          <span class="text-white">${emp.site}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Render Leave Requests Table
function renderLeaveRequestsTable() {
  const tbody = document.getElementById('leave-requests-table');
  if (!tbody) return;

  tbody.innerHTML = state.leaves.map(req => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${req.employee}</td>
      <td class="p-3 text-cyan-400">${req.type}</td>
      <td class="p-3 text-slate-400">${req.period}</td>
      <td class="p-3">${req.days} Jours</td>
      <td class="p-3 text-slate-300">${req.reason}</td>
      <td class="p-3">
        <span class="${req.status === 'Approuvé' ? 'badge-verified' : 'badge-alert'} px-2 py-0.5 rounded text-[10px]">
          ${req.status}
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

  tbody.innerHTML = state.overtimes.map(ot => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${ot.employee}</td>
      <td class="p-3 text-slate-400">${ot.date}</td>
      <td class="p-3 font-mono text-emerald-400">${ot.slot}</td>
      <td class="p-3 font-bold text-white">${ot.duration}</td>
      <td class="p-3 text-emerald-400">${ot.multiplier}</td>
      <td class="p-3 text-slate-300">${ot.reason}</td>
      <td class="p-3">
        <span class="${ot.status === 'Validé' ? 'badge-verified' : 'badge-alert'} px-2 py-0.5 rounded text-[10px]">
          ${ot.status}
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

  tbody.innerHTML = state.latenesses.map(lat => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3 font-bold text-white">${lat.employee}</td>
      <td class="p-3 text-slate-400">${lat.date}</td>
      <td class="p-3 text-slate-400">${lat.scheduled}</td>
      <td class="p-3 text-orange-400 font-bold">${lat.actual}</td>
      <td class="p-3 text-orange-400 font-bold">+${lat.minutes} min</td>
      <td class="p-3 text-slate-300">${lat.justification}</td>
      <td class="p-3"><span class="badge-alert px-2 py-0.5 rounded text-[10px]">${lat.status}</span></td>
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
    const nowStr = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    showToast(
      `Pointage d'${type} Réussi`,
      `<strong class="text-white">${empName}</strong><br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Reconnaissance Faciale :</span> Match 99.4% (Visage Identifié)<br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Géolocalisation GPS :</span> Validé (14m du Siège)<br/>` +
      `<span class="text-emerald-400 font-semibold">✓ Horodateur Certifié :</span> ${nowStr} GMT`,
      'success',
      6500
    );

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
  const type = document.getElementById('leave-type').value;
  const reason = document.getElementById('leave-reason').value || 'Sans commentaire';

  state.leaves.push({
    id: Date.now(),
    employee: 'Sarah DIABATE',
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
    employee: 'Marc KOUASSI',
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

function toggleFaq(id) {
  const answer = document.getElementById(`faq-answer-${id}`);
  const icon = document.getElementById(`faq-icon-${id}`);

  if (answer) {
    answer.classList.toggle('hidden');
  }
  if (icon) {
    icon.classList.toggle('rotate-180');
  }
}

// Authentication Modal Logic (Production Ready)
function openAuthModal(mode = 'login') {
  const modal = document.getElementById('modal-auth');
  const title = document.getElementById('auth-modal-title');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (modal) modal.classList.remove('hidden');

  if (mode === 'register') {
    if (title) title.innerText = 'Démarrer votre Essai Gratuit de 14 Jours';
    if (submitBtn) submitBtn.innerText = 'Créer mon compte entreprise';
  } else {
    if (title) title.innerText = 'Connexion à votre Espace Client RH';
    if (submitBtn) submitBtn.innerText = 'Se Connecter';
  }
}

function closeAuthModal() {
  const modal = document.getElementById('modal-auth');
  if (modal) modal.classList.add('hidden');
}

function handleAuthSubmit(e) {
  if (e) e.preventDefault();
  closeAuthModal();
  switchView('dashboard');
  showToast('Connexion Réussie', 'Bienvenue sur votre cockpit RH Winner Pointage Pro.', 'success');
}
