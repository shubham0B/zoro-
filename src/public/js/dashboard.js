// Subpath detection for reverse proxy (e.g. /directorbot or /)
let basePath = window.location.pathname.replace(/\/+$/, '');
if (basePath.endsWith('.html') || basePath.includes('.htm')) {
  basePath = basePath.substring(0, basePath.lastIndexOf('/'));
}
if (basePath === '/' || !basePath) {
  basePath = '';
}

// Helper to resolve URLs with subpath support
function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const clean = url.startsWith('/') ? url : `/${url}`;
  return `${basePath}${clean}`;
}

// Auto-prefix all relative API calls with the subpath, attach auth token, and handle 401
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    url = resolveUrl(url);
  }

  // Attach Authorization token
  const token = localStorage.getItem('auth_token');
  if (token) {
    options.headers = options.headers || {};
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.append('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(options.headers)) {
      if (!options.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
        options.headers.push(['Authorization', `Bearer ${token}`]);
      }
    } else {
      if (!options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  return originalFetch.call(this, url, options).then(res => {
    if (res.status === 401 && typeof url === 'string' && !url.includes('/api/auth/login')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.replace(resolveUrl('/login.html'));
    }
    return res;
  });
};

// Socket.io Connection with dynamic path
const socket = io({
  path: (basePath ? `${basePath}/socket.io` : '/socket.io')
});

// State
let currentStatus = {
  database: {},
  whatsapp: { director: {}, bot: {} },
  gmail: {},
  gemini: {}
};

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initAuthSession();
  setupNavigation();
  setupSocketListeners();
  loadAllData();
  setupSettingsForm();
  setupChangePasswordForm();
  setupScheduleForm();
  checkUrlParams();

  // Set today's date in header
  const options = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  const todayStr = new Date().toLocaleDateString('en-US', options);
  document.getElementById('current-date-display').textContent = `Today: ${todayStr}`;

  // Periodic Refresh
  setInterval(loadStats, 10000);
  setInterval(loadSchedules, 15000);
  setInterval(loadActivityLogs, 8000);
});

// Global Instant Logout Handler
window.executeLogout = function(e) {
  if (e) {
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
  }
  // 1. Instantly wipe client-side tokens
  try {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    sessionStorage.clear();
  } catch (err) {}

  // 2. Clear cookies across all subpath scopes
  document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
  document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/directorbot;";
  document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/directorbot/;";

  // 3. Navigate directly to /logout which purges session in MySQL and redirects to login.html
  window.location.href = resolveUrl('/logout');
};

// User Session & Logout
async function initAuthSession() {
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.onclick = window.executeLogout;
  }

  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data && data.success && data.user) {
      const u = data.user;
      if (u.role === 'recruiter_admin' || u.role === 'recruiter') {
        window.location.replace(resolveUrl('/recruitment/'));
        return;
      }
      const emailElem = document.getElementById('user-display-email');
      const settingsEmail = document.getElementById('settings-current-email');
      const avatarElem = document.getElementById('user-avatar-initials');

      // Do NOT display raw full email in header
      if (emailElem) {
        emailElem.textContent = u.name || 'Zoro Admin';
        emailElem.title = u.email || 'admin@zoro.ai';
      }
      if (settingsEmail) settingsEmail.textContent = u.email || 'admin@zoro.ai';
      if (avatarElem) {
        const parts = (u.name || 'Zoro Admin').split(' ').filter(Boolean);
        const initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]) : parts[0].substring(0, 2);
        avatarElem.textContent = initials.toUpperCase();
      }
    }
  } catch (err) {
    console.error('Failed to load user profile:', err);
  }
}

// Change Password Handler in Settings Tab
function setupChangePasswordForm() {
  const form = document.getElementById('form-change-password');
  const msgElem = document.getElementById('pwd-change-msg');
  const btn = document.getElementById('btn-change-pwd');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (msgElem) {
      msgElem.textContent = '';
      msgElem.style.color = '';
    }

    const currentPassword = document.getElementById('pwd-current').value;
    const newPassword = document.getElementById('pwd-new').value;
    const confirmPassword = document.getElementById('pwd-confirm').value;

    if (newPassword !== confirmPassword) {
      if (msgElem) {
        msgElem.textContent = '❌ New passwords do not match';
        msgElem.style.color = '#f87171';
      }
      showToast('❌ New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      if (msgElem) {
        msgElem.textContent = '❌ Passcode must be at least 6 characters';
        msgElem.style.color = '#f87171';
      }
      showToast('❌ Passcode must be at least 6 characters');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Updating...';
    }

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        if (msgElem) {
          msgElem.textContent = '✅ ' + (data.message || 'Passcode updated successfully!');
          msgElem.style.color = '#34d399';
        }
        showToast('✅ Passcode updated successfully!');
        form.reset();
      } else {
        const errText = data.error || 'Failed to update passcode';
        if (msgElem) {
          msgElem.textContent = '❌ ' + errText;
          msgElem.style.color = '#f87171';
        }
        showToast('❌ ' + errText);
      }
    } catch (err) {
      if (msgElem) {
        msgElem.textContent = '❌ Network error communicating with server';
        msgElem.style.color = '#f87171';
      }
      showToast('❌ Network error updating passcode');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Update Passcode';
      }
    }
  });
}

