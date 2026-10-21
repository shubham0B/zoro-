import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query, getSetting, getRecruitmentSetting, logActivity } from '../database/db.js';
import { handleDirectorChat, draftExecutiveEmail, analyzeEmails, summarizeWhatsAppChats, getEdTechAndAiNews } from '../services/geminiService.js';
import { fetchUnreadEmails, sendVerifiedEmail, searchGmail, isRecruitmentEmailData } from '../services/gmailService.js';
import { getSchedulesByDate, parseScheduleFromText, parseScheduleIntentWithAI, addSchedule, getUpcomingSchedules } from '../services/scheduleService.js';
import { generateExecutiveBriefingPdf } from '../services/pdfService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Session State
let directorSock = null;
let botSock = null;

let directorQR = null;
let botQR = null;

let directorStatus = 'DISCONNECTED';
let botStatus = 'DISCONNECTED';

let isManualDisconnectDirector = false;
let isManualDisconnectBot = false;

let ioInstance = null;
const recentDirectorContacts = new Map(); // e.g. 'yuvraj' -> '919309313044@s.whatsapp.net'
const directorConversationHistory = []; // sliding window of recent conversation turns with Director

export function setSocketIO(io) {
  ioInstance = io;
}

function emitStatus() {
  if (ioInstance) {
    ioInstance.emit('status_update', {
      director: { status: directorStatus, qr: directorQR },
      bot: { status: botStatus, qr: botQR }
    });
  }
}

/**
 * -------------------------------------------------------------
 * 1. DIRECTOR SESSION (Silent Reader & Action Agent)
 * -------------------------------------------------------------
 */
export async function startDirectorSession() {
  const authDir = path.join(__dirname, '../../storage/auth_director');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  directorSock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Executive Listener', 'Chrome', '1.0.0'],
    syncFullHistory: true
  });

  directorSock.ev.on('creds.update', saveCreds);

  directorSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      directorQR = await QRCode.toDataURL(qr);
      directorStatus = 'SCAN_QR';
      emitStatus();
    }

    if (connection === 'open') {
      directorQR = null;
      directorStatus = 'CONNECTED';
      emitStatus();
      await logActivity('DIRECTOR_WA', 'Director WhatsApp connected successfully (Silent Mode Active)', 'INFO');
      console.log('[Director WhatsApp] Connected successfully.');
    }

    if (connection === 'close') {
      if (isManualDisconnectDirector) return;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      directorStatus = 'DISCONNECTED';
      emitStatus();
      if (shouldReconnect) {
        setTimeout(startDirectorSession, 5000);
      }
    }
  });

  // Listen to historical chat sync event from WhatsApp multi-device
  directorSock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    console.log(`[Director WhatsApp] History sync event received: ${messages?.length || 0} messages, ${chats?.length || 0} chats, ${contacts?.length || 0} contacts`);
    if (contacts && contacts.length > 0) {
      await saveWhatsAppContactsBatch(contacts);
    }
    if (messages && messages.length > 0) {
      await saveWhatsAppMessagesBatch(messages);
    }
  });

  directorSock.ev.on('contacts.upsert', async (contacts) => {
    await saveWhatsAppContactsBatch(contacts);
  });

  directorSock.ev.on('contacts.update', async (contacts) => {
    await saveWhatsAppContactsBatch(contacts);
  });

  // Listen to incoming messages SILENTLY without marking them as read!
  // Process both 'notify' (live incoming messages) and 'append' (synced history chunks)
  directorSock.ev.on('messages.upsert', async ({ messages, type }) => {
    await saveWhatsAppMessagesBatch(messages);
  });
}

function levenshteinDistance(a, b) {
  if (!a || !b) return (a || b).length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Saves or updates WhatsApp contacts into MySQL and memory cache,
 * and updates any whatsapp_chats rows with the real contact name.
 */
async function saveWhatsAppContactsBatch(contacts) {
  if (!contacts || !Array.isArray(contacts)) return;

  for (const c of contacts) {
    if (!c || !c.id) continue;
    const jid = c.id;
    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

    const name = c.name || c.verifiedName || c.notify || '';
    const notify = c.notify || '';
    const phone = jid.split('@')[0].split(':')[0];

    if (name) {
      recentDirectorContacts.set(name.toLowerCase().trim(), jid);
      const firstName = name.split(/\s+/)[0].toLowerCase().trim();
      if (firstName.length >= 3) {
        recentDirectorContacts.set(firstName, jid);
      }
    }
    if (notify) {
      recentDirectorContacts.set(notify.toLowerCase().trim(), jid);
    }

    try {
      await query(
        `INSERT INTO whatsapp_contacts (jid, phone, name, notify)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = COALESCE(NULLIF(VALUES(name), ''), name), notify = COALESCE(NULLIF(VALUES(notify), ''), notify)`,
        [jid, phone, name, notify]
      );

      // Backfill whatsapp_chats where sender_name is currently just the raw phone number
      if (name) {
        await query(
          `UPDATE whatsapp_chats SET sender_name = ? WHERE (chat_jid LIKE ? OR sender_phone = ?) AND is_from_me = FALSE AND (sender_name = sender_phone OR sender_name IS NULL OR sender_name = '')`,
          [name, `%${phone}%`, phone]
        );
      }
    } catch (err) {}
  }
}

/**
 * Batch saves incoming or synced historical WhatsApp messages into MySQL
 */
async function saveWhatsAppMessagesBatch(messages) {
  if (!messages || !Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg.message) continue;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

    const isFromMe = msg.key.fromMe || false;
    const senderName = msg.pushName || (isFromMe ? 'Director' : jid.split('@')[0]);
    const senderPhone = jid.split('@')[0];
    const timestamp = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp?.low
      ? msg.messageTimestamp.low
      : (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000));

    const text = msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    if (!text.trim()) continue;

    try {
      await query(
        `INSERT INTO whatsapp_chats (msg_id, chat_jid, sender_name, sender_phone, message_text, timestamp, is_from_me)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE message_text = VALUES(message_text)`,
        [msg.key.id, jid, senderName, senderPhone, text, timestamp, isFromMe]
      );
    } catch (err) {}
  }
}

/**
 * -------------------------------------------------------------
 * 2. EXECUTIVE BOT SESSION (Assistant Number)
 * -------------------------------------------------------------
 */
