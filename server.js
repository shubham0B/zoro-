import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { initDatabase, query, getSetting, setSetting, logActivity, getDbStatus, getRecruitmentSetting, setRecruitmentSetting, getAllRecruitmentSettings } from './src/database/db.js';
import { getAuthUrl, handleOAuthCallback, getGmailStatus, fetchUnreadEmails, sendVerifiedEmail, disconnectGmail } from './src/services/gmailService.js';
import { analyzeEmails, getGeminiClient, getGeminiModel } from './src/services/geminiService.js';
import { addSchedule, getSchedulesByDate, deleteSchedule, getUpcomingSchedules } from './src/services/scheduleService.js';
import { loginUser, validateSession, logoutSession, changeUserPassword, updateUserProfile, addTeamMember, getTeamMembers, deleteTeamMember } from './src/services/authService.js';
import {
  getRecruitmentAuthUrl,
  handleRecruitmentOAuthCallback,
  getRecruitmentStatus,
  scanRecruitmentInbox,
  sendConfirmationEmail,
  disconnectRecruitmentGmail,
  testSmtpConnection,
  startRecruitmentPollingEngine
} from './src/services/recruitmentService.js';
import {
  startDirectorSession,
  startBotSession,
  getWhatsAppStatus,
  setSocketIO,
  triggerDailyBriefing,
  sendTestPing,
  disconnectDirectorSession,
  disconnectBotSession
} from './src/whatsapp/baileysManager.js';
import { getLocalDateStr } from './src/utils/dateUtils.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

setSocketIO(io);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to reliably detect subpath for reverse proxy (e.g. /directorbot)
function detectSubpath(req) {
  // 1. Explicit env var
  if (process.env.APP_BASE_PATH) {
    return process.env.APP_BASE_PATH.replace(/\/+$/, '');
  }

  // 2. X-Forwarded-Prefix header from reverse proxy
  if (req.headers['x-forwarded-prefix']) {
    return req.headers['x-forwarded-prefix'].replace(/\/+$/, '');
  }

  // 3. Request URL or original URL
  if (req.originalUrl && req.originalUrl.startsWith('/directorbot')) {
    return '/directorbot';
  }
  if (req.url && req.url.startsWith('/directorbot')) {
    return '/directorbot';
  }

  // 4. X-Original-URI header
  if (req.headers['x-original-uri'] && req.headers['x-original-uri'].startsWith('/directorbot')) {
    return '/directorbot';
  }

  // 5. Host matching ai.jecrcuniversity.edu.in
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (host.includes('ai.jecrcuniversity.edu.in')) {
    return '/directorbot';
  }

  // 6. Referer header check
  if (req.headers.referer && req.headers.referer.includes('/directorbot')) {
    return '/directorbot';
  }

  // 7. Configured Google Redirect URI
  const googleUri = process.env.GOOGLE_REDIRECT_URI || '';
  if (googleUri.includes('/directorbot')) {
    return '/directorbot';
  }

  return '';
}

// Subpath & Reverse Proxy Compatibility Middleware
app.use((req, res, next) => {
  req.subpath = detectSubpath(req);

  if (req.url === '/directorbot') {
    return res.redirect('/directorbot/');
  }
  if (req.url.startsWith('/directorbot/')) {
    req.url = req.url.substring('/directorbot'.length);
    if (!req.url.startsWith('/')) req.url = '/' + req.url;
  }
  next();
});

// Cookie Parser Helper
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Token Extractor
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  if (req.headers['x-auth-token']) {
    return req.headers['x-auth-token'];
  }
  const cookies = parseCookies(req);
  if (cookies['auth_token']) {
    return cookies['auth_token'];
  }
  if (req.query && req.query.token) {
    return req.query.token;
  }
  return null;
}