// Tab Navigation
function setupNavigation() {
  const menuButtons = document.querySelectorAll('.menu-item');
  menuButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Top action buttons
  document.getElementById('btn-sync-emails')?.addEventListener('click', forceSyncEmails);
  document.getElementById('btn-trigger-briefing')?.addEventListener('click', generateAndSendBriefingNow);
}

function switchTab(tabId) {
  document.querySelectorAll('.menu-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const activeBtn = document.querySelector(`.menu-item[data-tab="${tabId}"]`);
  const activeContent = document.getElementById(tabId);

  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.add('active');

  // Trigger tab-specific refresh
  if (tabId === 'tab-gmail') loadEmails();
  if (tabId === 'tab-drafts') loadDrafts();
  if (tabId === 'tab-schedule') loadSchedules();
  if (tabId === 'tab-whatsapp-chats') loadWhatsAppChats();
  if (tabId === 'tab-briefings') {
    loadLatestBriefing();
    loadBriefingArchives();
  }
  if (tabId === 'tab-settings') loadSettings();
}

// Socket.io Listeners for Real-time QR and Status
function setupSocketListeners() {
  socket.on('connect', () => {
    console.log('[Socket] Connected to backend');
  });

  socket.on('status_update', (data) => {
    updateWhatsAppUI(data);
  });
}

function updateWhatsAppUI(waData) {
  if (!waData) return;

  const dirStatusPill = document.getElementById('dir-status-pill');
  const botStatusPill = document.getElementById('bot-status-pill');
  const dirStatusText = document.getElementById('director-session-status');
  const botStatusText = document.getElementById('bot-session-status');
  const dirQRContainer = document.getElementById('director-qr-container');
  const botQRContainer = document.getElementById('bot-qr-container');

  // 1. Director Session
  if (waData.director) {
    const status = waData.director.status;
    dirStatusPill.textContent = status;
    dirStatusText.textContent = `Status: ${status}`;

    if (status === 'CONNECTED') {
      dirStatusPill.className = 'status-indicator-pill connected';
      dirQRContainer.innerHTML = `
        <div style="text-align:center; color: #10b981;">
          <svg width="60" height="60" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <h4 style="margin-top:10px;">Connected & Active</h4>
          <p style="font-size:0.75rem; color:#64748b;">Silent Monitor Ingesting Messages</p>
        </div>`;
    } else if (status === 'SCAN_QR' && waData.director.qr) {
      dirStatusPill.className = 'status-indicator-pill action-needed';
      dirQRContainer.innerHTML = `<img src="${waData.director.qr}" alt="Personal WhatsApp QR">`;
    }
  }

  // 2. Bot Session
  if (waData.bot) {
    const status = waData.bot.status;
    botStatusPill.textContent = status;
    botStatusText.textContent = `Status: ${status}`;

    if (status === 'CONNECTED') {
      botStatusPill.className = 'status-indicator-pill connected';
      botQRContainer.innerHTML = `
        <div style="text-align:center; color: #06b6d4;">
          <svg width="60" height="60" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          <h4 style="margin-top:10px;">Zoro Co-Pilot Active</h4>
          <p style="font-size:0.75rem; color:#64748b;">Ready for conversational queries & actions</p>
        </div>`;
    } else if (status === 'SCAN_QR' && waData.bot.qr) {
      botStatusPill.className = 'status-indicator-pill action-needed';
      botQRContainer.innerHTML = `<img src="${waData.bot.qr}" alt="Zoro WhatsApp QR">`;
    }
  }
}

// Data Fetching
async function loadAllData() {
  await loadStatus();
  await loadStats();
  await loadSchedules();
  await loadActivityLogs();
  await loadDrafts();
}

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    currentStatus = data;

    // Database Status
    const dbOnline = data.database?.connected;
    document.getElementById('dot-db').className = dbOnline ? 'dot-online' : 'dot-online text-danger';
    document.getElementById('db-desc').textContent = dbOnline ? `${data.database.database} (Active)` : 'Offline / Error';

    // Gemini Status
    const geminiConfigured = data.gemini?.configured;
    document.getElementById('dot-gemini').className = geminiConfigured ? 'dot-online' : 'dot-online text-warning';
    document.getElementById('gemini-desc').textContent = geminiConfigured ? 'Gemini 3.7 Active' : 'Key Needed';

    // Gmail Status
    const gmailConnected = data.gmail?.connected;
    const gmailPill = document.getElementById('gmail-status-pill');
    const gmailText = document.getElementById('gmail-status-text');
    const gmailAddress = document.getElementById('gmail-connected-address');
    const gmailSub = document.getElementById('gmail-connected-sub');

    const connectBtn = document.getElementById('btn-connect-gmail');
    const overviewDisconnect = document.getElementById('btn-overview-disconnect-gmail');
    const disconnectBtn = document.getElementById('btn-disconnect-gmail');
    const reconnectBtn = document.getElementById('btn-reconnect-gmail');

    if (gmailConnected) {
      gmailPill.textContent = 'CONNECTED';
      gmailPill.className = 'status-indicator-pill connected';
      gmailText.textContent = `Connected: ${data.gmail.email}`;
      if (gmailAddress) gmailAddress.textContent = data.gmail.email;
      if (gmailSub) gmailSub.textContent = `Last synchronized: ${data.gmail.lastSync ? new Date(data.gmail.lastSync).toLocaleTimeString() : 'Active'}`;
      
      if (connectBtn) connectBtn.style.display = 'none';
      if (overviewDisconnect) overviewDisconnect.style.display = 'inline-flex';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-flex';
      if (reconnectBtn) reconnectBtn.textContent = 'Switch Account';
    } else {
      gmailPill.textContent = 'DISCONNECTED';
      gmailPill.className = 'status-indicator-pill action-needed';
      gmailText.textContent = 'Click "Connect with Google" to link Primary Gmail';
      if (gmailAddress) gmailAddress.textContent = 'No Gmail Connected';
      if (gmailSub) gmailSub.textContent = 'Authorize your inbox to enable automatic email intelligence.';
      
      if (connectBtn) connectBtn.style.display = 'inline-flex';
      if (overviewDisconnect) overviewDisconnect.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (reconnectBtn) reconnectBtn.textContent = 'Connect / Change Account';
    }

    // WhatsApp Status
    if (data.whatsapp) {
      updateWhatsAppUI(data.whatsapp);
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    document.getElementById('stat-emails-today').textContent = stats.emailsToday || 0;
    document.getElementById('stat-chats-today').textContent = stats.chatsToday || 0;
    document.getElementById('stat-schedules-today').textContent = stats.schedulesToday || 0;
    document.getElementById('stat-drafts-pending').textContent = stats.pendingDrafts || 0;

    const draftsBadge = document.getElementById('drafts-badge');
    if (draftsBadge) {
      draftsBadge.textContent = stats.pendingDrafts || 0;
      draftsBadge.style.display = stats.pendingDrafts > 0 ? 'inline-block' : 'none';
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function loadSchedules() {
  try {
    const res = await fetch('/api/schedules');
    const data = await res.json();

    const todayContainer = document.getElementById('today-schedules-list');
    const paTodayContainer = document.getElementById('pa-today-schedules');
    const paUpcomingContainer = document.getElementById('pa-upcoming-schedules');

    renderScheduleItems(data.today || [], todayContainer);
    if (paTodayContainer) renderScheduleItems(data.today || [], paTodayContainer, true);
    if (paUpcomingContainer) renderScheduleItems(data.upcoming || [], paUpcomingContainer, true);
  } catch (err) {
    console.error('Failed to load schedules:', err);
  }
}

function renderScheduleItems(items, container, withDelete = false) {
  if (!container) return;
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">No meetings scheduled for this period.</div>';
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="itinerary-item">
      <div class="itinerary-time">${item.time_slot}</div>
      <div class="itinerary-details" style="flex: 1;">
        <h5>${escapeHtml(item.title)}</h5>
        <div class="itinerary-loc">📍 ${escapeHtml(item.location || 'Workspace')} ${item.description ? '• ' + escapeHtml(item.description) : ''}</div>
      </div>
      ${withDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteScheduleItem(${item.id})">Delete</button>` : ''}
    </div>
  `).join('');
}

async function loadActivityLogs() {
  try {
    const res = await fetch('/api/logs');
    const logs = await res.json();
    const container = document.getElementById('live-activity-feed');
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = '<div class="empty-state">Awaiting system events...</div>';
      return;
    }

    container.innerHTML = logs.slice(0, 10).map(log => `
      <div class="activity-item ${log.level === 'ERROR' ? 'error' : ''}">
        <div>
          <span style="font-weight:700; color:var(--accent-indigo);">[${log.module}]</span> ${escapeHtml(log.message)}
        </div>
        <span class="activity-time">${new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load logs:', err);
  }
}

async function loadEmails() {
  try {
    const res = await fetch('/api/emails');
    const emails = await res.json();
    const tbody = document.getElementById('emails-table-body');
    document.getElementById('analyzed-email-count').textContent = `${emails.length} Emails`;

    if (emails.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No analyzed emails found yet. Click "Sync & Analyze Inbox Now".</td></tr>';
      return;
    }

    tbody.innerHTML = emails.map(e => {
      let priorityClass = 'badge';
      if (e.priority === 'Urgent') priorityClass = 'badge badge-warning text-danger';
      else if (e.priority === 'High') priorityClass = 'badge text-warning';

      return `
        <tr>
          <td><span class="${priorityClass}">${e.priority || 'Normal'}</span></td>
          <td><b>${escapeHtml(e.sender_name || e.sender_email)}</b></td>
          <td>${escapeHtml(e.subject || '(No Subject)')}</td>
          <td style="max-width: 320px;">${escapeHtml(e.summary || e.snippet)}</td>
          <td><b style="color:var(--accent-rose);">${escapeHtml(e.action_required || 'None')}</b></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load emails:', err);
  }
}

async function loadDrafts() {
  try {
    const res = await fetch('/api/drafts');
    const drafts = await res.json();
    const tbody = document.getElementById('drafts-table-body');
    if (!tbody) return;

    if (drafts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No email drafts created yet.</td></tr>';
      return;
    }

    tbody.innerHTML = drafts.map(d => `
      <tr>
        <td>
          <span class="badge ${d.status === 'PENDING_VERIFICATION' ? 'badge-warning' : (d.status === 'VERIFIED_SENT' ? 'text-success' : 'text-danger')}">
            ${d.status}
          </span>
        </td>
        <td><b>${escapeHtml(d.recipient_email)}</b></td>
        <td>${escapeHtml(d.subject)}</td>
        <td style="max-width: 350px; font-size: 0.78rem;">${escapeHtml(d.body.substring(0, 140))}...</td>
        <td>
          ${d.status === 'PENDING_VERIFICATION' ? `
            <button class="btn btn-sm btn-success" onclick="verifyAndSendDraft(${d.id})">Approve & Send</button>
            <button class="btn btn-sm btn-outline" onclick="cancelDraft(${d.id})">Discard</button>
          ` : `<span>Completed</span>`}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load drafts:', err);
  }
}

async function loadWhatsAppChats() {
  try {
    const res = await fetch('/api/whatsapp/chats');
    const chats = await res.json();
    const tbody = document.getElementById('wa-chats-table-body');
    if (!tbody) return;

    if (chats.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No WhatsApp messages ingested yet. Scan Personal WhatsApp QR code.</td></tr>';
      return;
    }

    tbody.innerHTML = chats.map(c => `
      <tr>
        <td style="font-family:var(--font-mono); font-size:0.75rem;">${new Date(c.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td><b>${escapeHtml(c.sender_name || 'Unknown')}</b></td>
        <td>${escapeHtml(c.sender_phone || '')}</td>
        <td>${escapeHtml(c.message_text)}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load WA chats:', err);
  }
}

async function loadLatestBriefing() {
  try {
    const res = await fetch('/api/briefing/latest');
    const data = await res.json();
    const container = document.getElementById('briefing-preview-body');
    const downloadContainer = document.getElementById('briefing-download-container');

    if (data.available) {
      const viewUrl = resolveUrl(data.viewUrl || data.url);
      const downloadUrl = resolveUrl(data.downloadUrl || data.url);

      downloadContainer.innerHTML = `
        <a href="${viewUrl}" target="_blank" class="btn btn-sm btn-primary">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open in New Tab
        </a>
        <a href="${downloadUrl}" download="${data.filename}" class="btn btn-sm btn-outline">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download PDF (${data.sizeFormatted || data.filename})
        </a>
      `;

      container.innerHTML = `
        <div style="height: 750px; width: 100%;">
          <object data="${viewUrl}" type="application/pdf" style="width: 100%; height: 100%; border: none; border-radius: 8px;">
            <div class="empty-state" style="padding: 40px;">
              <p>Your browser could not embed the PDF preview directly.</p>
              <div style="margin-top: 12px; display:flex; gap:10px; justify-content:center;">
                <a href="${viewUrl}" target="_blank" class="btn btn-primary">View PDF in Fullscreen Tab</a>
                <a href="${downloadUrl}" class="btn btn-outline">Download PDF</a>
              </div>
            </div>
          </object>
        </div>
      `;
    } else {
      downloadContainer.innerHTML = '';
      container.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <p>No briefing generated yet for today.</p>
          <button class="btn btn-primary mt-3" onclick="generateAndSendBriefingNow()">Create Today's Briefing PDF</button>
        </div>
      `;
    }
  } catch (err) {
    console.error('Failed to load briefing:', err);
  }
}

async function loadBriefingArchives() {
  const tbody = document.getElementById('briefings-history-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/briefing/list');
    const list = await res.json();

    if (!list || list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding:24px; color:var(--text-muted);">No archived briefings found. Click "Generate & Dispatch Today's PDF" to produce the first brief.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => {
      const dateFormatted = item.mtime ? new Date(item.mtime).toLocaleString() : 'Recent';
      const viewUrl = resolveUrl(item.viewUrl);
      const downloadUrl = resolveUrl(item.downloadUrl);
      return `
        <tr>
          <td><b>${item.filename}</b></td>
          <td>${item.sizeFormatted}</td>
          <td>${dateFormatted}</td>
          <td>
            <a href="${viewUrl}" target="_blank" class="btn btn-xs btn-outline">View</a>
            <a href="${downloadUrl}" download="${item.filename}" class="btn btn-xs btn-outline">Download</a>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load briefing archive list:', err);
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">Failed to load archive list</td></tr>`;
  }
}

async function forceSyncEmails() {
  showToast('Initiating email synchronization with Gmail API & Gemini AI...');
  try {
    const res = await fetch('/api/emails/sync', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Successfully analyzed ${data.count} recent emails!`);
      loadEmails();
      loadStats();
    } else {
      showToast('Email sync failed: ' + (data.error || 'Check Gmail connection'));
    }
  } catch (err) {
    showToast('Network error during email sync');
  }
}

async function generateAndSendBriefingNow() {
  showToast('Generating Zoro Intelligence PDF briefing...');
  try {
    const res = await fetch('/api/briefing/generate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Zoro Briefing PDF generated and delivered to your WhatsApp!');
      loadLatestBriefing();
      loadStats();
    } else {
      showToast('Briefing failed: ' + (data.error || 'Check settings'));
    }
  } catch (err) {
    showToast('Failed to trigger briefing generation');
  }
}

// Verification Handlers
async function verifyAndSendDraft(id) {
  if (!confirm('Are you sure you want to dispatch this email via official Gmail?')) return;
  try {
    const res = await fetch(`/api/drafts/${id}/confirm`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Email dispatched successfully via Gmail!');
      loadDrafts();
      loadStats();
    } else {
      showToast('Error sending email: ' + data.error);
    }
  } catch (err) {
    showToast('Failed to send verified email');
  }
}

async function cancelDraft(id) {
  try {
    await fetch(`/api/drafts/${id}/cancel`, { method: 'POST' });
    showToast('Draft cancelled.');
    loadDrafts();
    loadStats();
  } catch (err) {
    showToast('Failed to cancel draft');
  }
}

// Schedule Handlers
function openAddScheduleModal() {
  const modal = document.getElementById('modal-add-schedule');
  document.getElementById('sched-date').value = new Date().toISOString().split('T')[0];
  modal.classList.add('active');
}

function closeAddScheduleModal() {
  document.getElementById('modal-add-schedule').classList.remove('active');
}

function setupScheduleForm() {
  const form = document.getElementById('form-add-schedule');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      date: document.getElementById('sched-date').value,
      time_slot: document.getElementById('sched-time').value,
      title: document.getElementById('sched-title').value,
      location: document.getElementById('sched-location').value,
      description: document.getElementById('sched-desc').value,
      priority: document.getElementById('sched-priority').value
    };

    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Meeting added to master itinerary!');
        closeAddScheduleModal();
        form.reset();
        loadSchedules();
        loadStats();
      }
    } catch (err) {
      showToast('Failed to add schedule');
    }
  });
}

async function deleteScheduleItem(id) {
  if (!confirm('Remove this meeting from master itinerary?')) return;
  try {
    await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
    showToast('Meeting removed.');
    loadSchedules();
    loadStats();
  } catch (err) {
    showToast('Failed to delete meeting');
  }
}

// Settings
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    const s = data.settings || {};

    if (s.ACCESS_MODE && document.getElementById('setting-access-mode')) {
      document.getElementById('setting-access-mode').value = s.ACCESS_MODE;
    }
    if (s.USER_PERSONA && document.getElementById('setting-user-persona')) {
      document.getElementById('setting-user-persona').value = s.USER_PERSONA;
    }
    if (s.ASSISTANT_NAME && document.getElementById('setting-assistant-name')) {
      document.getElementById('setting-assistant-name').value = s.ASSISTANT_NAME;
      const navBrand = document.getElementById('nav-org-title');
      if (navBrand) navBrand.textContent = s.ASSISTANT_NAME.toUpperCase();
    }
    if (s.USER_NAME && document.getElementById('setting-user-name')) {
      document.getElementById('setting-user-name').value = s.USER_NAME;
    }

    if (s.GEMINI_API_KEY && document.getElementById('setting-gemini-key')) document.getElementById('setting-gemini-key').value = s.GEMINI_API_KEY;
    if (s.GEMINI_MODEL && document.getElementById('setting-gemini-model')) document.getElementById('setting-gemini-model').value = s.GEMINI_MODEL;
    if (s.GOOGLE_CLIENT_ID && document.getElementById('setting-google-id')) document.getElementById('setting-google-id').value = s.GOOGLE_CLIENT_ID;
    if (s.GOOGLE_CLIENT_SECRET && document.getElementById('setting-google-secret')) document.getElementById('setting-google-secret').value = s.GOOGLE_CLIENT_SECRET;
    if (s.DIRECTOR_PHONE && document.getElementById('setting-director-phone')) document.getElementById('setting-director-phone').value = s.DIRECTOR_PHONE;
    if (s.PA_PHONE && document.getElementById('setting-pa-phone')) document.getElementById('setting-pa-phone').value = s.PA_PHONE;
    if (s.ORGANIZATION_NAME && document.getElementById('setting-org-name')) {
      document.getElementById('setting-org-name').value = s.ORGANIZATION_NAME;
    }
    if (s.DIRECTOR_TITLE && document.getElementById('setting-director-title')) document.getElementById('setting-director-title').value = s.DIRECTOR_TITLE;
    if (s.BRIEFING_TIME && document.getElementById('setting-briefing-time')) document.getElementById('setting-briefing-time').value = s.BRIEFING_TIME;
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function setupSettingsForm() {
  const form = document.getElementById('settings-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      ACCESS_MODE: document.getElementById('setting-access-mode')?.value || 'universal',
      USER_PERSONA: document.getElementById('setting-user-persona')?.value || 'universal',
      ASSISTANT_NAME: document.getElementById('setting-assistant-name')?.value || 'Zoro AI',
      USER_NAME: document.getElementById('setting-user-name')?.value || 'Leader',
      GEMINI_API_KEY: document.getElementById('setting-gemini-key')?.value || '',
      GEMINI_MODEL: document.getElementById('setting-gemini-model')?.value || 'gemini-3.7-flash',
      GOOGLE_CLIENT_ID: document.getElementById('setting-google-id')?.value || '',
      GOOGLE_CLIENT_SECRET: document.getElementById('setting-google-secret')?.value || '',
      DIRECTOR_PHONE: document.getElementById('setting-director-phone')?.value || '',
      PA_PHONE: document.getElementById('setting-pa-phone')?.value || '',
      ORGANIZATION_NAME: document.getElementById('setting-org-name')?.value || '',
      DIRECTOR_TITLE: document.getElementById('setting-director-title')?.value || '',
      BRIEFING_TIME: document.getElementById('setting-briefing-time')?.value || '08:00'
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Settings saved successfully!');
        if (payload.ASSISTANT_NAME) {
          const navBrand = document.getElementById('nav-org-title');
          if (navBrand) navBrand.textContent = payload.ASSISTANT_NAME.toUpperCase();
        }
        loadStatus();
      }
    } catch (err) {
      showToast('Failed to save settings');
    }
  });
}

async function disconnectWhatsApp(sessionType) {
  const label = sessionType === 'director' ? 'Personal WhatsApp' : 'Zoro WhatsApp';
  if (!confirm(`Are you sure you want to disconnect ${label}? This will purge session credentials and generate a fresh pairing QR code.`)) {
    return;
  }

  showToast(`Disconnecting ${label}...`);
  try {
    const res = await fetch(`/api/whatsapp/disconnect/${sessionType}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`${label} disconnected. Generating new QR...`);
      loadStatus();
    } else {
      showToast(`Disconnect failed: ${data.error || 'Server error'}`);
    }
  } catch (err) {
    showToast(`Network error disconnecting ${label}`);
  }
}

async function executeClearSelectedData() {
  const clearChats = document.getElementById('clear-opt-chats')?.checked;
  const clearEmails = document.getElementById('clear-opt-emails')?.checked;
  const clearDrafts = document.getElementById('clear-opt-drafts')?.checked;
  const clearSchedules = document.getElementById('clear-opt-schedules')?.checked;
  const clearBriefings = document.getElementById('clear-opt-briefings')?.checked;
  const clearLogs = document.getElementById('clear-opt-logs')?.checked;

  if (!clearChats && !clearEmails && !clearDrafts && !clearSchedules && !clearBriefings && !clearLogs) {
    showToast('Please select at least one item to clear.');
    return;
  }

  if (!confirm('Are you sure you want to clear the selected records? This cannot be undone.')) {
    return;
  }

  showToast('Clearing selected data records...');
  try {
    const res = await fetch('/api/system/clear-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clearChats,
        clearEmails,
        clearDrafts,
        clearSchedules,
        clearBriefings,
        clearLogs
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Data cleared: ' + data.message);
      loadStats();
      if (clearEmails) loadEmails();
      if (clearDrafts) loadDrafts();
      if (clearSchedules) loadSchedules();
      if (clearChats) loadWhatsAppChats();
      if (clearBriefings) {
        loadLatestBriefing();
        loadBriefingArchives();
      }
    } else {
      showToast('Clear failed: ' + (data.error || 'Server error'));
    }
  } catch (err) {
    showToast('Network error during data clearance');
  }
}

async function executeFullSystemReset() {
  const confirmation = prompt('DANGER ZONE: Type "RESET" in all caps to confirm wiping all stored chats, emails, drafts, schedules, briefings, and WhatsApp sessions:');
  if (confirmation !== 'RESET') {
    if (confirmation !== null) showToast('Reset cancelled. You must type "RESET" to confirm.');
    return;
  }

  showToast('Initiating complete system wipe and reset...');
  try {
    const res = await fetch('/api/system/clear-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clearChats: true,
        clearEmails: true,
        clearDrafts: true,
        clearSchedules: true,
        clearLogs: true,
        clearBriefings: true,
        disconnectDirector: true,
        disconnectBot: true
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Full system wipe completed! Reloading dashboard in 2s...');
      setTimeout(() => window.location.reload(), 2000);
    } else {
      showToast('Reset failed: ' + (data.error || 'Server error'));
    }
  } catch (err) {
    showToast('Network error during full system reset');
  }
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const cleanUrl = basePath ? `${basePath}/` : window.location.pathname;
  if (params.get('auth') === 'success') {
    showToast(`Google Gmail connected: ${params.get('email')}`);
    window.history.replaceState({}, document.title, cleanUrl);
    loadStatus();
    loadStats();
    loadEmails();
  } else if (params.get('auth') === 'error' || params.get('auth') === 'failed') {
    showToast(`OAuth Error: ${params.get('msg')}`);
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>⚡</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== GOOGLE ACCOUNT DISCONNECT ====================
async function disconnectGmailAccount() {
  if (!confirm('Are you sure you want to disconnect this Google Account? This will remove saved OAuth tokens and pause automatic email ingestion.')) {
    return;
  }
  try {
    const res = await fetch('/api/gmail/disconnect', { method: 'POST' });
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`Server returned (${res.status} ${res.statusText}). Please make sure your server is restarted with the latest code.`);
    }

    if (data.success) {
      showToast('Google account disconnected successfully.');
      await loadStatus();
      await loadStats();
      await loadEmails();
    } else {
      showToast(`Error: ${data.error || 'Failed to disconnect'}`);
    }
  } catch (err) {
    showToast(`Disconnect failed: ${err.message}`);
  }
}

// ==================== LIVE DIAGNOSTICS SUITE ====================

// 1. Gemini AI Test
async function runGeminiTest() {
  const resultBox = document.getElementById('diag-gemini-result');
  const btn = document.getElementById('btn-test-gemini');
  resultBox.className = 'diag-output';
  resultBox.textContent = 'Querying Gemini API...';
  btn.disabled = true;

  const startTime = Date.now();
  try {
    const res = await fetch('/api/test/gemini', { method: 'POST' });
    const data = await res.json();
    const duration = Date.now() - startTime;

    if (data.success) {
      resultBox.className = 'diag-output success';
      resultBox.textContent = `[SUCCESS] (${duration}ms)\nModel: ${data.model}\nResponse:\n"${data.response}"`;
      showToast('Gemini 3.7 Flash test passed!');
    } else {
      resultBox.className = 'diag-output error';
      resultBox.textContent = `[ERROR] Failed to query Gemini:\n${data.error}`;
      showToast('Gemini test failed.');
    }
  } catch (err) {
    resultBox.className = 'diag-output error';
    resultBox.textContent = `[NETWORK ERROR]: ${err.message}`;
    showToast('Failed to reach backend server.');
  } finally {
    btn.disabled = false;
  }
}

// 2. WhatsApp Bot Ping Test
async function runWhatsAppPing(target) {
  const resultBox = document.getElementById('diag-wa-result');
  const btnDir = document.getElementById('btn-test-ping-dir');
  const btnPa = document.getElementById('btn-test-ping-pa');
  resultBox.className = 'diag-output';
  resultBox.textContent = `Dispatching ping message to ${target.toUpperCase()} via Zoro WhatsApp...`;
  if (btnDir) btnDir.disabled = true;
  if (btnPa) btnPa.disabled = true;

  try {
    const res = await fetch('/api/test/whatsapp-ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    const data = await res.json();

    if (data.success) {
      resultBox.className = 'diag-output success';
      resultBox.textContent = `[SUCCESS]\n${data.message}\nCheck the recipient's WhatsApp for the verification text!`;
      showToast(`Ping sent to ${target === 'pa' ? 'Collaborator' : 'Primary'} WhatsApp!`);
    } else {
      resultBox.className = 'diag-output error';
      resultBox.textContent = `[ERROR]\n${data.error}\n(Make sure Zoro WhatsApp QR is scanned in Connectors tab and the number is saved in Settings)`;
      showToast(`WhatsApp ping failed: ${data.error}`);
    }
  } catch (err) {
    resultBox.className = 'diag-output error';
    resultBox.textContent = `[NETWORK ERROR]: ${err.message}`;
    showToast('Failed to reach server.');
  } finally {
    if (btnDir) btnDir.disabled = false;
    if (btnPa) btnPa.disabled = false;
  }
}

// 3. Gmail Sync & Urgency Test
async function runGmailTest() {
  const resultBox = document.getElementById('diag-gmail-result');
  const btn = document.getElementById('btn-test-gmail');
  resultBox.className = 'diag-output';
  resultBox.textContent = 'Connecting to Gmail API and analyzing recent inbox messages...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/emails/sync', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      resultBox.className = 'diag-output success';
      resultBox.textContent = `[SUCCESS]\nSynchronized and analyzed ${data.count} recent emails via Gemini 3.7 Flash!\nData saved to database and ready for briefings.`;
      showToast(`Analyzed ${data.count} emails!`);
      loadEmails();
      loadStats();
    } else {
      resultBox.className = 'diag-output error';
      resultBox.textContent = `[ERROR]\n${data.error}\n(Ensure Google account is connected in Overview or Gmail tab)`;
      showToast('Gmail sync failed.');
    }
  } catch (err) {
    resultBox.className = 'diag-output error';
    resultBox.textContent = `[NETWORK ERROR]: ${err.message}`;
    showToast('Failed to reach server.');
  } finally {
    btn.disabled = false;
  }
}

// 4. Sample PDF Briefing Test
async function runBriefingTest() {
  const resultBox = document.getElementById('diag-briefing-result');
  const btn = document.getElementById('btn-test-briefing');
  resultBox.className = 'diag-output';
  resultBox.textContent = 'Generating daily PDF briefing and dispatching to WhatsApp...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/briefing/generate', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      resultBox.className = 'diag-output success';
      resultBox.textContent = `[SUCCESS]\nBriefing PDF Generated: ${data.filename}\nDispatched to WhatsApp: ${data.dispatched ? 'YES' : 'No (check Zoro session)'}\nSaved to: storage/briefings/`;
      showToast('Daily briefing PDF generated successfully!');
      loadLatestBriefing();
    } else {
      resultBox.className = 'diag-output error';
      resultBox.textContent = `[ERROR]\n${data.error || 'Failed to generate briefing'}`;
      showToast('Failed to generate briefing.');
    }
  } catch (err) {
    resultBox.className = 'diag-output error';
    resultBox.textContent = `[NETWORK ERROR]: ${err.message}`;
    showToast('Failed to reach server.');
  } finally {
    btn.disabled = false;
  }
}
