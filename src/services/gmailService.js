import { google } from 'googleapis';
import { query, getSetting, setSetting, getRecruitmentSetting, setRecruitmentSetting, logActivity } from '../database/db.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Robust check to identify recruitment/candidate/hiring emails so they never contaminate Director's WhatsApp automation
 */
export function isRecruitmentEmailData(emailObj, recruitmentEmail = '') {
  if (!emailObj) return false;
  const sEmail = (emailObj.senderEmail || emailObj.from || emailObj.sender_email || '').toLowerCase();
  const sName = (emailObj.senderName || emailObj.sender_name || '').toLowerCase();
  const subj = (emailObj.subject || '').toLowerCase();
  const snip = (emailObj.snippet || emailObj.summary || emailObj.body || '').toLowerCase();
  const recEmail = (recruitmentEmail || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();

  // 1. Direct address match with recruitment mailbox
  if (recEmail && (sEmail.includes(recEmail) || subj.includes(recEmail))) return true;
  if (sEmail.includes('careers.jecrchospital') || sEmail.includes('careers@') || sEmail.includes('recruitment@') || sEmail.includes('career@') || sEmail.includes('deepak.talkudar')) return true;

  // 2. Recruitment / candidate screening / resume keywords
  const recruitKeywords = [
    'candidate application',
    'application for the post',
    'application for position',
    'job application',
    'curriculum vitae',
    'recruitment confirmation',
    'jecrc hospital recruitment',
    'recruiter team',
    'recruitment report',
    'candidates report',
    'hiring report',
    'application id: jecrc'
  ];
  return recruitKeywords.some(kw => subj.includes(kw) || snip.includes(kw));
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

export async function getOAuth2Client() {
  const clientId = (await getSetting('GOOGLE_CLIENT_ID')) || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = (await getSetting('GOOGLE_CLIENT_SECRET')) || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = (await getSetting('GOOGLE_REDIRECT_URI')) || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates the Google Sign-In / OAuth consent URL for the Director
 */
export async function getAuthUrl() {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth credentials (Client ID and Secret) are not configured.');
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

/**
 * Handles the OAuth2 code callback, stores refresh token in MySQL
 */
export async function handleOAuthCallback(code) {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) throw new Error('OAuth2 client not initialized');

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user's email address
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const connectedEmail = (userInfo.data.email || '').trim().toLowerCase();

  // Guard: If this is the recruitment email, do NOT save it as Director WhatsApp automation!
  const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();
  if (connectedEmail === recruitmentEmail || connectedEmail.includes('careers.jecrchospital') || connectedEmail.includes('career.jecrchospital')) {
    // Route it strictly to recruitment_tokens table
    await query(
      `INSERT INTO recruitment_tokens (email, refresh_token, access_token, expiry_date, scope)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
         access_token = VALUES(access_token),
         expiry_date = VALUES(expiry_date),
         scope = VALUES(scope),
         updated_at = CURRENT_TIMESTAMP`,
      [
        connectedEmail,
        tokens.refresh_token || null,
        tokens.access_token,
        tokens.expiry_date || 0,
        tokens.scope || SCOPES.join(' ')
      ]
    );
    await setRecruitmentSetting('RECRUITMENT_EMAIL', connectedEmail);
    // Remove from google_tokens to ensure complete isolation
    await query('DELETE FROM google_tokens WHERE LOWER(email) = ?', [connectedEmail]);
    await logActivity('RECRUITMENT', `Recruitment Gmail connected via Google OAuth: ${connectedEmail}`, 'INFO');
    return { email: connectedEmail, success: true, isRecruitment: true };
  }

  // Save tokens in MySQL for Director WhatsApp Automation
  await query(
    `INSERT INTO google_tokens (email, refresh_token, access_token, expiry_date, scope)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
       access_token = VALUES(access_token),
       expiry_date = VALUES(expiry_date),
       scope = VALUES(scope),
       updated_at = CURRENT_TIMESTAMP`,
    [
      connectedEmail,
      tokens.refresh_token || null,
      tokens.access_token,
      tokens.expiry_date || 0,
      tokens.scope || SCOPES.join(' ')
    ]
  );

  await setSetting('DIRECTOR_EMAIL', connectedEmail);
  // Ensure no recruitment emails linger in google_tokens
  await query(
    `DELETE FROM google_tokens 
     WHERE LOWER(email) = ? OR LOWER(email) LIKE '%careers%'`,
    [recruitmentEmail]
  );
  await logActivity('GMAIL', `Director Gmail connected successfully: ${connectedEmail}`, 'INFO');
  return { email: connectedEmail, success: true };
}

/**
 * Retrieves authenticated Gmail instance strictly for Director's WhatsApp automation
 */
export async function getAuthenticatedGmail() {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) return null;

  // STRICT SEPARATION: Director Gmail must match DIRECTOR_EMAIL or non-recruitment google_tokens
  const directorEmail = await getSetting('DIRECTOR_EMAIL');
  const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();

  let rows = [];
  if (directorEmail) {
    rows = await query('SELECT * FROM google_tokens WHERE LOWER(email) = ? LIMIT 1', [directorEmail.toLowerCase()]);
  }
  if (!rows || rows.length === 0) {
    rows = await query(
      `SELECT * FROM google_tokens 
       WHERE LOWER(email) != ? 
         AND LOWER(email) NOT LIKE '%careers%' 
         AND LOWER(email) NOT LIKE '%recruitment%' 
       ORDER BY id DESC LIMIT 1`,
      [recruitmentEmail]
    );
  }
  if (!rows || rows.length === 0) return null;

  const tokenRecord = rows[0];
  oauth2Client.setCredentials({
    refresh_token: tokenRecord.refresh_token,
    access_token: tokenRecord.access_token,
    expiry_date: tokenRecord.expiry_date
  });

  // Listen for refresh token events to update MySQL automatically
  oauth2Client.on('tokens', async (newTokens) => {
    if (newTokens.access_token) {
      await query(
        `UPDATE google_tokens SET access_token = ?, expiry_date = ? WHERE id = ?`,
        [newTokens.access_token, newTokens.expiry_date || 0, tokenRecord.id]
      );
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Fetches recent emails from Director's inbox (strictly filtering out recruitment & candidate emails)
 */
export async function fetchUnreadEmails(limit = 15, unreadOnly = false) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail) {
    return [];
  }

  try {
    const queryFilter = unreadOnly 
      ? 'is:unread -category:promotions -category:social' 
      : '-category:promotions -category:social';

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: queryFilter,
      maxResults: limit
    });

    const messages = listRes.data.messages || [];
    const parsed = await parseGmailMessageList(gmail, messages);
    const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();
    return parsed.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
  } catch (error) {
    console.error('[Gmail Service] Failed to fetch emails:', error.message);
    logActivity('GMAIL', `Failed to fetch emails: ${error.message}`, 'ERROR');
    return [];
  }
}

/**
 * Searches Gmail directly with a keyword query across Director's messages (strictly filtering out recruitment)
 */
export async function searchGmail(searchQuery, limit = 10) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail || !searchQuery) {
    return [];
  }

  try {
    const cleanQ = searchQuery.trim();
    console.log(`[Gmail API] Searching inbox for: "${cleanQ}"...`);
    let listRes = await gmail.users.messages.list({
      userId: 'me',
      q: cleanQ,
      maxResults: limit
    });

    let messages = listRes.data.messages || [];

    // If no exact match and query has multiple words (e.g. "iit bombay"), try broad OR search
    if (messages.length === 0 && cleanQ.includes(' ')) {
      const words = cleanQ.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 1) {
        const orQuery = words.join(' OR ');
        console.log(`[Gmail API] No direct match for "${cleanQ}". Trying broad search: "${orQuery}"...`);
        listRes = await gmail.users.messages.list({
          userId: 'me',
          q: orQuery,
          maxResults: limit
        });
        messages = listRes.data.messages || [];
      }
    }

    const results = await parseGmailMessageList(gmail, messages);
    const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();
    const filtered = results.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
    console.log(`[Gmail API] Search for "${cleanQ}" returned ${filtered.length} email(s) (recruitment excluded)`);
    return filtered;
  } catch (error) {
    console.error('[Gmail Service] Search error:', error.message);
    return [];
  }
}