// Login Page Route: If already authenticated, redirect to appropriate portal
app.get('/login.html', async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  if (req.query.logout === 'true') {
    return res.sendFile(path.join(__dirname, 'src/public/login.html'));
  }
  const token = extractToken(req);
  if (token) {
    const user = await validateSession(token);
    if (user) {
      if (user.role === 'recruiter_admin' || user.role === 'recruiter') {
        return res.redirect(`${subpath || ''}/recruitment/`);
      }
      return res.redirect(`${subpath || ''}/`);
    }
  }
  res.sendFile(path.join(__dirname, 'src/public/login.html'));
});

// Protect Root Page: Director Command Hub (Recruiters strictly blocked & redirected)
app.get(['/', '/index.html'], async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  const token = extractToken(req);
  if (!token) {
    return res.redirect(`${subpath || ''}/login.html`);
  }
  const user = await validateSession(token);
  if (!user) {
    return res.redirect(`${subpath || ''}/login.html`);
  }
  if (user.role === 'recruiter_admin' || user.role === 'recruiter') {
    // Recruiter cannot access Director Bot dashboard, redirect to Recruitment Hub
    return res.redirect(`${subpath || ''}/recruitment/`);
  }
  res.sendFile(path.join(__dirname, 'src/public/index.html'));
});

// Protect Recruitment Portal Page
app.get(['/recruitment', '/recruitment/', '/recruitment/index.html'], async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  const token = extractToken(req);
  if (!token) {
    return res.redirect(`${subpath || ''}/login.html`);
  }
  const user = await validateSession(token);
  if (!user) {
    return res.redirect(`${subpath || ''}/login.html`);
  }
  res.sendFile(path.join(__dirname, 'src/public/recruitment/index.html'));
});

// Static files (explicitly excluding auto-serving index.html so / is guarded)
app.use(express.static(path.join(__dirname, 'src/public'), { index: false }));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// Helper to get dashboard root URL for redirects
async function getDashboardRedirectUrl() {
  const redirectUri = (await getSetting('GOOGLE_REDIRECT_URI')) || process.env.GOOGLE_REDIRECT_URI || '';
  if (redirectUri.includes('/auth/google/callback')) {
    return redirectUri.replace(/\/auth\/google\/callback.*$/, '');
  }
  return '';
}