export async function startBotSession() {
  const authDir = path.join(__dirname, '../../storage/auth_bot');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  botSock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Executive Assistant Bot', 'Chrome', '1.0.0']
  });

  botSock.ev.on('creds.update', saveCreds);

  botSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botQR = await QRCode.toDataURL(qr);
      botStatus = 'SCAN_QR';
      emitStatus();
    }

    if (connection === 'open') {
      botQR = null;
      botStatus = 'CONNECTED';
      emitStatus();
      await logActivity('BOT_WA', 'Executive Bot WhatsApp connected successfully', 'INFO');
      console.log('[Bot WhatsApp] Connected successfully.');
    }

    if (connection === 'close') {
      if (isManualDisconnectBot) return;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      botStatus = 'DISCONNECTED';
      emitStatus();
      if (shouldReconnect) {
        setTimeout(startBotSession, 5000);
      }
    }
  });

  // Handle incoming messages to Bot
  botSock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;

      // Filter out group chats, status broadcasts, and channel announcements
      if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
        continue;
      }

      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   msg.message.imageMessage?.caption ||
                   msg.message.videoMessage?.caption ||
                   '';
      if (!text.trim()) continue;

      // Extract sender phone number handling both standard and multi-device WhatsApp structures
      let senderPhone = '';
      if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net')) {
        senderPhone = msg.key.remoteJidAlt.split('@')[0].split(':')[0];
      } else if (msg.key.participant && msg.key.participant.includes('@s.whatsapp.net')) {
        senderPhone = msg.key.participant.split('@')[0].split(':')[0];
      } else {
        senderPhone = jid.split('@')[0].split(':')[0];
      }

      await handleBotIncomingMessage(jid, senderPhone, text);
    }
  });
}

/**
 * Handles incoming interactions on the Executive Bot number
 */

/**
 * Direct deterministic parser for Director's command to send a WhatsApp message
 */