/**
 * Helper to fetch full details for a list of Gmail message IDs concurrently
 */
async function parseGmailMessageList(gmail, messages) {
  if (!messages || messages.length === 0) return [];

  const parsedEmails = await Promise.all(
    messages.slice(0, 10).map(async (msg) => {
      try {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = details.data.payload?.headers || [];
        const getHeader = (name) => {
          const found = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
          return found ? found.value : '';
        };

        const from = getHeader('From');
        const subject = getHeader('Subject') || '(No Subject)';
        const date = getHeader('Date');
        const snippet = details.data.snippet || '';

        // Extract sender name and clean email
        let senderName = from;
        let senderEmail = from;
        const match = from.match(/(.*)<(.*)>/);
        if (match) {
          senderName = match[1].replace(/["']/g, '').trim();
          senderEmail = match[2].trim();
        }

        return {
          id: msg.id,
          threadId: details.data.threadId,
          from: senderName || senderEmail,
          senderEmail,
          senderName,
          subject,
          snippet,
          date
        };
      } catch (e) {
        console.warn(`[Gmail Service] Could not fetch message ${msg.id}:`, e.message);
        return null;
      }
    })
  );

  return parsedEmails.filter(Boolean);
}

/**
 * Sends an email on Director's behalf after verification
 */
export async function sendVerifiedEmail({ to, subject, body, draftId = null }) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail) {
    throw new Error('Director Gmail is not connected. Cannot send email.');
  }

  // Ensure body has clean real newlines and no escaped slashes (\n)
  const cleanBody = (body || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .trim();

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${to}`,
    `Subject: ${utf8Subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    cleanBody
  ];
  const rawMessage = messageParts.join('\r\n');
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage
    }
  });

  if (draftId) {
    await query(
      `UPDATE email_drafts SET status = 'VERIFIED_SENT', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [draftId]
    );
  }

  await logActivity('GMAIL', `Verified email sent to ${to}: "${subject}"`, 'INFO', { to, subject });
  return res.data;
}

/**
 * Gets Gmail Connector status strictly for Director's WhatsApp automation
 */
export async function getGmailStatus() {
  const directorEmail = await getSetting('DIRECTOR_EMAIL');
  const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();

  let rows = [];
  if (directorEmail) {
    rows = await query('SELECT email, updated_at FROM google_tokens WHERE LOWER(email) = ? LIMIT 1', [directorEmail.toLowerCase()]);
  }
  if (!rows || rows.length === 0) {
    rows = await query(
      `SELECT email, updated_at FROM google_tokens 
       WHERE LOWER(email) != ? 
         AND LOWER(email) NOT LIKE '%careers%' 
         AND LOWER(email) NOT LIKE '%recruitment%' 
       ORDER BY id DESC LIMIT 1`,
      [recruitmentEmail]
    );
  }
  if (rows && rows.length > 0) {
    return {
      connected: true,
      email: rows[0].email,
      lastSync: rows[0].updated_at
    };
  }
  return {
    connected: false,
    email: null,
    lastSync: null
  };
}

export async function disconnectGmail() {
  const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();
  await query('DELETE FROM google_tokens WHERE LOWER(email) != ?', [recruitmentEmail]);
  await query('DELETE FROM system_settings WHERE key_name = "DIRECTOR_EMAIL"');
  await logActivity('GMAIL', 'Director Gmail disconnected/unlinked via Dashboard', 'WARN');
  return true;
}