// --- Google OAuth2 Routes ---
app.get('/auth/google', async (req, res) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    const dash = await getDashboardRedirectUrl();
    res.status(500).send(`<h3>Google OAuth Error</h3><p>${err.message}</p><p><a href="${dash || '/'}">Back to Dashboard</a></p>`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  const dash = await getDashboardRedirectUrl();
  const { code, error, state } = req.query;

  // Handle Recruitment Mailbox OAuth callback (uses state=recruitment)
  if (state === 'recruitment') {
    if (error) {
      return res.redirect(`${subpath || ''}/recruitment/?auth=failed&msg=${encodeURIComponent(error)}`);
    }
    if (!code) {
      return res.redirect(`${subpath || ''}/recruitment/?auth=failed&msg=Missing_authorization_code`);
    }
    try {
      const result = await handleRecruitmentOAuthCallback(code);
      return res.redirect(`${subpath || ''}/recruitment/?auth=success&email=${encodeURIComponent(result.email)}`);
    } catch (err) {
      return res.redirect(`${subpath || ''}/recruitment/?auth=error&msg=${encodeURIComponent(err.message)}`);
    }
  }

  // Handle Director Google OAuth callback
  if (error) {
    return res.redirect(`${dash}/?auth=failed&msg=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${dash}/?auth=failed&msg=Missing_authorization_code`);
  }

  try {
    const result = await handleOAuthCallback(code);
    if (result.isRecruitment) {
      return res.redirect(`${subpath || ''}/recruitment/?auth=success&email=${encodeURIComponent(result.email)}`);
    }
    res.redirect(`${dash}/?auth=success&email=${encodeURIComponent(result.email)}`);
  } catch (err) {
    res.redirect(`${dash}/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// --- Recruitment Google OAuth2 Routes ---
app.get(['/auth/recruitment/google', '/directorbot/auth/recruitment/google'], async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  try {
    const url = await getRecruitmentAuthUrl();
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`<h3>Recruitment Google OAuth Error</h3><p>${err.message}</p><p><a href="${subpath || ''}/recruitment/">Back to Recruitment Hub</a></p>`);
  }
});

app.get(['/auth/recruitment/google/callback', '/directorbot/auth/recruitment/google/callback'], async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`${subpath || ''}/recruitment/?auth=failed&msg=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${subpath || ''}/recruitment/?auth=failed&msg=Missing_authorization_code`);
  }

  try {
    const result = await handleRecruitmentOAuthCallback(code);
    res.redirect(`${subpath || ''}/recruitment/?auth=success&email=${encodeURIComponent(result.email)}`);
  } catch (err) {
    res.redirect(`${subpath || ''}/recruitment/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// --- Auth API Endpoints ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    const result = await loginUser(email, password, userAgent, ip);
    if (!result.success) {
      return res.status(401).json(result);
    }

    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('auth_token', result.token, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
      sameSite: 'lax',
      secure: isHttps
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.all(['/logout', '/directorbot/logout', '/api/auth/logout', '/directorbot/api/auth/logout'], async (req, res) => {
  const subpath = req.subpath || detectSubpath(req);
  try {
    const token = extractToken(req);
    if (token) {
      await logoutSession(token);
    }
  } catch (err) {}

  res.clearCookie('auth_token', { path: '/' });
  res.clearCookie('auth_token', { path: '/directorbot' });
  res.clearCookie('auth_token', { path: '/directorbot/' });
  res.setHeader('Set-Cookie', [
    'auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0',
    'auth_token=; Path=/directorbot; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0',
    'auth_token=; Path=/directorbot/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0'
  ]);

  if (req.headers.accept?.includes('application/json') && req.method === 'POST') {
    return res.json({ success: true, message: 'Logged out successfully' });
  }

  return res.redirect(`${subpath || ''}/login.html?logout=true`);
});

// Guard Middleware for all remaining /api/* endpoints
app.use('/api', async (req, res, next) => {
  if (req.path === '/auth/login') return next();

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Authentication required.' });
  }

  const user = await validateSession(token);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Session expired or invalid. Please log in again.' });
  }

  req.user = user;
  req.authToken = token;

  // Strict role isolation: Recruiters are forbidden from Director Bot routes
  const isRecruiter = user.role === 'recruiter_admin' || user.role === 'recruiter';
  if (isRecruiter) {
    const isAllowedForRecruiter = 
      req.path.startsWith('/recruitment') ||
      req.path.startsWith('/auth/me') ||
      req.path.startsWith('/auth/profile') ||
      req.path.startsWith('/auth/change-password') ||
      req.path.startsWith('/auth/logout');

    if (!isAllowedForRecruiter) {
      return res.status(403).json({ success: false, error: 'Access denied: Executive Director clearance required.' });
    }
  }

  next();
});

// Authenticated user profile
app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: req.user });
});