function parseSendWhatsappCommand(text) {
  if (!text) return null;
  const t = text.trim();

  // Pattern 1: Send text to [recipient] '[message]' or "[message]"
  let m = t.match(/^(?:send\s+(?:the\s+|a\s+)?(?:text|message|msg)\s+to|text(?:\s+to)?|message(?:\s+to)?)\s+([+0-9a-zA-Z._-]+)\s*[:\s-]?\s*['"“]([\s\S]+?)['"”]$/i);
  if (m) return { to: m[1], msg: m[2].trim() };

  // Pattern 2: Send text to [recipient]: [message]
  m = t.match(/^(?:send\s+(?:the\s+|a\s+)?(?:text|message|msg)\s+to|text(?:\s+to)?|message(?:\s+to)?)\s+([+0-9a-zA-Z._-]+)\s*[:\s-]\s*([\s\S]+)$/i);
  if (m) return { to: m[1], msg: m[2].trim() };

  // Pattern 3: [recipient] ko text kar do / message bhejo [message]
  m = t.match(/^([+0-9a-zA-Z._-]+)\s+ko\s+(?:text|message|msg)\s+(?:kar\s+do|bhejo|bhej\s+do)\s*[:\s-]?\s*['"“]?([\s\S]+?)['"”]?$/i);
  if (m) return { to: m[1], msg: m[2].trim() };

  // Pattern 4: Send text to [recipient] [unquoted message]
  m = t.match(/^(?:send\s+(?:the\s+|a\s+)?(?:text|message|msg)\s+to|text(?:\s+to)?|message(?:\s+to)?)\s+([+0-9a-zA-Z._-]+)\s+([\s\S]+)$/i);
  if (m) return { to: m[1], msg: m[2].trim().replace(/^['"“]|['"”]$/g, '') };

  // Pattern 5: Number first + explanation + send text command:
  // e.g. "9309313044 this is yuvraj number send text kaha hai kutte"
  m = t.match(/(?:\+?91|0)?([6-9]\d{9})[\s\S]*?(?:send(?:\s+a|\s+the)?\s+(?:text|message|msg)|text|message)\s*[:\s-]?\s*['"“]?([\s\S]+?)['"”]?$/i);
  if (m) return { to: m[1], msg: m[2].trim() };

  return null;
}

/**
 * Resolves a recipient identifier (phone number, name, cached alias) to a valid WhatsApp JID
 */
async function resolveRecipientJid(targetRecipient) {
  if (!targetRecipient) return null;
  const digits = targetRecipient.replace(/[^0-9]/g, '');

  if (targetRecipient.includes('@s.whatsapp.net')) {
    return targetRecipient;
  }
  if (digits.length === 10) {
    return `91${digits}@s.whatsapp.net`;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return `${digits}@s.whatsapp.net`;
  }

  // Look up in memory cache
  const cleanTarget = targetRecipient.toLowerCase().trim();
  const cached = recentDirectorContacts.get(cleanTarget);
  if (cached) return cached;

  // Search in database whatsapp_chats
  try {
    const found = await query(
      `SELECT chat_jid, sender_name FROM whatsapp_chats 
       WHERE sender_name LIKE ? OR sender_phone LIKE ? ORDER BY id DESC LIMIT 1`,
      [`%${cleanTarget}%`, `%${cleanTarget}%`]
    );
    if (found.length > 0) {
      return found[0].chat_jid;
    }
  } catch (e) {}

  // Scan recent conversation history for any phone number mentioned with this contact
  for (let i = directorConversationHistory.length - 1; i >= 0; i--) {
    const turn = directorConversationHistory[i].content || '';
    if (turn.toLowerCase().includes(cleanTarget) || cleanTarget.includes(turn.toLowerCase())) {
      const foundDigits = turn.match(/(?:\+?\d{1,3}[-\s]?)?\(?\d{3,5}\)?[-\s]?\d{3,5}[-\s]?\d{3,5}/);
      if (foundDigits) {
        const d = foundDigits[0].replace(/[^0-9]/g, '');
        if (d.length === 10) return `91${d}@s.whatsapp.net`;
        if (d.length >= 11 && d.length <= 15) return `${d}@s.whatsapp.net`;
      }
    }
  }

  // If there is any recent 10-digit number in the conversation history
  for (let i = directorConversationHistory.length - 1; i >= 0; i--) {
    const turn = directorConversationHistory[i].content || '';
    const foundDigits = turn.match(/(?:\+?\d{1,3}[-\s]?)?\(?\d{3,5}\)?[-\s]?\d{3,5}[-\s]?\d{3,5}/);
    if (foundDigits) {
      const d = foundDigits[0].replace(/[^0-9]/g, '');
      if (d.length === 10) return `91${d}@s.whatsapp.net`;
      if (d.length >= 11 && d.length <= 15) return `${d}@s.whatsapp.net`;
    }
  }

  return null;
}

async function handleBotIncomingMessage(jid, senderPhone, text) {
  try {
    const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '';
    const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE || '';
    const connectedDirectorPhone = directorSock?.user?.id ? directorSock.user.id.split('@')[0].split(':')[0] : '';

    const cleanPhone = (p) => p ? p.replace(/[^0-9]/g, '') : '';
    const cleanSender = cleanPhone(senderPhone);
    const cleanDir = cleanPhone(directorPhone) || cleanPhone(connectedDirectorPhone);
    const cleanPa = cleanPhone(paPhone);

    // Robust phone matcher: checks equality, endsWith, or last 10 digits
    const matchPhone = (sender, target) => {
      if (!sender || !target) return false;
      if (sender === target) return true;
      if (sender.length >= 10 && target.length >= 10) {
        if (sender.endsWith(target) || target.endsWith(sender)) return true;
        if (sender.slice(-10) === target.slice(-10)) return true;
      }
      return false;
    };

    const isDirector = matchPhone(cleanSender, cleanDir);
    const isPA = matchPhone(cleanSender, cleanPa);

    console.log(`[Bot WhatsApp] Inbound text from "${senderPhone}" (clean: ${cleanSender}) to bot. Match check -> isDirector: ${isDirector} (target: ${cleanDir || 'NONE'}), isPA: ${isPA} (target: ${cleanPa || 'NONE'})`);

    // --- STRICT ACCESS CONTROL / SECURITY FIREWALL ---
    // If the sender is NEITHER Director NOR PA, SILENTLY DROP THE MESSAGE!
    // Never reply with access notices, texts, or files to unauthorized persons.
    if (!isDirector && !isPA) {
      console.warn(`[Bot Security] Silently dropped text from unauthorized number: ${senderPhone}. Authorized Dir: "${cleanDir ? cleanDir.slice(-4) : 'NONE'}", PA: "${cleanPa ? cleanPa.slice(-4) : 'NONE'}"`);
      await logActivity('SECURITY', `Silently ignored inbound text from unauthorized number ${senderPhone}`, 'WARN');
      return; // SILENT DROP - DO NOT SEND ANY MESSAGE
    }

    // --- PA Commands & Natural AI Schedule Handling ---
    if (isPA && !isDirector) {
      // 1. Check legacy prefix if PA typed "!schedule"
      if (text.startsWith('!schedule')) {
        const added = await parseScheduleFromText(text);
        await botSock.sendMessage(jid, {
          text: `✅ *Schedule Updated by PA:*\nAdded ${added.length} meeting(s) to Director's calendar for today.`
        });
        return;
      }

      // 2. Intelligent AI Parsing for Natural PA messages (e.g. "Thoolle meeting tomorrow at 7 pm")
      const parsedIntent = await parseScheduleIntentWithAI(text);
      if (parsedIntent) {
        if (parsedIntent.intent === 'ADD_MEETING' && parsedIntent.meeting) {
          const m = parsedIntent.meeting;
          const id = await addSchedule({
            date: m.date || new Date().toISOString().split('T')[0],
            time_slot: m.time_slot || 'TBD',
            title: m.title || 'Scheduled Discussion',
            description: m.description || '',
            location: m.location || "Director's Office",
            priority: m.priority || 'Normal',
            created_by: 'PA via WhatsApp'
          });

          await botSock.sendMessage(jid, {
            text: `✅ *Meeting Scheduled in Director's Calendar!*\n\n📅 *Date:* ${m.date}\n⏰ *Time:* ${m.time_slot}\n📌 *Agenda:* ${m.title}\n${m.description ? `📝 *Notes:* ${m.description}\n` : ''}⚠️ *Priority:* ${m.priority || 'Normal'}\n📍 *Location:* ${m.location || "Director's Office"}\n\n_Director's itinerary has been successfully updated!_`
          });
          return;
        }

        if (parsedIntent.intent === 'VIEW_SCHEDULE') {
          const targetDate = parsedIntent.viewDate || new Date().toISOString().split('T')[0];
          const schedules = await getSchedulesByDate(targetDate);
          const list = schedules.length > 0
            ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location}) [${s.priority}]`).join('\n')
            : `No meetings scheduled for ${targetDate}.`;

          await botSock.sendMessage(jid, {
            text: `📅 *Director's Schedule (${targetDate}):*\n\n${list}\n\n_To add a meeting, simply text details naturally (e.g., "Meeting tomorrow at 7 PM with Thoolle")_`
          });
          return;
        }

        if (parsedIntent.intent === 'GENERAL_QUERY' && parsedIntent.message) {
          await botSock.sendMessage(jid, {
            text: parsedIntent.message
          });
          return;
        }
      }

      // Fallback if AI was unavailable
      const todayStr = new Date().toISOString().split('T')[0];
      const schedules = await getSchedulesByDate(todayStr);
      const list = schedules.length > 0
        ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location})`).join('\n')
        : 'No meetings scheduled for today.';
      await botSock.sendMessage(jid, {
        text: `📅 *Director's Schedule for Today (${todayStr}):*\n\n${list}\n\n_To add a meeting, text naturally (e.g. "Meeting tomorrow at 7 PM with Thoolle") or !schedule 10:30 AM - Title_`
      });
      return;
    }

    const lowerText = text.toLowerCase().trim();

    // --- Briefing & PDF Report on Demand Command ---
    const isBriefingRequest = 
      lowerText === '!briefing' ||
      /\b(briefing|report|pdf)\b/i.test(lowerText) && /\b(give|send|share|show|bhejo|lao|do|here|get|generate|provide|want|need|de|dikha)\b/i.test(lowerText) ||
      lowerText === 'give me pdf' ||
      lowerText === 'give ne the report' ||
      lowerText === 'give me the report' ||
      lowerText === 'give me report' ||
      lowerText === 'give me here' ||
      lowerText === 'give here' ||
      lowerText === 'send here' ||
      lowerText === 'send me pdf' ||
      lowerText === 'send me report' ||
      lowerText === 'send pdf' ||
      lowerText === 'pdf bhejo' ||
      lowerText === 'report bhejo' ||
      lowerText === 'today report' ||
      lowerText === 'report' ||
      lowerText === 'pdf' ||
      ((lowerText.includes('here') || lowerText.includes('yahi') || lowerText.includes('idhar')) && directorConversationHistory.some(h => (h.content || '').toLowerCase().includes('pdf') || (h.content || '').toLowerCase().includes('briefing')));

    if (isBriefingRequest) {
      await botSock.sendMessage(jid, { 
        text: `⏳ *Generating your real-time Executive Daily Briefing PDF...*\nCompiling the latest schedules, email correspondence, and WhatsApp intelligence right now. Dispatching the PDF document here shortly...` 
      });
      const result = await triggerDailyBriefing(jid);
      if (result && !result.success) {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Briefing generation encountered an issue:* ${result.error || 'Unknown error'}`
        });
      }
      return;
    }

    // --- Check if Director is confirming a pending email draft ---
    const normalizedText = text.trim().toUpperCase();
    if (normalizedText === 'CONFIRM' || normalizedText === 'YES' || normalizedText === 'SEND') {
      const pendingDrafts = await query(
        `SELECT * FROM email_drafts WHERE status = 'PENDING_VERIFICATION' ORDER BY id DESC LIMIT 1`
      );

      if (pendingDrafts.length > 0) {
        const draft = pendingDrafts[0];
        try {
          await sendVerifiedEmail({
            to: draft.recipient_email,
            subject: draft.subject,
            body: draft.body,
            draftId: draft.id
          });
          await botSock.sendMessage(jid, {
            text: `🚀 *Email Sent Successfully!*\n\n*To:* ${draft.recipient_email}\n*Subject:* ${draft.subject}\n*Status:* Dispatched via Official Gmail.`
          });
          return;
        } catch (err) {
          await botSock.sendMessage(jid, {
            text: `❌ *Failed to send email:* ${err.message}`
          });
          return;
        }
      }
    }

    if (normalizedText === 'CANCEL' || normalizedText === 'DISCARD') {
      await query(`UPDATE email_drafts SET status = 'CANCELLED' WHERE status = 'PENDING_VERIFICATION'`);
      await botSock.sendMessage(jid, {
        text: `🛑 *Pending email draft has been cancelled.*`
      });
      return;
    }

    // --- Natural AI Conversation with Context ---

    // Check if Director just sent a phone number in response to a previous contact query
    const standalonePhoneMatch = text.trim().match(/^(?:\+?91|0)?([6-9]\d{9})$/);
    if (standalonePhoneMatch) {
      const phoneDigits = standalonePhoneMatch[1];
      const formattedJid = `91${phoneDigits}@s.whatsapp.net`;

      // Find the contact name or pending message from recent conversation history
      let contactName = null;
      let pendingMessage = null;

      for (let i = directorConversationHistory.length - 1; i >= 0; i--) {
        const turn = directorConversationHistory[i];
        if (turn.role === 'assistant' && turn.content.includes('Could not find WhatsApp contact for')) {
          const m = turn.content.match(/Could not find WhatsApp contact for\s*["“']([^"”']+)["”']/i);
          if (m) contactName = m[1].toLowerCase().trim();
        }
        if (turn.role === 'user') {
          const prevDirectCmd = parseSendWhatsappCommand(turn.content);
          if (prevDirectCmd && prevDirectCmd.msg) {
            pendingMessage = prevDirectCmd.msg;
            if (!contactName) contactName = prevDirectCmd.to.toLowerCase().trim();
            break;
          }
        }
      }

      if (contactName) {
        recentDirectorContacts.set(contactName, formattedJid);
        console.log(`[Contact Cache] Linked contact "${contactName}" -> ${formattedJid}`);
      }

      if (pendingMessage && directorSock) {
        try {
          await directorSock.sendMessage(formattedJid, { text: pendingMessage });
          await botSock.sendMessage(jid, {
            text: `✅ ${contactName ? `*Contact "${contactName}" linked to ${phoneDigits}!*\n\n` : ''}*Message sent to ${phoneDigits} from your Director WhatsApp account:*\n"${pendingMessage}"`
          });
          directorConversationHistory.push({ role: 'user', content: text });
          directorConversationHistory.push({ role: 'assistant', content: `Message sent to ${phoneDigits}: "${pendingMessage}"` });
          return;
        } catch (sendErr) {
          console.error('[Director WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Error sending message to ${phoneDigits}: ${sendErr.message}`
          });
          return;
        }
      } else {
        await botSock.sendMessage(jid, {
          text: `✅ *Noted!* ${contactName ? `Contact "${contactName}"` : 'Phone number'} saved as *${phoneDigits}*.\n\nWhat message would you like me to send them from your Director WhatsApp?`
        });
        directorConversationHistory.push({ role: 'user', content: text });
        directorConversationHistory.push({ role: 'assistant', content: `Saved phone number ${phoneDigits} for ${contactName || 'contact'}.` });
        return;
      }
    }

    // 1. Gather Context (Both today and upcoming schedules)
    const todayStr = new Date().toISOString().split('T')[0];
    const schedules = await getUpcomingSchedules();

    // Extract any phone numbers mentioned in Director's message to cache
    const phoneExtractRegex = /(?:\+?\d{1,3}[-\s]?)?\(?\d{3,5}\)?[-\s]?\d{3,5}[-\s]?\d{3,5}/g;
    const extractedPhones = text.match(phoneExtractRegex);
    if (extractedPhones) {
      for (const rawP of extractedPhones) {
        const pDigits = rawP.replace(/[^0-9]/g, '');
        if (pDigits.length >= 10) {
          const formattedJid = pDigits.length === 10 ? `91${pDigits}@s.whatsapp.net` : `${pDigits}@s.whatsapp.net`;
          // Look for preceding or following words as name
          const words = text.replace(rawP, ' ').split(/\s+/).filter(w => w.length > 2);
          for (const w of words) {
            const cleanW = w.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (cleanW && !['this', 'is', 'the', 'number', 'of', 'text', 'send', 'call', 'kaha', 'hai'].includes(cleanW)) {
              recentDirectorContacts.set(cleanW, formattedJid);
              console.log(`[Contact Cache] Linked contact "${cleanW}" -> ${formattedJid}`);
            }
          }
        }
      }
    }

    // Direct command check (e.g. "Send text to yuvraj kaha hai kutte", "9309313044 this is yuvraj number send text kaha hai kutte")
    const directCmd = parseSendWhatsappCommand(text);
    if (directCmd) {
      const targetRecipient = directCmd.to;
      const messageToSend = directCmd.msg;

      const targetJid = await resolveRecipientJid(targetRecipient);
      if (targetJid && directorSock) {
        try {
          await directorSock.sendMessage(targetJid, { text: messageToSend });
          const displayTarget = targetRecipient.includes('@') ? targetRecipient.split('@')[0] : targetRecipient;
          await botSock.sendMessage(jid, {
            text: `✅ *Message sent to ${displayTarget} from your Director WhatsApp account:*\n"${messageToSend}"`
          });
          directorConversationHistory.push({ role: 'user', content: text });
          directorConversationHistory.push({ role: 'assistant', content: `Message sent to ${displayTarget}: "${messageToSend}"` });
          return;
        } catch (sendErr) {
          console.error('[Director WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Failed to deliver message from Director WhatsApp to ${targetRecipient}: ${sendErr.message}`
          });
          return;
        }
      } else if (!directorSock) {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Director WhatsApp account is currently disconnected.* Please scan/connect Director WhatsApp in the dashboard before sending messages.`
        });
        return;
      } else {
        const errorMsg = `⚠️ Could not find WhatsApp contact for "${targetRecipient}". Please provide their exact 10-digit mobile number.`;
        await botSock.sendMessage(jid, { text: errorMsg });
        directorConversationHistory.push({ role: 'user', content: text });
        directorConversationHistory.push({ role: 'assistant', content: errorMsg });
        return;
      }
    }

    const recentChats = await query(
      `SELECT sender_name, sender_phone, message_text, timestamp FROM whatsapp_chats 
       WHERE is_from_me = FALSE ORDER BY id DESC LIMIT 25`
    );

    // Search historical WhatsApp messages if Director asks about chats, texts, or a specific person
    let matchedWhatsAppMessages = [];
    const isWaQuery = lowerText.includes('whatsapp') || lowerText.includes('chat') || lowerText.includes('text') || lowerText.includes('message') || lowerText.includes('kaha') || lowerText.includes('bheja') || lowerText.includes('said') || lowerText.includes('bol');
    if (isWaQuery) {
      // 1. Extract any numeric limit (e.g. "last 20 chat", "5 messages")
      let queryLimit = 30;
      const numMatch = text.match(/\b(\d{1,2})\b/);
      if (numMatch) {
        queryLimit = Math.max(1, Math.min(50, parseInt(numMatch[1], 10)));
      }

      // 2. Tokenize into clean words, stripping punctuation, dots, numbers, and common stop words
      const stopWordsList = new Set([
        'give', 'me', 'tell', 'show', 'find', 'search', 'check', 'look', 'what', 'when', 'where', 'how', 'who',
        'chat', 'chats', 'text', 'texts', 'message', 'messages', 'msg', 'msgs', 'history', 'conversation',
        'summary', 'summarize', 'detail', 'details', 'recent', 'recently', 'today', 'yesterday', 'tomorrow',
        'last', 'latest', 'past', 'old', 'new', 'regarding', 'about', 'related', 'with', 'from', 'have',
        'sent', 'send', 'bheja', 'bhejo', 'aaya', 'kya', 'hai', 'tha', 'thi', 'the', 'bhi', 'aur', 'wale',
        'wali', 'wala', 'mein', 'please', 'plz', 'sir', 'assistant', 'whatsapp', 'inbox', 'mail', 'email',
        'emails', 'here', 'there', 'this', 'that', 'them', 'they', 'their', 'said', 'says', 'bol', 'bola',
        'ka', 'ki', 'ke', 'ko', 'se', 'do', 'de', 'dikha', 'dikhao', 'sunao', 'batao'
      ]);

      const normalizedTokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 2 && !stopWordsList.has(w) && !/^\d+$/.test(w));

      const cleanKeyword = normalizedTokens.join(' ').trim();
      const searchTerms = [cleanKeyword, ...normalizedTokens].filter(Boolean);
      
      let resolvedTargetJid = null;
      let targetPhone = null;

      // Check A: recentDirectorContacts memory map (exact & fuzzy)
      for (const w of searchTerms) {
        if (recentDirectorContacts.has(w)) {
          resolvedTargetJid = recentDirectorContacts.get(w);
          break;
        }
        for (const [cName, cJid] of recentDirectorContacts.entries()) {
          if (cName.includes(w) || w.includes(cName) || levenshteinDistance(w, cName) <= 2) {
            resolvedTargetJid = cJid;
            break;
          }
        }
        if (resolvedTargetJid) break;
      }

      // Check B: whatsapp_contacts table
      if (!resolvedTargetJid) {
        for (const w of searchTerms) {
          try {
            const contactRows = await query(
              `SELECT jid, phone, name FROM whatsapp_contacts WHERE name LIKE ? OR notify LIKE ? LIMIT 1`,
              [`%${w}%`, `%${w}%`]
            );
            if (contactRows.length > 0) {
              resolvedTargetJid = contactRows[0].jid;
              targetPhone = contactRows[0].phone;
              break;
            }
          } catch (e) {}
        }
      }

      // Check C: existing sender_name in whatsapp_chats table (e.g. someone texted as "Yuvraj Sharma")
      if (!resolvedTargetJid && !targetPhone) {
        for (const w of searchTerms) {
          try {
            const chatContactRows = await query(
              `SELECT sender_name, sender_phone, chat_jid FROM whatsapp_chats 
               WHERE sender_name LIKE ? AND sender_name != 'Director' 
               ORDER BY id DESC LIMIT 1`,
              [`%${w}%`]
            );
            if (chatContactRows.length > 0) {
              targetPhone = chatContactRows[0].sender_phone || chatContactRows[0].chat_jid.split('@')[0].split(':')[0];
              resolvedTargetJid = chatContactRows[0].chat_jid;
              break;
            }
          } catch (e) {}
        }
      }

      if (resolvedTargetJid && !targetPhone) {
        targetPhone = resolvedTargetJid.split('@')[0].split(':')[0];
      }

      try {
        if (targetPhone) {
          const p10 = targetPhone.slice(-10);
          matchedWhatsAppMessages = await query(
            `SELECT sender_name, sender_phone, message_text, timestamp, is_from_me 
             FROM whatsapp_chats 
             WHERE chat_jid LIKE ? OR sender_phone LIKE ? OR chat_jid LIKE ? OR sender_phone LIKE ? OR sender_name LIKE ? OR message_text LIKE ?
             ORDER BY timestamp DESC, id DESC LIMIT ?`,
            [`%${targetPhone}%`, `%${targetPhone}%`, `%${p10}%`, `%${p10}%`, `%${cleanKeyword}%`, `%${cleanKeyword}%`, queryLimit]
          );
        } else if (cleanKeyword.length > 1) {
          matchedWhatsAppMessages = await query(
            `SELECT sender_name, sender_phone, message_text, timestamp, is_from_me 
             FROM whatsapp_chats 
             WHERE sender_name LIKE ? OR message_text LIKE ?
             ORDER BY timestamp DESC, id DESC LIMIT ?`,
            [`%${cleanKeyword}%`, `%${cleanKeyword}%`, queryLimit]
          );
        }

        // Reverse so Gemini receives them in chronological order
        if (matchedWhatsAppMessages.length > 0) {
          matchedWhatsAppMessages.reverse();
          console.log(`[Director Query] Retrieved ${matchedWhatsAppMessages.length} matched WhatsApp messages for "${cleanKeyword}" (targetPhone: ${targetPhone || 'NONE'})`);
        }
      } catch (e) {
        console.error('[WhatsApp Query Search Error]:', e);
      }
    }

    const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();

    // Query genuine director emails, strictly excluding recruitment & candidate records
    const recentEmails = await query(
      `SELECT sender_name, subject, summary, priority, action_required 
       FROM email_summaries 
       WHERE sender_email NOT LIKE '%careers%' 
         AND sender_email NOT LIKE '%recruitment%' 
         AND sender_email NOT LIKE '%jecrchospital%' 
         AND subject NOT LIKE '%application%' 
         AND subject NOT LIKE '%resume%' 
         AND summary NOT LIKE '%candidate%' 
         AND LOWER(sender_email) != ?
       ORDER BY id DESC LIMIT 10`,
      [recruitmentEmail]
    );

    const pendingDrafts = await query(
      `SELECT * FROM email_drafts WHERE status = 'PENDING_VERIFICATION' LIMIT 1`
    );

    // Live search Gmail if user query inquires about emails, people, or entities
    let matchedEmails = [];
    const isEmailSearch = lowerText.includes('email') || 
                          lowerText.includes('mail') || 
                          lowerText.includes('find') || 
                          lowerText.includes('search') || 
                          lowerText.includes('check') || 
                          lowerText.includes('iit') || 
                          lowerText.includes('techfest') || 
                          lowerText.includes('bombay') || 
                          lowerText.includes('dheemant') || 
                          lowerText.includes('workshop') ||
                          lowerText.includes('@') ||
                          lowerText.includes('.com') ||
                          lowerText.includes('.edu');

    if (isEmailSearch) {
      // Check if user is asking for today's email report, daily report, or recent emails
      const isEmailReport = 
        (lowerText.includes('report') && (lowerText.includes('email') || lowerText.includes('mail') || lowerText.includes('gmail'))) ||
        lowerText.includes('today report') ||
        lowerText.includes('daily report') ||
        lowerText.includes('inbox report') ||
        lowerText.includes('email summary') ||
        lowerText.includes('gmail summary');

      const isGeneralRecent = 
        isEmailReport ||
        lowerText.includes('latest email') || 
        lowerText.includes('recent email') || 
        lowerText.includes('new email') || 
        lowerText.includes('check email') || 
        lowerText.includes('my email') ||
        lowerText.includes('last email') ||
        lowerText.includes('unread email') ||
        lowerText.includes('give me email') ||
        lowerText.includes('today email') ||
        lowerText.includes('email today') ||
        lowerText.includes('gmail today') ||
        lowerText.includes('today gmail') ||
        lowerText.includes('gmail report') ||
        lowerText.includes('email report') ||
        lowerText.includes('aaya email');

      if (isGeneralRecent) {
        console.log(`[Director Query] Fetching latest official inbox emails directly (recruitment excluded)...`);
        try {
          const liveRecent = await fetchUnreadEmails(8, false);
          if (liveRecent && liveRecent.length > 0) {
            const cleanRecent = liveRecent.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
            matchedEmails.push(...cleanRecent);
          }
        } catch (e) {}
      } else {
        // 1. Check if user typed an explicit email address (e.g. Amitdheemant@jecrcu.edu.in)
        const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
        const emailMatch = text.match(emailRegex);

        let queryTerm = '';
        if (emailMatch) {
          const addr = emailMatch[1].toLowerCase();
          queryTerm = `from:${addr} OR to:${addr} OR "${addr}"`;
        } else {
          // 2. Check if user is asking for emails from a specific person
          const fromMatch = lowerText.match(/(?:from|sent by|bheja|send)\s+([a-zA-Z0-9_-]+)/i);
          if (fromMatch && fromMatch[1] && fromMatch[1].length > 2) {
            const person = fromMatch[1].trim();
            queryTerm = `from:${person} OR "${person}"`;
          } else {
            // 3. Clean keywords (remove stop/filler words while preserving dots and hyphens, and stripping report/summary/status words so they don't corrupt the Gmail search)
            const stopWords = /\b(find|search|check|look for|show me|give me|get me|the|email|mail|emails|mails|inbox|gmail|latest|recent|recently|today|yesterday|last|new|old|regarding|about|related to|of|from|to|for|with|bheja|aaya|kya|hai|tha|thi|the|se|ko|ka|ki|ke|kuch|koi|bhi|wala|wali|wale|me|mein|please|plz|sir|assistant|is|are|any|report|reports|summary|briefing|status)\b/gi;
            const cleanKeyword = text
              .replace(stopWords, ' ')
              .replace(/[?!,;'"()[\]{}<>*#~]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            queryTerm = cleanKeyword.length > 1 ? cleanKeyword : '';
          }
        }

        if (queryTerm) {
          console.log(`[Director Query] Searching live Gmail inbox for: "${queryTerm}"...`);
          try {
            const liveFound = await searchGmail(queryTerm, 15);
            if (liveFound && liveFound.length > 0) {
              const cleanFound = liveFound.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
              matchedEmails.push(...cleanFound);
              for (const em of cleanFound) {
                try {
                  await query(
                    `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
                     VALUES (?, ?, ?, ?, ?, ?, 'Normal', ?, 'Informational')
                     ON DUPLICATE KEY UPDATE summary = VALUES(summary)`,
                    [em.id, em.senderEmail, em.senderName, em.subject, em.snippet, em.date || '', em.snippet]
                  );
                } catch(e) {}
              }
            }
          } catch (searchErr) {
            console.warn('[Director Query] Gmail search failed:', searchErr.message);
          }
        } else {
          // If query term reduced to empty, fallback to fetching recent official emails
          try {
            const liveRecent = await fetchUnreadEmails(8, false);
            if (liveRecent && liveRecent.length > 0) {
              const cleanRecent = liveRecent.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
              matchedEmails.push(...cleanRecent);
            }
          } catch (e) {}
        }
      }
    }

    const aiReply = await handleDirectorChat(text, {
      schedules,
      whatsappMessages: matchedWhatsAppMessages.length > 0 ? matchedWhatsAppMessages : recentChats,
      matchedWhatsAppMessages,
      recentEmails,
      matchedEmails,
      pendingDrafts,
      conversationHistory: directorConversationHistory.slice(-6)
    });

    // Append to directorConversationHistory
    directorConversationHistory.push({ role: 'user', content: text });
    directorConversationHistory.push({ role: 'assistant', content: aiReply });
    if (directorConversationHistory.length > 12) directorConversationHistory.splice(0, 2);

    // Check if AI generated an action block
    // Format: [ACTION:WHATSAPP_REPLY | TO:recipient | MESSAGE:text]
    const replyMatch = aiReply.match(/\[ACTION:WHATSAPP_REPLY\s*\|\s*TO:([^|]+)\|\s*MESSAGE:([^\]]+)\]/i);
    if (replyMatch) {
      const targetRecipient = replyMatch[1].trim();
      const messageToSend = replyMatch[2].trim();

      // Resolve recipient JID: Direct Phone Number > Cache > Database > Conversation History
      const targetJid = await resolveRecipientJid(targetRecipient);

      if (targetJid && directorSock) {
        try {
          await directorSock.sendMessage(targetJid, { text: messageToSend });
          const cleanReply = aiReply.replace(replyMatch[0], '').trim();
          const displayTarget = targetRecipient.includes('@') ? targetRecipient.split('@')[0] : targetRecipient;
          await botSock.sendMessage(jid, {
            text: `${cleanReply ? `${cleanReply}\n\n` : ''}✅ *Message sent to ${displayTarget} from your Director WhatsApp account:*\n"${messageToSend}"`
          });
          return;
        } catch (sendErr) {
          console.error('[Director WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Failed to deliver message from Director WhatsApp to ${targetRecipient}: ${sendErr.message}`
          });
          return;
        }
      } else if (!directorSock) {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Director WhatsApp account is currently disconnected.* Please scan/connect Director WhatsApp in the dashboard before sending messages.`
        });
        return;
      } else {
        await botSock.sendMessage(jid, {
          text: `⚠️ Could not find WhatsApp contact for "${targetRecipient}". Please provide their exact 10-digit mobile number.`
        });
        return;
      }
    }

    // Format: [ACTION:DRAFT_EMAIL | TO:recipient | SUBJECT:subject | BODY:body]
    const emailDraftMatch = aiReply.match(/\[ACTION:DRAFT_EMAIL\s*\|\s*TO:([^|]+)\|\s*SUBJECT:([^|]+)\|\s*BODY:([\s\S]*?)\]/i) ||
      aiReply.match(/\[ACTION:DRAFT_EMAIL\s*\|\s*TO:([^|]+)\|\s*SUBJECT:([^|]+)\|\s*BODY:([^\]]+)\]/i);

    if (emailDraftMatch) {
      const to = emailDraftMatch[1].trim();
      const subject = emailDraftMatch[2].trim();
      let rawBody = emailDraftMatch[3].trim();

      // Clean up any literal escaped \n, \r\n, \t or stray backslashes
      const cleanBody = rawBody
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, '  ')
        .trim();

      // Save draft in MySQL with clean real newlines
      await query(
        `INSERT INTO email_drafts (recipient_email, recipient_name, subject, body, status)
         VALUES (?, ?, ?, ?, 'PENDING_VERIFICATION')`,
        [to, to, subject, cleanBody]
      );

      let cleanReply = aiReply.replace(emailDraftMatch[0], '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();

      // If cleanReply already provided the full draft preview, don't duplicate the card
      let reviewMessage = '';
      if (cleanReply && cleanReply.toLowerCase().includes('*body:*')) {
        reviewMessage = cleanReply;
        if (!reviewMessage.toUpperCase().includes('CONFIRM')) {
          reviewMessage += `\n\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*`;
        }
      } else {
        const intro = cleanReply || 'Sir, I have drafted the email for your review:';
        reviewMessage = `${intro}\n\n━━━━━━━━━━━━━━━━━━━━\n📝 *DRAFT EMAIL READY FOR REVIEW:*\n*To:* ${to}\n*Subject:* ${subject}\n\n*Body:*\n${cleanBody}\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*`;
      }

      await botSock.sendMessage(jid, { text: reviewMessage });
      return;
    }

    // Check if AI requested Briefing PDF delivery
    if (aiReply.includes('[ACTION:SEND_BRIEFING_PDF]')) {
      const cleanReply = aiReply.replace(/\[ACTION:SEND_BRIEFING_PDF\]/gi, '').trim();
      if (cleanReply) {
        await botSock.sendMessage(jid, { text: cleanReply });
      } else {
        await botSock.sendMessage(jid, { 
          text: `⏳ *Generating your real-time Executive Briefing PDF Report...*\nCompiling latest intelligence and dispatching the PDF document here shortly.` 
        });
      }
      await triggerDailyBriefing(jid);
      return;
    }

    // Regular AI response
    await botSock.sendMessage(jid, { text: aiReply });
  } catch (err) {
    console.error('[Bot Error]:', err);
    await logActivity('BOT_ERROR', `Error processing query from ${senderPhone}: ${err.message}`, 'ERROR');
    try {
      await botSock.sendMessage(jid, {
        text: `⚠️ *Executive Assistant Alert*\n\nI encountered an error processing your query: ${err.message}`
      });
    } catch (e) {}
  }
}

/**
 * Triggers the Executive Daily Briefing (PDF + Highlights)
 */
export async function triggerDailyBriefing(targetJid = null) {
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);

  const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '';
  let cleanDir = directorPhone.replace(/[^0-9]/g, '');
  if (cleanDir.length === 10) {
    cleanDir = '91' + cleanDir;
  }

  // SECURITY: Deliver to verified Director phone or requested target
  let recipientJid = targetJid;
  if (!recipientJid && cleanDir && cleanDir.length >= 10) {
    recipientJid = `${cleanDir}@s.whatsapp.net`;
  }
  if (!recipientJid && directorSock?.user?.id) {
    const rawId = directorSock.user.id.split('@')[0].split(':')[0];
    if (rawId.length >= 10) {
      recipientJid = `${rawId.length === 10 ? '91' + rawId : rawId}@s.whatsapp.net`;
    }
  }

  try {
    // 1. Fetch Today's Schedules
    const schedules = await getSchedulesByDate(todayStr);

    // 2. Fetch & Analyze Unread Emails (Strictly Director only, excluding recruitment)
    const recruitmentEmail = ((await getRecruitmentSetting('RECRUITMENT_EMAIL')) || 'careers.jecrchospital@jecrcu.edu.in').toLowerCase();
    let analyzedEmails = [];
    try {
      const rawEmails = await fetchUnreadEmails(12);
      if (rawEmails && rawEmails.length > 0) {
        const cleanRaw = rawEmails.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
        if (cleanRaw.length > 0) {
          analyzedEmails = await analyzeEmails(cleanRaw);
          for (const em of analyzedEmails) {
            if (isRecruitmentEmailData(em, recruitmentEmail)) continue;
            try {
              await query(
                `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE priority = VALUES(priority), summary = VALUES(summary), action_required = VALUES(action_required)`,
                [em.id, em.senderEmail || '', em.senderName || '', em.subject || '', em.snippet || '', em.date || '', em.priority, em.summary, em.action_required]
              );
            } catch (err) {}
          }
        }
      }
    } catch (e) {
      console.warn('[Briefing] Live email fetch error:', e.message);
    }

    // Always query stored emails from database (prioritizing Urgent, strictly excluding recruitment & self emails)
    let storedEmails = [];
    try {
      storedEmails = await query(
        `SELECT id, gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required 
         FROM email_summaries 
         WHERE sender_email NOT LIKE '%amit.dheemant%' 
           AND sender_email NOT LIKE '%careers%' 
           AND sender_email NOT LIKE '%recruitment%' 
           AND sender_email NOT LIKE '%jecrchospital%' 
           AND subject NOT LIKE '%application%' 
           AND subject NOT LIKE '%resume%' 
           AND summary NOT LIKE '%candidate%' 
           AND LOWER(sender_email) != ?
         ORDER BY 
           CASE WHEN priority = 'Urgent' THEN 1 WHEN priority = 'High' THEN 2 ELSE 3 END, 
           id DESC 
         LIMIT 10`,
        [recruitmentEmail]
      );
    } catch (e) {
      storedEmails = [];
    }
    const emailsForBriefing = (storedEmails && storedEmails.length > 0) ? storedEmails : analyzedEmails;

    // 3. Retrieve recent incoming WhatsApp chats, prioritizing urgent messages
    const recentChats = await query(
      `SELECT sender_name, sender_phone, message_text, ai_summary, ai_urgency, timestamp 
       FROM whatsapp_chats 
       WHERE is_from_me = FALSE 
       ORDER BY 
         CASE WHEN ai_urgency = 'Urgent' THEN 1 WHEN ai_urgency = 'High' THEN 2 ELSE 3 END, 
         id DESC 
       LIMIT 20`
    );

    // 4. Curate EdTech & AI News
    const edTechNews = await getEdTechAndAiNews();

    // 5. Generate PDF
    const orgName = (await getSetting('ORGANIZATION_NAME')) || process.env.ORGANIZATION_NAME || 'JECRC University';
    const directorTitle = (await getSetting('DIRECTOR_TITLE')) || process.env.DIRECTOR_TITLE || 'Office of the Director';

    const pdfPath = await generateExecutiveBriefingPdf({
      dateStr: todayStr,
      organizationName: orgName,
      directorTitle,
      schedules,
      emails: emailsForBriefing,
      chats: recentChats,
      edTechNews
    });

    // 6. Send PDF document & Text Summary via Bot WhatsApp or Director WhatsApp fallback
    let dispatched = false;
    const activeSock = botSock || directorSock;
    if (activeSock && recipientJid) {
      const urgentCount = emailsForBriefing.filter(e => e.priority === 'Urgent').length;
      const textDigest = `🏛️ *OFFICIAL EXECUTIVE DAILY BRIEFING*\n📅 *Date:* ${todayStr}\n\n` +
        `📋 *Meetings Today:* ${schedules.length} scheduled\n` +
        `🚨 *Urgent Inbound Emails:* ${urgentCount} requiring attention\n` +
        `💬 *WhatsApp Alerts:* ${recentChats.length} messages monitored\n` +
        `🎓 *Top EdTech News:* ${edTechNews[0]?.title || 'AI Integration in Higher Ed'}\n\n` +
        `📎 *Attached:* High-Resolution Executive PDF Report below.`;

      await activeSock.sendMessage(recipientJid, { text: textDigest });

      // Send PDF file
      const pdfBuffer = fs.readFileSync(pdfPath);
      await activeSock.sendMessage(recipientJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Executive_Briefing_${todayStr}.pdf`,
        caption: `Executive Daily Intelligence Briefing - ${todayStr}`
      });

      dispatched = true;
      await logActivity('BRIEFING', `Daily briefing PDF dispatched to Director (${recipientJid}) via ${botSock ? 'Bot' : 'Director'} WhatsApp`, 'INFO');
    } else {
      console.log(`[Briefing] PDF generated at ${pdfPath}. WhatsApp dispatch skipped (recipientJid: ${recipientJid}, botSock: ${!!botSock}, directorSock: ${!!directorSock}).`);
    }

    return { success: true, pdfPath, dispatched };
  } catch (error) {
    console.error('[Briefing Error]:', error);
    await logActivity('BRIEFING', `Briefing generation failed: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
}

export function getWhatsAppStatus() {
  return {
    director: { status: directorStatus, qr: directorQR },
    bot: { status: botStatus, qr: botQR }
  };
}

export async function sendTestPing(targetPhone) {
  if (!botSock) throw new Error('Executive Bot WhatsApp is not connected yet. Please scan QR.');
  const clean = targetPhone.replace(/[^0-9]/g, '');
  const jid = `${clean}@s.whatsapp.net`;
  await botSock.sendMessage(jid, {
    text: `🧪 *EXECUTIVE ASSISTANT DIAGNOSTIC PING*\n\n✅ Test message from Executive AI Command Hub.\n🕒 Time: ${new Date().toLocaleTimeString()}\n📡 Status: WhatsApp & Baileys Pipeline Operational.`
  });
  return true;
}

export async function disconnectDirectorSession() {
  isManualDisconnectDirector = true;
  try {
    if (directorSock) {
      try { await directorSock.logout(); } catch (e) {}
      try { directorSock.end(new Error('Manual Disconnect')); } catch (e) {}
      directorSock = null;
    }
  } catch (err) {
    console.warn('[Director WA] Disconnect error:', err.message);
  }

  directorStatus = 'DISCONNECTED';
  directorQR = null;
  emitStatus();

  // Purge auth storage folder
  const authDir = path.join(__dirname, '../../storage/auth_director');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  await logActivity('DIRECTOR_WA', 'Director WhatsApp session disconnected and credentials cleared', 'INFO');

  // Re-initialize fresh session after brief delay to generate a new QR
  setTimeout(() => {
    isManualDisconnectDirector = false;
    startDirectorSession().catch(e => console.error('[Director WA] Re-init error:', e));
  }, 1200);

  return { success: true, message: 'Director WhatsApp session disconnected.' };
}

export async function disconnectBotSession() {
  isManualDisconnectBot = true;
  try {
    if (botSock) {
      try { await botSock.logout(); } catch (e) {}
      try { botSock.end(new Error('Manual Disconnect')); } catch (e) {}
      botSock = null;
    }
  } catch (err) {
    console.warn('[Bot WA] Disconnect error:', err.message);
  }

  botStatus = 'DISCONNECTED';
  botQR = null;
  emitStatus();

  // Purge auth storage folder
  const authDir = path.join(__dirname, '../../storage/auth_bot');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  await logActivity('BOT_WA', 'Bot WhatsApp session disconnected and credentials cleared', 'INFO');

  // Re-initialize fresh session after brief delay to generate a new QR
  setTimeout(() => {
    isManualDisconnectBot = false;
    startBotSession().catch(e => console.error('[Bot WA] Re-init error:', e));
  }, 1200);

  return { success: true, message: 'Bot WhatsApp session disconnected.' };
}