// Change Password endpoint
app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const result = await changeUserPassword(req.user.id, currentPassword, newPassword);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Profile (Change Email & Name)
app.post('/api/auth/profile', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const result = await updateUserProfile(req.user.id, email, name);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// --- Recruitment & Hiring Automation APIs ---
// ==========================================

// Get Recruitment Mailbox & Stats Status
app.get('/api/recruitment/status', async (req, res) => {
  try {
    const status = await getRecruitmentStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List Candidate Applications with Search & Filter
app.get('/api/recruitment/applications', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search.trim()}%` : null;
    const status = req.query.status ? req.query.status.trim() : null;

    let sql = 'SELECT * FROM candidate_applications WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND (candidate_name LIKE ? OR candidate_email LIKE ? OR applied_post LIKE ? OR application_id LIKE ?)';
      params.push(search, search, search, search);
    }

    if (status && status !== 'ALL') {
      sql += ' AND confirmation_status = ?';
      params.push(status);
    }

    // Clean out any bogus non-job bank/statement rows
    try {
      await query(`DELETE FROM candidate_applications WHERE 
        candidate_email LIKE '%pnb%' OR 
        candidate_email LIKE '%estatement%' OR 
        candidate_name LIKE '%estatement%' OR 
        email_subject LIKE '%statement%' OR 
        email_subject LIKE '%bank%'`);
    } catch (e) {}

    sql += ' ORDER BY created_at DESC LIMIT 300';
    const rows = await query(sql, params);

    res.json({ success: true, applications: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clear All Candidate Applications History
app.delete('/api/recruitment/applications', async (req, res) => {
  try {
    await query('DELETE FROM candidate_applications');
    await logActivity('RECRUITMENT', `All candidate application history cleared by ${req.user.email}`, 'WARN');
    res.json({ success: true, message: 'All application history cleared successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete Single Application Record
app.delete('/api/recruitment/applications/:id', async (req, res) => {
  try {
    await query('DELETE FROM candidate_applications WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Application record deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger Instant Inbox Scan
app.post('/api/recruitment/scan-now', async (req, res) => {
  try {
    const result = await scanRecruitmentInbox();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send / Resend Confirmation Email
app.post('/api/recruitment/send-confirmation/:id', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM candidate_applications WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Application record not found' });
    }

    const appRecord = rows[0];
    const dispatchResult = await sendConfirmationEmail({
      candidateEmail: appRecord.candidate_email,
      candidateName: appRecord.candidate_name,
      appliedPost: appRecord.applied_post,
      applicationId: appRecord.application_id
    });

    await query(
      `UPDATE candidate_applications SET
        confirmation_status = 'SENT',
        confirmation_method = ?,
        confirmation_sent_at = NOW(),
        confirmation_error = NULL
       WHERE id = ?`,
      [dispatchResult.method, req.params.id]
    );

    res.json({ success: true, message: `Confirmation sent successfully via ${dispatchResult.method}` });
  } catch (err) {
    await query('UPDATE candidate_applications SET confirmation_error = ? WHERE id = ?', [err.message, req.params.id]);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get Recruitment & SMTP Settings
app.get('/api/recruitment/settings', async (req, res) => {
  try {
    const settings = await getAllRecruitmentSettings();
    const masked = {
      ...settings,
      smtp_pass: settings.smtp_pass ? '••••••••' : ''
    };
    res.json({ success: true, settings: masked });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save Recruitment & SMTP Settings
app.post('/api/recruitment/settings', async (req, res) => {
  try {
    const {
      dispatch_method,
      smtp_host,
      smtp_port,
      smtp_secure,
      smtp_user,
      smtp_pass,
      smtp_from_name,
      smtp_from_email,
      auto_reply_enabled,
      email_subject_template,
      email_body_template
    } = req.body;

    if (dispatch_method !== undefined) await setRecruitmentSetting('dispatch_method', dispatch_method);
    if (smtp_host !== undefined) await setRecruitmentSetting('smtp_host', smtp_host);
    if (smtp_port !== undefined) await setRecruitmentSetting('smtp_port', String(smtp_port));
    if (smtp_secure !== undefined) await setRecruitmentSetting('smtp_secure', String(smtp_secure));
    if (smtp_user !== undefined) await setRecruitmentSetting('smtp_user', smtp_user);
    if (smtp_pass !== undefined && smtp_pass !== '••••••••' && smtp_pass.trim() !== '') {
      await setRecruitmentSetting('smtp_pass', smtp_pass);
    }
    if (smtp_from_name !== undefined) await setRecruitmentSetting('smtp_from_name', smtp_from_name);
    if (smtp_from_email !== undefined) await setRecruitmentSetting('smtp_from_email', smtp_from_email);
    if (auto_reply_enabled !== undefined) await setRecruitmentSetting('auto_reply_enabled', String(auto_reply_enabled));
    if (email_subject_template !== undefined) await setRecruitmentSetting('email_subject_template', email_subject_template);
    if (email_body_template !== undefined) await setRecruitmentSetting('email_body_template', email_body_template);

    await logActivity('RECRUITMENT', `Recruitment settings updated by ${req.user.email}`, 'INFO');
    res.json({ success: true, message: 'Recruitment settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test SMTP Connection
app.post('/api/recruitment/test-smtp', async (req, res) => {
  try {
    const { host, port, secure, user, pass, fromEmail, fromName, testRecipient } = req.body;
    let actualPass = pass;
    if (pass === '••••••••' || !pass) {
      actualPass = await getRecruitmentSetting('smtp_pass');
    }

    const result = await testSmtpConnection({
      host,
      port,
      secure,
      user,
      pass: actualPass,
      fromEmail,
      fromName,
      testRecipient
    });

    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disconnect Hiring Gmail
app.post('/api/recruitment/disconnect-gmail', async (req, res) => {
  try {
    await disconnectRecruitmentGmail();
    res.json({ success: true, message: 'Hiring Gmail inbox disconnected successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Team Member Management
app.get('/api/recruitment/team', async (req, res) => {
  try {
    const members = await getTeamMembers();
    res.json({ success: true, members });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/recruitment/team', async (req, res) => {
  try {
    const result = await addTeamMember(req.user, req.body);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/recruitment/team/:id', async (req, res) => {
  try {
    const result = await deleteTeamMember(req.params.id, req.user);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disconnect Google Account
app.post('/api/gmail/disconnect', async (req, res) => {
  try {
    await disconnectGmail();
    res.json({ success: true, message: 'Google account disconnected successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic / Test Endpoints
app.post('/api/test/gemini', async (req, res) => {
  try {
    const client = await getGeminiClient();
    if (!client) return res.status(400).json({ success: false, error: 'Gemini API key is not configured.' });
    const model = await getGeminiModel();
    const response = await client.models.generateContent({
      model,
      contents: 'Respond in 1 short sentence: "Executive AI Chief of Staff (Gemini 3.7 Flash) is operational."'
    });
    const text = typeof response.text === 'function' ? response.text() : (response.text || '');
    res.json({ success: true, model, response: text.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/test/whatsapp-ping', async (req, res) => {
  try {
    const { target } = req.body; // 'director' or 'pa'
    const dirPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE;
    const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE;
    
    const phone = target === 'pa' ? paPhone : dirPhone;
    if (!phone) return res.status(400).json({ success: false, error: `${target === 'pa' ? 'Collaborator' : 'Primary'} phone number is not configured in Settings.` });

    await sendTestPing(phone);
    res.json({ success: true, message: `Test WhatsApp ping dispatched to ${phone}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API Endpoints ---

// 1. Overall System Status
app.get('/api/status', async (req, res) => {
  try {
    const db = getDbStatus();
    const wa = getWhatsAppStatus();
    const gmail = await getGmailStatus();
    const geminiClient = await getGeminiClient();

    res.json({
      database: db,
      whatsapp: wa,
      gmail,
      gemini: { configured: !!geminiClient }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Dashboard Quick Stats
app.get('/api/stats', async (req, res) => {
  try {
    const today = getLocalDateStr();

    const [emailStats] = await query(`SELECT COUNT(*) as total FROM email_summaries WHERE DATE(created_at) = ?`, [today]);
    const [chatStats] = await query(`SELECT COUNT(*) as total FROM whatsapp_chats WHERE DATE(created_at) = ?`, [today]);
    const [scheduleStats] = await query(`SELECT COUNT(*) as total FROM schedules WHERE date = ?`, [today]);
    const [pendingDrafts] = await query(`SELECT COUNT(*) as total FROM email_drafts WHERE status = 'PENDING_VERIFICATION'`);

    res.json({
      emailsToday: emailStats.total || 0,
      chatsToday: chatStats.total || 0,
      schedulesToday: scheduleStats.total || 0,
      pendingDrafts: pendingDrafts.total || 0
    });
  } catch (err) {
    res.json({ emailsToday: 0, chatsToday: 0, schedulesToday: 0, pendingDrafts: 0 });
  }
});

// 3. Schedules
app.get('/api/schedules', async (req, res) => {
  try {
    const today = req.query.date || getLocalDateStr();
    const schedules = await getSchedulesByDate(today);
    const upcoming = await getUpcomingSchedules();
    res.json({ today: schedules, upcoming });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { date, time_slot, title, description, location, priority } = req.body;
    if (!time_slot || !title) {
      return res.status(400).json({ error: 'time_slot and title are required' });
    }
    const id = await addSchedule({
      date: date || getLocalDateStr(),
      time_slot,
      title,
      description,
      location,
      priority,
      created_by: 'Dashboard'
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    await deleteSchedule(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Emails Intelligence
app.get('/api/emails', async (req, res) => {
  try {
    const emails = await query(
      `SELECT * FROM email_summaries ORDER BY id DESC LIMIT 50`
    );
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/sync', async (req, res) => {
  try {
    const raw = await fetchUnreadEmails(20, false);
    const analyzed = await analyzeEmails(raw);

    for (const em of analyzed) {
      try {
        await query(
          `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE priority = VALUES(priority), summary = VALUES(summary), action_required = VALUES(action_required)`,
          [em.id, em.senderEmail || '', em.senderName || '', em.subject || '', em.snippet || '', em.date || '', em.priority, em.summary, em.action_required]
        );
      } catch (e) {}
    }

    res.json({ success: true, count: analyzed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Email Drafts (Verification Center)
app.get('/api/drafts', async (req, res) => {
  try {
    const drafts = await query('SELECT * FROM email_drafts ORDER BY id DESC LIMIT 20');
    res.json(drafts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/confirm', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    const draft = rows[0];

    await sendVerifiedEmail({
      to: draft.recipient_email,
      subject: draft.subject,
      body: draft.body,
      draftId: draft.id
    });

    res.json({ success: true, message: 'Email sent successfully via Gmail API' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/cancel', async (req, res) => {
  try {
    await query(`UPDATE email_drafts SET status = 'CANCELLED' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. WhatsApp Chats (Silent View)
app.get('/api/whatsapp/chats', async (req, res) => {
  try {
    const chats = await query(
      `SELECT * FROM whatsapp_chats ORDER BY id DESC LIMIT 50`
    );
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. WhatsApp Disconnect Endpoints
app.post('/api/whatsapp/disconnect/director', async (req, res) => {
  try {
    const result = await disconnectDirectorSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/disconnect/bot', async (req, res) => {
  try {
    const result = await disconnectBotSession();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Data Clearing & System Reset
app.post('/api/system/clear-data', async (req, res) => {
  try {
    const {
      clearChats,
      clearEmails,
      clearDrafts,
      clearSchedules,
      clearLogs,
      clearBriefings,
      disconnectDirector,
      disconnectBot,
      clearGoogle,
      clearPhones
    } = req.body;

    const clearedItems = [];

    if (clearChats) {
      await query('TRUNCATE TABLE whatsapp_chats');
      clearedItems.push('WhatsApp chats');
    }

    if (clearEmails) {
      await query('TRUNCATE TABLE email_summaries');
      clearedItems.push('Email summaries');
    }

    if (clearDrafts) {
      await query('TRUNCATE TABLE email_drafts');
      clearedItems.push('Email drafts');
    }

    if (clearSchedules) {
      await query('TRUNCATE TABLE schedules');
      clearedItems.push('Schedules');
    }

    if (clearLogs) {
      await query('TRUNCATE TABLE activity_logs');
      clearedItems.push('Activity logs');
    }

    if (clearBriefings) {
      const dir = path.join(__dirname, 'storage/briefings');
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
        }
      }
      clearedItems.push('Briefing PDFs');
    }

    if (clearPhones) {
      await query("DELETE FROM system_settings WHERE `key_name` IN ('DIRECTOR_PHONE', 'PA_PHONE')");
      clearedItems.push('Director and PA phone numbers');
    }

    if (clearGoogle) {
      await disconnectGmail();
      clearedItems.push('Google Account');
    }

    if (disconnectDirector) {
      await disconnectDirectorSession();
      clearedItems.push('Director WhatsApp session');
    }

    if (disconnectBot) {
      await disconnectBotSession();
      clearedItems.push('Bot WhatsApp session');
    }

    await logActivity('SYSTEM_RESET', `System data reset: ${clearedItems.join(', ')}`, 'WARN');
    res.json({ success: true, message: clearedItems.join(', ') || 'No data selected' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Executive Briefing Generation & Streaming API
app.post('/api/briefing/generate', async (req, res) => {
  try {
    const result = await triggerDailyBriefing();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/briefing/list', (req, res) => {
  const dir = path.join(__dirname, 'storage/briefings');
  if (!fs.existsSync(dir)) return res.json([]);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  files.sort().reverse();

  const list = files.map(file => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    return {
      filename: file,
      sizeBytes: stats.size,
      sizeFormatted: `${(stats.size / 1024).toFixed(1)} KB`,
      mtime: stats.mtime,
      viewUrl: `/api/briefing/view/${encodeURIComponent(file)}`,
      downloadUrl: `/api/briefing/download/${encodeURIComponent(file)}`
    };
  });

  res.json(list);
});

app.get('/api/briefing/latest', (req, res) => {
  const dir = path.join(__dirname, 'storage/briefings');
  if (!fs.existsSync(dir)) return res.json({ available: false });

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  if (files.length === 0) return res.json({ available: false });

  files.sort().reverse();
  const latestFile = files[0];
  const stats = fs.statSync(path.join(dir, latestFile));

  res.json({
    available: true,
    filename: latestFile,
    sizeFormatted: `${(stats.size / 1024).toFixed(1)} KB`,
    viewUrl: `/api/briefing/view/${encodeURIComponent(latestFile)}`,
    downloadUrl: `/api/briefing/download/${encodeURIComponent(latestFile)}`,
    url: `/api/briefing/view/${encodeURIComponent(latestFile)}`
  });
});

app.get(['/api/briefing/view/:filename', '/api/briefing/view', '/directorbot/api/briefing/view/:filename', '/directorbot/api/briefing/view'], (req, res) => {
  const rawParam = req.params.filename || req.query.file;
  if (!rawParam) {
    return res.status(400).send('Filename parameter required');
  }
  const filename = path.basename(rawParam);
  const filePath = path.join(__dirname, 'storage/briefings', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send(`Briefing PDF file not found: ${filename}`);
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

app.get(['/api/briefing/download/:filename', '/api/briefing/download', '/directorbot/api/briefing/download/:filename', '/directorbot/api/briefing/download'], (req, res) => {
  const rawParam = req.params.filename || req.query.file;
  if (!rawParam) {
    return res.status(400).send('Filename parameter required');
  }
  const filename = path.basename(rawParam);
  const filePath = path.join(__dirname, 'storage/briefings', filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send(`Briefing PDF file not found: ${filename}`);
  }

  res.download(filePath, filename);
});

// 8. Settings Management
app.get('/api/settings', async (req, res) => {
  try {
    const keys = [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'DIRECTOR_PHONE',
      'PA_PHONE',
      'ORGANIZATION_NAME',
      'DIRECTOR_TITLE',
      'BRIEFING_TIME',
      'ACCESS_MODE',
      'USER_PERSONA',
      'USER_NAME',
      'ASSISTANT_NAME'
    ];

    const defaults = {
      ACCESS_MODE: 'universal',
      USER_PERSONA: 'universal',
      USER_NAME: 'Leader',
      ASSISTANT_NAME: 'Zoro AI',
      ORGANIZATION_NAME: 'Zoro AI Hub',
      DIRECTOR_TITLE: 'Zoro Co-Pilot'
    };

    const settings = {};
    for (const k of keys) {
      settings[k] = (await getSetting(k)) || process.env[k] || defaults[k] || '';
    }

    // Mask sensitive keys for security in UI
    const masked = { ...settings };
    if (masked.GEMINI_API_KEY) masked.GEMINI_API_KEY = masked.GEMINI_API_KEY.slice(0, 6) + '••••••••' + masked.GEMINI_API_KEY.slice(-4);
    if (masked.GOOGLE_CLIENT_SECRET) masked.GOOGLE_CLIENT_SECRET = '••••••••••••';

    res.json({ settings: masked, rawConfigured: {
      hasGemini: !!settings.GEMINI_API_KEY,
      hasGoogleId: !!settings.GOOGLE_CLIENT_ID,
      hasGoogleSecret: !!settings.GOOGLE_CLIENT_SECRET
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const allowed = [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'DIRECTOR_PHONE',
      'PA_PHONE',
      'ORGANIZATION_NAME',
      'DIRECTOR_TITLE',
      'BRIEFING_TIME',
      'ACCESS_MODE',
      'USER_PERSONA',
      'USER_NAME',
      'ASSISTANT_NAME'
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== null && !req.body[key].includes('••••')) {
        await setSetting(key, req.body[key]);
      }
    }

    await logActivity('SETTINGS', 'System settings updated via Web Dashboard', 'INFO');
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Activity Logs Feed
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await query('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 40');
    res.json(logs);
  } catch (err) {
    res.json([]);
  }
});

// Diagnostic chat search endpoint
app.get('/api/debug/search-chats', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ count: 0, query: '', sample: [] });
  try {
    const rows = await query(
      `SELECT id, chat_jid, sender_name, sender_phone, message_text, timestamp, is_from_me 
       FROM whatsapp_chats 
       WHERE sender_name LIKE ? OR sender_phone LIKE ? OR chat_jid LIKE ? OR message_text LIKE ? 
       ORDER BY id DESC LIMIT 50`,
      [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
    );
    res.json({ count: rows.length, query: q, sample: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Scheduled Daily Morning Briefing Checker (Indian Standard Time Asia/Kolkata) ---
let lastBriefingDate = '';
setInterval(async () => {
  try {
    const rawSetting = (await getSetting('BRIEFING_TIME')) || process.env.BRIEFING_TIME || '08:00';
    const targetBriefingTime = rawSetting.trim().padStart(5, '0'); // Normalizes "8:00" -> "08:00"

    // Indian Standard Time (IST) calculation
    const now = new Date();
    const timeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const currentTimeStr = timeFormatter.format(now);
    const todayStr = dateFormatter.format(now);

    if (currentTimeStr === targetBriefingTime && lastBriefingDate !== todayStr) {
      lastBriefingDate = todayStr;
      console.log(`[Auto-Briefing] Target briefing time ${targetBriefingTime} IST reached (Current: ${currentTimeStr} IST on ${todayStr}). Triggering briefing...`);
      await triggerDailyBriefing();
    }
  } catch (e) {
    console.error('[Auto-Briefing Checker Error]:', e.message);
  }
}, 15000);

// --- Server Startup ---
const PORT = process.env.PORT || 3000;

async function bootstrap() {
  console.log('--- Starting University Executive AI Assistant ---');
  
  // 1. Init Database
  await initDatabase();

  // 2. Start Dual Baileys WhatsApp Sessions
  console.log('[WhatsApp] Initializing Personal & Zoro WhatsApp instances...');
  startDirectorSession().catch(err => console.error('[Personal WA Error]:', err.message));
  startBotSession().catch(err => console.error('[Zoro WA Error]:', err.message));

  // 3. Start Recruitment Resume Email Poller Engine
  try {
    startRecruitmentPollingEngine();
  } catch (err) {
    console.error('[Recruitment Engine Error]:', err.message);
  }

  // 4. Start Web Server
  server.listen(PORT, () => {
    console.log(`[Server] Executive Dashboard is live at: http://localhost:${PORT}`);
    console.log(`[Server] Google OAuth Redirect URI: http://localhost:${PORT}/auth/google/callback`);
    console.log(`[Server] Recruitment Hub is live at: http://localhost:${PORT}/recruitment/`);
  });
}

bootstrap();
