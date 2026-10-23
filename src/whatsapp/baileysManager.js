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
import { 
  query, getSetting, getRecruitmentSetting, logActivity,
  addScheduledMessage, getPendingScheduledMessages, markScheduledMessageSent, 
  markScheduledMessageFailed, listScheduledMessages, cancelScheduledMessage 
} from '../database/db.js';
import { handleDirectorChat, draftExecutiveEmail, analyzeEmails, summarizeWhatsAppChats, getEdTechAndAiNews } from '../services/geminiService.js';
import { fetchUnreadEmails, sendVerifiedEmail, searchGmail, isRecruitmentEmailData } from '../services/gmailService.js';
import { getSchedulesByDate, parseScheduleFromText, parseScheduleIntentWithAI, addSchedule, getUpcomingSchedules } from '../services/scheduleService.js';
import { generateExecutiveBriefingPdf } from '../services/pdfService.js';
import { 
  getLocalDateStr, getLocalTimeStr, getLocalDayOfWeek, getTomorrowDateStr, 
  getFullLocalDateTimeStr, getDayTimestampRange, formatMessageTimestamp,
  getCurrentISTDateTimeStr, parseTargetScheduledDateTime 
} from '../utils/dateUtils.js';

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

  // Handle incoming messages to Bot concurrently without blocking
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

      // Execute asynchronously so subsequent messages and simultaneous queries are never blocked!
      handleBotIncomingMessage(jid, senderPhone, text).catch(err => {
        console.error('[Bot Concurrency Error]:', err);
      });
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

/**
 * Direct deterministic parser for scheduling WhatsApp messages, listing, or cancelling
 */
function parseScheduleWhatsappCommand(text) {
  if (!text) return null;
  const t = text.trim();

  // Cancel check: e.g. "cancel scheduled message 1", "cancel message #2", "delete scheduled msg 3"
  const cancelMatch = t.match(/^(?:cancel|delete|remove)\s+(?:scheduled\s+)?(?:message|msg|text)\s*#?(\d+)/i);
  if (cancelMatch) {
    return { type: 'CANCEL', id: parseInt(cancelMatch[1], 10) };
  }

  // List check: e.g. "list scheduled messages", "show scheduled messages", "what messages are scheduled"
  if (/^(?:list|show|view|check|get)\s+(?:all\s+)?(?:scheduled|pending)\s+(?:messages|texts|msgs)/i.test(t) ||
      /^(?:what|which)\s+messages\s+are\s+scheduled/i.test(t) ||
      /^(?:scheduled\s+messages|scheduled\s+texts|scheduled\s+msgs)$/i.test(t)) {
    return { type: 'LIST' };
  }

  // Pattern 1: schedule message to [recipient] [time] [:|-|saying] [message]
  let m1 = t.match(/^(?:please\s+)?schedule\s+(?:a\s+)?(?:text|message|msg)\s+to\s+([+0-9a-zA-Z._-]+)\s+((?:today\s+at\s+|tomorrow\s+at\s+|at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|in\s+\d+\s*(?:mins?|minutes?|hours?|hrs?|seconds?|secs?|m|h|s))\s*[:\s-]?\s*(?:saying|that)?\s*['"“]?([\s\S]+?)['"”]?$/i);
  if (m1) {
    return { type: 'SCHEDULE', to: m1[1], timeStr: m1[2].trim(), msg: m1[3].trim() };
  }

  // Pattern 2: schedule message [time] to [recipient] [:|-|saying] [message]
  let m2 = t.match(/^(?:please\s+)?schedule\s+(?:a\s+)?(?:text|message|msg)\s+((?:today\s+at\s+|tomorrow\s+at\s+|at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|in\s+\d+\s*(?:mins?|minutes?|hours?|hrs?|seconds?|secs?|m|h|s))\s+to\s+([+0-9a-zA-Z._-]+)\s*[:\s-]?\s*(?:saying|that)?\s*['"“]?([\s\S]+?)['"”]?$/i);
  if (m2) {
    return { type: 'SCHEDULE', to: m2[2], timeStr: m2[1].trim(), msg: m2[3].trim() };
  }

  // Pattern 3: Hindi - [recipient] ko [time] message schedule kar do: [message]
  let m3 = t.match(/^([+0-9a-zA-Z._-]+)\s+ko\s+([\s\S]*?\bbaje|\bin\s+\d+\s*(?:mins?|minutes?|hours?|hrs?))\s+(?:message|text|msg)\s+schedule\s+(?:kar\s+do|karo|karna)\s*[:\s-]?\s*['"“]?([\s\S]+?)['"”]?$/i);
  if (m3) {
    return { type: 'SCHEDULE', to: m3[1], timeStr: m3[2].trim(), msg: m3[3].trim() };
  }

  return null;
}

/**
 * Background worker that checks for due scheduled messages every 15 seconds
 */
let isProcessingScheduledQueue = false;

async function processScheduledMessagesQueue() {
  if (isProcessingScheduledQueue) return;
  isProcessingScheduledQueue = true;

  try {
    const nowStr = getCurrentISTDateTimeStr();
    const pending = await getPendingScheduledMessages(nowStr);

    if (!pending || pending.length === 0) {
      isProcessingScheduledQueue = false;
      return;
    }

    const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '916377644251';
    const cleanPhone = (p) => p ? p.replace(/[^0-9]/g, '') : '';
    const cleanDir = cleanPhone(directorPhone) || '916377644251';
    const directorJid = `${cleanDir}@s.whatsapp.net`;

    for (const item of pending) {
      try {
        console.log(`[Scheduled Messages] Processing message #${item.id} to "${item.recipient_target}" (Scheduled: ${item.send_at} IST)...`);

        let targetJid = item.recipient_jid;
        if (!targetJid) {
          targetJid = await resolveRecipientJid(item.recipient_target);
        }

        if (!targetJid) {
          throw new Error(`Could not find WhatsApp contact or valid phone number for "${item.recipient_target}".`);
        }

        let sentVia = '';
        if (directorSock) {
          await directorSock.sendMessage(targetJid, { text: item.message_text });
          sentVia = 'Personal WhatsApp';
        } else if (botSock) {
          await botSock.sendMessage(targetJid, { text: item.message_text });
          sentVia = 'Bot WhatsApp';
        } else {
          throw new Error('Neither Personal nor Bot WhatsApp socket is currently connected.');
        }

        await markScheduledMessageSent(item.id);
        await logActivity('SCHEDULED_WA', `Scheduled message #${item.id} sent to ${item.recipient_target} via ${sentVia}`, 'INFO');
        console.log(`[Scheduled Messages] Delivered message #${item.id} to ${targetJid} via ${sentVia}`);

        // Notify Yash via Bot WhatsApp
        if (botSock) {
          const displayTarget = item.recipient_target.includes('@') ? item.recipient_target.split('@')[0] : item.recipient_target;
          const deliveryNotice = `⏰ *Scheduled Message Delivered!* 🚀\n\n📤 *Recipient:* ${displayTarget} (${targetJid.split('@')[0]})\n💬 *Message:* "${item.message_text}"\n🕒 *Scheduled For:* ${item.send_at} (IST)\n✅ *Sent Via:* ${sentVia}`;
          await botSock.sendMessage(directorJid, { text: deliveryNotice });
        }
      } catch (itemErr) {
        console.error(`[Scheduled Messages] Error for #${item.id}:`, itemErr.message);
        await markScheduledMessageFailed(item.id, itemErr.message);
        await logActivity('SCHEDULED_WA', `Scheduled message #${item.id} failed: ${itemErr.message}`, 'WARN');

        if (botSock) {
          const failNotice = `⚠️ *Scheduled Message Delivery Failed (#${item.id})*\n\n📤 *Recipient:* ${item.recipient_target}\n💬 *Message:* "${item.message_text}"\n❌ *Error:* ${itemErr.message}`;
          await botSock.sendMessage(directorJid, { text: failNotice });
        }
      }
    }
  } catch (err) {
    console.error('[Scheduled Messages Queue Error]:', err.message);
  } finally {
    isProcessingScheduledQueue = false;
  }
}

// Check scheduled messages queue every 15 seconds
setInterval(processScheduledMessagesQueue, 15000);

async function handleBotIncomingMessage(jid, senderPhone, text) {
  try {
    const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '916377644251';
    const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE || '';
    const connectedDirectorPhone = directorSock?.user?.id ? directorSock.user.id.split('@')[0].split(':')[0] : '916377644251';

    const cleanPhone = (p) => p ? p.replace(/[^0-9]/g, '') : '';
    const cleanSender = cleanPhone(senderPhone);
    const cleanDir = cleanPhone(directorPhone) || cleanPhone(connectedDirectorPhone) || '916377644251';
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

    const isDirector = matchPhone(cleanSender, cleanDir) || cleanSender.slice(-10) === '6377644251';
    const isPA = matchPhone(cleanSender, cleanPa);

    console.log(`[Bot WhatsApp] Inbound text from "${senderPhone}" (clean: ${cleanSender}) to bot. Match check -> isDirector: ${isDirector} (target: ${cleanDir})`);

    // --- EXCLUSIVE BOT GUARD: ACT AS BOT ONLY FOR 6377644251 ---
    // For anyone else messaging this number, act as simple normal WhatsApp (silent drop with zero automated replies)
    if (!isDirector) {
      console.log(`[Bot WhatsApp] Inbound text from non-authorized number "${senderPhone}". Acting as simple regular WhatsApp (bot silent).`);
      return; // SILENT DROP: No auto-replies, no bot cards, behaves like regular personal WhatsApp
    }

    // --- Universal / Hackathon Demo Mode: Friendly Onboarding & Feature Menu ---
    const lowerTrimText = text.toLowerCase().trim();
    const isGreeting = /^(hi|hello|hey|start|menu|help|info|about|who are you|namaste|hii|helo)$/i.test(lowerTrimText);

    if (!isDirector && !isPA && isGreeting) {
      const assistantName = (await getSetting('ASSISTANT_NAME')) || 'Zoro AI';
      const welcomeCard = `⚔️ *Greetings! I am ${assistantName}*
_Your Universal Autonomous Omnichannel Co-Pilot_ 🚀

🌟 *Live Hackathon Interactive Demo:*
I am an autonomous multi-agent co-pilot bridging WhatsApp, Gmail, Intelligent Scheduling, and Gemini AI.

💡 *Try testing any of these features right now:*
1️⃣ *!briefing* — Generates an Executive Daily Intelligence PDF report on the fly and sends it directly to you!
2️⃣ *Schedule a meeting:* Text _"Meeting with judges tomorrow at 11 AM at Booth A"_
3️⃣ *Check schedule:* Text _"What's on my schedule today?"_
4️⃣ *Draft an email:* Text _"Draft an email to mentor@hackathon.com requesting 5-min review"_
5️⃣ *Ask anything:* Ask any strategic question, brainstorm ideas, or craft messages!`;

      await botSock.sendMessage(jid, { text: welcomeCard });
      return;
    }

    // --- PA / Team Commands & Natural AI Schedule Handling ---
    if (isPA && !isDirector) {
      // 1. Check legacy prefix if typed "!schedule"
      if (text.startsWith('!schedule')) {
        const added = await parseScheduleFromText(text);
        await botSock.sendMessage(jid, {
          text: `✅ *Schedule Updated:*\nAdded ${added.length} meeting(s) to master calendar for today.`
        });
        return;
      }

      // 2. Intelligent AI Parsing for Natural messages
      const parsedIntent = await parseScheduleIntentWithAI(text);
      if (parsedIntent) {
        if (parsedIntent.intent === 'ADD_MEETING' && parsedIntent.meeting) {
          const m = parsedIntent.meeting;
          const id = await addSchedule({
            date: m.date || getLocalDateStr(),
            time_slot: m.time_slot || 'TBD',
            title: m.title || 'Scheduled Discussion',
            description: m.description || '',
            location: m.location || "Workspace",
            priority: m.priority || 'Normal',
            created_by: 'Collaborator via WhatsApp'
          });

          await botSock.sendMessage(jid, {
            text: `✅ *Meeting Scheduled in Master Calendar!*\n\n📅 *Date:* ${m.date}\n⏰ *Time:* ${m.time_slot}\n📌 *Agenda:* ${m.title}\n${m.description ? `📝 *Notes:* ${m.description}\n` : ''}⚠️ *Priority:* ${m.priority || 'Normal'}\n📍 *Location:* ${m.location || "Workspace"}\n\n_Master itinerary has been successfully updated!_`
          });
          return;
        }

        if (parsedIntent.intent === 'VIEW_SCHEDULE') {
          const targetDate = parsedIntent.viewDate || getLocalDateStr();
          const schedules = await getSchedulesByDate(targetDate);
          const list = schedules.length > 0
            ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location}) [${s.priority}]`).join('\n')
            : `No meetings scheduled for ${targetDate}.`;

          await botSock.sendMessage(jid, {
            text: `📅 *Schedule (${targetDate}):*\n\n${list}\n\n_To add a meeting, simply text details naturally (e.g., "Meeting tomorrow at 7 PM with Team")_`
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
      const todayStr = getLocalDateStr();
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
    // Guard: If the message discusses emails, mails, drafting, or replying, NEVER treat it as a PDF briefing!
    const hasEmailOrDraftIntent = /\b(mail|mails|email|emails|gmail|draft|reply|attend|attention|action)\b/i.test(lowerText);

    const isBriefingRequest = !hasEmailOrDraftIntent && (
      lowerText === '!briefing' ||
      lowerText === 'pdf' ||
      lowerText === 'report' ||
      (/\b(briefing|report|pdf)\b/i.test(lowerText) && /\b(give|send|share|show|bhejo|lao|generate|provide|want|need|de|dikha)\b/i.test(lowerText)) ||
      lowerText === 'give me pdf' ||
      lowerText === 'give ne the report' ||
      lowerText === 'give me the report' ||
      lowerText === 'give me report' ||
      lowerText === 'send me pdf' ||
      lowerText === 'send me report' ||
      lowerText === 'send pdf' ||
      lowerText === 'pdf bhejo' ||
      lowerText === 'report bhejo' ||
      lowerText === 'today report' ||
      (/\b(here|yahi|idhar)\b/i.test(lowerText) && /\b(send|give|bhejo|share|show)\b/i.test(lowerText) && directorConversationHistory.some(h => (h.content || '').toLowerCase().includes('pdf') || (h.content || '').toLowerCase().includes('briefing')))
    );

    if (isBriefingRequest) {
      await botSock.sendMessage(jid, { 
        text: `⏳ *Generating your real-time Executive Daily Briefing PDF...*\nCompiling the latest schedules, email correspondence, and WhatsApp intelligence right now. Dispatching the PDF document here shortly...` 
      });
      // Fire asynchronously in background so other messages are processed simultaneously
      triggerDailyBriefing(jid).catch(err => {
        console.error('[Daily Briefing Background Error]:', err);
      });
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
            text: `✅ ${contactName ? `*Contact "${contactName}" linked to ${phoneDigits}!*\n\n` : ''}*Message sent to ${phoneDigits} from your personal WhatsApp:*\n"${pendingMessage}"`
          });
          directorConversationHistory.push({ role: 'user', content: text });
          directorConversationHistory.push({ role: 'assistant', content: `Message sent to ${phoneDigits}: "${pendingMessage}"` });
          return;
        } catch (sendErr) {
          console.error('[Personal WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Error sending message to ${phoneDigits}: ${sendErr.message}`
          });
          return;
        }
      } else {
        await botSock.sendMessage(jid, {
          text: `✅ *Noted!* ${contactName ? `Contact "${contactName}"` : 'Phone number'} saved as *${phoneDigits}*.\n\nWhat message would you like me to send them from your personal WhatsApp?`
        });
        directorConversationHistory.push({ role: 'user', content: text });
        directorConversationHistory.push({ role: 'assistant', content: `Saved phone number ${phoneDigits} for ${contactName || 'contact'}.` });
        return;
      }
    }

    // 1. Gather Context (Both today and upcoming schedules)
    const todayStr = getLocalDateStr();
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

    // --- SCHEDULED WHATSAPP MESSAGES (Deterministic Command Handler) ---
    const schedCmd = parseScheduleWhatsappCommand(text);
    if (schedCmd) {
      if (schedCmd.type === 'CANCEL') {
        const cancelled = await cancelScheduledMessage(schedCmd.id);
        if (cancelled) {
          const resp = `🗑️ *Scheduled Message #${cancelled.id} Cancelled.*\n\n📤 *Recipient:* ${cancelled.recipient_target}\n💬 *Message:* "${cancelled.message_text}"\n🕒 *Was scheduled for:* ${cancelled.send_at} (IST)`;
          await botSock.sendMessage(jid, { text: resp });
          directorConversationHistory.push({ role: 'user', content: text });
          directorConversationHistory.push({ role: 'assistant', content: resp });
        } else {
          await botSock.sendMessage(jid, { text: `⚠️ Could not find an active scheduled message with ID #${schedCmd.id}.` });
        }
        return;
      }

      if (schedCmd.type === 'LIST') {
        const list = await listScheduledMessages(10);
        if (!list || list.length === 0) {
          await botSock.sendMessage(jid, {
            text: `ℹ️ *No pending scheduled messages.*\n\n_To schedule a message, text:_\n*"Schedule message to [number/name] at [time]: [message]"*`
          });
        } else {
          const formatted = list.map((m, idx) => 
            `${idx + 1}️⃣ *ID #${m.id}* ➔ *${m.recipient_target}*\n🕒 *Send Time:* ${m.send_at} (IST)\n💬 *Message:* "${m.message_text}"`
          ).join('\n\n');
          await botSock.sendMessage(jid, {
            text: `📋 *Pending Scheduled Messages (${list.length}):*\n\n${formatted}\n\n_To cancel any message, reply:_\n*"Cancel scheduled message #[ID]"*`
          });
        }
        return;
      }

      if (schedCmd.type === 'SCHEDULE') {
        const parsedTime = parseTargetScheduledDateTime(schedCmd.timeStr);
        if (!parsedTime) {
          await botSock.sendMessage(jid, {
            text: `⚠️ Could not recognize scheduled time "${schedCmd.timeStr}". Please specify time clearly (e.g., "at 5:30 PM", "tomorrow at 11 AM", "in 15 mins", "shaam 6 baje").`
          });
          return;
        }

        const targetJid = await resolveRecipientJid(schedCmd.to);
        const schedId = await addScheduledMessage({
          recipient_target: schedCmd.to,
          recipient_jid: targetJid,
          message_text: schedCmd.msg,
          send_at: parsedTime.isoDateTime
        });

        const confirmMsg = `⏰ *Message Scheduled Successfully!* (Ref #${schedId})\n\n📤 *To:* ${schedCmd.to}${targetJid ? ` (${targetJid.split('@')[0]})` : ''}\n🕒 *Delivery Time:* ${parsedTime.displayStr}\n💬 *Message:* "${schedCmd.msg}"\n\n_I will automatically send this message from your WhatsApp when the time arrives!_ 🚀`;
        await botSock.sendMessage(jid, { text: confirmMsg });
        directorConversationHistory.push({ role: 'user', content: text });
        directorConversationHistory.push({ role: 'assistant', content: confirmMsg });
        return;
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
            text: `✅ *Message sent to ${displayTarget} from your personal WhatsApp:*\n"${messageToSend}"`
          });
          directorConversationHistory.push({ role: 'user', content: text });
          directorConversationHistory.push({ role: 'assistant', content: `Message sent to ${displayTarget}: "${messageToSend}"` });
          return;
        } catch (sendErr) {
          console.error('[Personal WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Failed to deliver message from personal WhatsApp to ${targetRecipient}: ${sendErr.message}`
          });
          return;
        }
      } else if (!directorSock) {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Personal WhatsApp account is currently disconnected.* Please scan/connect personal WhatsApp in the dashboard before sending messages.`
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

    // Stop words list to isolate potential names / subjects
    const stopWordsList = new Set([
      'give', 'me', 'tell', 'show', 'find', 'search', 'check', 'look', 'what', 'when', 'where', 'how', 'who', 'which',
      'chat', 'chats', 'text', 'texts', 'texted', 'texting', 'message', 'messages', 'messaged', 'messaging', 'msg', 'msgs',
      'history', 'conversation', 'summary', 'summarize', 'detail', 'details', 'recent', 'recently', 'today', 'yesterday', 'tomorrow',
      'last', 'latest', 'past', 'old', 'new', 'regarding', 'about', 'related', 'with', 'from', 'have', 'had', 'has', 'did', 'do', 'does', 'is', 'are', 'was', 'were',
      'sent', 'send', 'bheja', 'bhejo', 'aaya', 'kya', 'hai', 'tha', 'thi', 'the', 'bhi', 'aur', 'wale',
      'wali', 'wala', 'mein', 'please', 'plz', 'sir', 'assistant', 'whatsapp', 'inbox', 'mail', 'email',
      'emails', 'here', 'there', 'this', 'that', 'them', 'they', 'their', 'said', 'says', 'bol', 'bola',
      'ka', 'ki', 'ke', 'ko', 'se', 'do', 'de', 'dikha', 'dikhao', 'sunao', 'batao', 'i', 'you', 'my', 'your', 'he', 'she', 'him', 'her'
    ]);

    const potentialTokens = lowerText
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWordsList.has(w) && !/^\d+$/.test(w));

    // Detect if this message is inquiring about WhatsApp messages, chats, contacts, or mentions a person
    const waKeywords = /\b(whatsapp|chat|chats|text|texts|texted|texting|message|messages|messaged|messaging|msg|msgs|conversation|history|kaha|bheja|bhejo|said|bol|bola|bolo|bataya|aaya|likha|reply|replied|sent|send)\b/i;
    
    // Check if previous conversation turn was looking for a contact or messages
    const isContextualContactQuery = directorConversationHistory.slice(-2).some(h => 
      (h.content || '').toLowerCase().includes('contact') || 
      (h.content || '').toLowerCase().includes('records') ||
      (h.content || '').toLowerCase().includes('messages found') ||
      (h.content || '').toLowerCase().includes('search again')
    );

    let matchesKnownContact = false;
    if (potentialTokens.length > 0 && potentialTokens.length <= 5) {
      for (const t of potentialTokens) {
        if (recentDirectorContacts.has(t)) {
          matchesKnownContact = true;
          break;
        }
      }
      if (!matchesKnownContact) {
        for (const t of potentialTokens) {
          if (t.length < 3) continue;
          try {
            const cCheck = await query(`SELECT id FROM whatsapp_contacts WHERE name LIKE ? LIMIT 1`, [`%${t}%`]);
            if (cCheck.length > 0) { matchesKnownContact = true; break; }
            const sCheck = await query(`SELECT id FROM whatsapp_chats WHERE sender_name LIKE ? LIMIT 1`, [`%${t}%`]);
            if (sCheck.length > 0) { matchesKnownContact = true; break; }
          } catch(e) {}
        }
      }
    }

    const isWaQuery = waKeywords.test(lowerText) || isContextualContactQuery || matchesKnownContact;
    let targetEntityName = '';
    let requestedLimit = null;

    if (isWaQuery) {
      // 1. Extract any numeric limit (e.g. "last 20 chat", "5 messages", "last 10 messages")
      let queryLimit = 15;
      const numMatch = text.match(/\b(\d{1,2})\b/);
      if (numMatch) {
        requestedLimit = Math.max(1, Math.min(50, parseInt(numMatch[1], 10)));
        queryLimit = requestedLimit;
      }

      const normalizedTokens = potentialTokens;
      const cleanKeyword = normalizedTokens.join(' ').trim();
      const isGroupSearch = /\b(group|grp|channel|community|section)\b/i.test(lowerText);

      // Check for day of the week, relative date, or sent-by-me filters
      const dayMatch = lowerText.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|kal|aaj)\b/i);
      const isOnlySentByMe = /\b(i\s+sent|i\s+send|i\s+texted|sent\s+by\s+me|maine\s+bheja|maine\s+text\s+kiya)\b/i.test(lowerText);
      const isLinkQuery = /\b(link|links|url|urls|website)\b/i.test(lowerText);
      const dayRange = dayMatch ? getDayTimestampRange(dayMatch[1]) : null;

      try {
        const candidates = [];
        const seenCandidateJids = new Set();

        const addCandidate = (c) => {
          if (!c || !c.jid || seenCandidateJids.has(c.jid)) return;
          seenCandidateJids.add(c.jid);
          candidates.push(c);
        };

        // A. From memory map
        if (cleanKeyword) {
          for (const [cName, cJid] of recentDirectorContacts.entries()) {
            if (cName.includes(cleanKeyword) || cleanKeyword.includes(cName) || levenshteinDistance(cleanKeyword, cName) <= 2) {
              addCandidate({ jid: cJid, phone: cJid.split('@')[0], name: cName, notify: '' });
            }
          }
        }

        // B. From whatsapp_contacts
        if (cleanKeyword.length > 0) {
          const directContacts = await query(
            `SELECT jid, phone, name, notify FROM whatsapp_contacts 
             WHERE (name LIKE ? OR notify LIKE ? OR phone LIKE ?) LIMIT 35`,
            [`%${cleanKeyword}%`, `%${cleanKeyword}%`, `%${cleanKeyword}%`]
          );
          directContacts.forEach(addCandidate);
        }

        // If no direct keyword candidates, try significant tokens (>= 3 chars)
        if (candidates.length === 0 && normalizedTokens.length > 0) {
          for (const t of normalizedTokens) {
            if (t.length >= 3 && !['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'yesterday'].includes(t)) {
              const tokenContacts = await query(
                `SELECT jid, phone, name, notify FROM whatsapp_contacts 
                 WHERE (name LIKE ? OR notify LIKE ? OR phone LIKE ?) LIMIT 20`,
                [`%${t}%`, `%${t}%`, `%${t}%`]
              );
              tokenContacts.forEach(addCandidate);
            }
          }
        }

        // C. From whatsapp_chats distinct senders
        if (cleanKeyword.length > 0) {
          const chatSenders = await query(
            `SELECT DISTINCT sender_name, sender_phone, chat_jid FROM whatsapp_chats 
             WHERE (sender_name LIKE ? OR sender_phone LIKE ?) AND sender_name != 'Director' LIMIT 20`,
            [`%${cleanKeyword}%`, `%${cleanKeyword}%`]
          );
          for (const cs of chatSenders) {
            addCandidate({ jid: cs.chat_jid, phone: cs.sender_phone, name: cs.sender_name, notify: '' });
          }
        }

        // Query chat activity counts for candidates to prioritize chats with real message history
        const activeChatCounts = new Map();
        const candidateJidsList = candidates.map(c => c.jid).filter(Boolean);
        if (candidateJidsList.length > 0) {
          const qPlaceholders = candidateJidsList.map(() => '?').join(',');
          const chatStats = await query(
            `SELECT chat_jid, COUNT(*) as cnt FROM whatsapp_chats WHERE chat_jid IN (${qPlaceholders}) GROUP BY chat_jid`,
            candidateJidsList
          );
          for (const row of chatStats) {
            activeChatCounts.set(row.chat_jid, row.cnt);
          }
          for (const c of candidates) {
            if (!activeChatCounts.has(c.jid)) {
              const p = c.phone || c.jid.split('@')[0];
              const pStat = await query(
                `SELECT COUNT(*) as cnt FROM whatsapp_chats WHERE sender_phone LIKE ? OR chat_jid LIKE ?`,
                [`%${p}%`, `%${p}%`]
              );
              if (pStat[0]?.cnt > 0) {
                activeChatCounts.set(c.jid, pStat[0].cnt);
              }
            }
          }
        }

        // Score candidates
        const scoredCandidates = [];
        for (const c of candidates) {
          const cName = (c.name || c.notify || '').toLowerCase().trim();
          let score = 0;
          const isGroupJid = c.jid.endsWith('@g.us');
          const msgCount = activeChatCounts.get(c.jid) || 0;

          if (cName === cleanKeyword) score += 100;
          else if (cName.startsWith(cleanKeyword + ' ') || cName.endsWith(' ' + cleanKeyword)) score += 85;
          else if (cName.includes(cleanKeyword) && cleanKeyword.length >= 3) score += 70;
          else {
            let matchedTokenCount = 0;
            for (const tok of normalizedTokens) {
              if (tok.length >= 2 && cName.includes(tok)) matchedTokenCount++;
            }
            score += matchedTokenCount * 20;
          }

          if (isGroupSearch && isGroupJid) score += 20;
          if (isGroupSearch && !isGroupJid) score -= 30;
          if (!isGroupSearch && isGroupJid) score -= 20;

          // Chat activity bonus: if the user actually has chats with this candidate, boost!
          if (msgCount > 0) {
            score += Math.min(35, 15 + msgCount * 2);
          } else {
            score -= 20;
          }

          scoredCandidates.push({ ...c, score, msgCount });
        }

        scoredCandidates.sort((a, b) => b.score - a.score);

        // Build global filters (date range, sent by me, links)
        const filterClauses = [];
        const filterParams = [];

        if (dayRange) {
          filterClauses.push(`timestamp BETWEEN ? AND ?`);
          filterParams.push(dayRange.start, dayRange.end);
        }

        if (isOnlySentByMe) {
          filterClauses.push(`is_from_me = 1`);
        }

        if (isLinkQuery) {
          filterClauses.push(`(message_text LIKE '%http%' OR message_text LIKE '%https%' OR message_text LIKE '%.com%' OR message_text LIKE '%.org%' OR message_text LIKE '%.edu%' OR message_text LIKE '%.in%')`);
        }

        const topCandidate = scoredCandidates[0];
        if (topCandidate && topCandidate.score >= 60) {
          targetEntityName = topCandidate.name || topCandidate.notify || cleanKeyword;
          console.log(`[Director Query] Identified target chat: "${targetEntityName}" (${topCandidate.jid}) with score ${topCandidate.score}`);

          let entitySql = '';
          let entityParams = [];

          if (topCandidate.jid.endsWith('@g.us')) {
            entitySql = `chat_jid = ?`;
            entityParams = [topCandidate.jid];
          } else {
            const p = topCandidate.phone || topCandidate.jid.split('@')[0];
            entitySql = `(chat_jid = ? OR chat_jid LIKE ? OR sender_phone LIKE ?)`;
            entityParams = [topCandidate.jid, `%${p}%`, `%${p}%`];
          }

          let finalWhere = entitySql;
          let finalParams = [...entityParams];
          if (filterClauses.length > 0) {
            finalWhere = `(${entitySql}) AND ${filterClauses.join(' AND ')}`;
            finalParams.push(...filterParams);
          }
          finalParams.push(queryLimit);

          matchedWhatsAppMessages = await query(
            `SELECT sender_name, sender_phone, chat_jid, message_text, timestamp, is_from_me 
             FROM whatsapp_chats 
             WHERE ${finalWhere}
             ORDER BY timestamp DESC, id DESC LIMIT ?`,
            finalParams
          );
        } else {
          // Fallback multi-candidate or text search
          let whereSql = '';
          let finalParams = [];

          if (filterClauses.length > 0 && cleanKeyword.length > 1) {
            whereSql = `(sender_name LIKE ? OR message_text LIKE ?) AND ${filterClauses.join(' AND ')}`;
            finalParams = [`%${cleanKeyword}%`, `%${cleanKeyword}%`, ...filterParams];
          } else if (filterClauses.length > 0) {
            whereSql = filterClauses.join(' AND ');
            finalParams = filterParams;
          } else if (cleanKeyword.length > 1) {
            whereSql = `sender_name LIKE ? OR message_text LIKE ?`;
            finalParams = [`%${cleanKeyword}%`, `%${cleanKeyword}%`];
          }

          if (whereSql) {
            finalParams.push(queryLimit);
            matchedWhatsAppMessages = await query(
              `SELECT sender_name, sender_phone, chat_jid, message_text, timestamp, is_from_me 
               FROM whatsapp_chats 
               WHERE ${whereSql}
               ORDER BY timestamp DESC, id DESC LIMIT ?`,
              finalParams
            );
          }
        }

        // Reverse so chronological order
        if (matchedWhatsAppMessages.length > 0) {
          matchedWhatsAppMessages.reverse();
          console.log(`[Director Query] Retrieved ${matchedWhatsAppMessages.length} matched WhatsApp messages for "${targetEntityName || cleanKeyword}"`);
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

      const isUrgentOrAttention = 
        /\b(attention|urgent|priority|important|action|require|needing|immediate)\b/i.test(lowerText) ||
        /\b(draft|reply|respond|answer|compose)\b/i.test(lowerText) ||
        lowerText.includes('any mail') || lowerText.includes('any email') || lowerText.includes('my mail') || lowerText.includes('my email');

      const isGeneralRecent = 
        isUrgentOrAttention ||
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
          // Bounded 3.5s timeout promise so live email fetch never hangs the response
          const livePromise = fetchUnreadEmails(6, false);
          const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3500));
          const liveRecent = await Promise.race([livePromise, timeoutPromise]);
          if (liveRecent && liveRecent.length > 0) {
            const cleanRecent = liveRecent.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
            matchedEmails.push(...cleanRecent);
          }
        } catch (e) {}

        // If live emails didn't return or are empty, ensure stored recent emails are included
        if (matchedEmails.length === 0 && recentEmails.length > 0) {
          matchedEmails.push(...recentEmails.map(r => ({
            id: r.id,
            from: `${r.sender_name} <${r.sender_email}>`,
            senderName: r.sender_name,
            senderEmail: r.sender_email,
            subject: r.subject,
            snippet: r.summary,
            priority: r.priority,
            actionRequired: r.action_required
          })));
        }
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
            const searchPromise = searchGmail(queryTerm, 15);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3500));
            const liveFound = await Promise.race([searchPromise, timeoutPromise]);
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
            const livePromise = fetchUnreadEmails(6, false);
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve([]), 3500));
            const liveRecent = await Promise.race([livePromise, timeoutPromise]);
            if (liveRecent && liveRecent.length > 0) {
              const cleanRecent = liveRecent.filter(e => !isRecruitmentEmailData(e, recruitmentEmail));
              matchedEmails.push(...cleanRecent);
            }
          } catch (e) {}
        }
      }
    }

    const formattedMatchedMsgs = matchedWhatsAppMessages.map(m => ({
      sender: m.is_from_me ? 'Director / You' : (m.sender_name && m.sender_name !== m.sender_phone ? m.sender_name : (targetEntityName || 'Contact')),
      text: m.message_text,
      time: formatMessageTimestamp(m.timestamp),
      is_from_me: m.is_from_me ? 1 : 0
    }));

    const formattedRecentChats = recentChats.map(m => ({
      sender: m.sender_name && m.sender_name !== m.sender_phone ? m.sender_name : 'Contact',
      text: m.message_text,
      time: formatMessageTimestamp(m.timestamp),
      is_from_me: 0
    }));

    const aiReply = await handleDirectorChat(text, {
      schedules,
      whatsappMessages: formattedMatchedMsgs.length > 0 ? formattedMatchedMsgs : formattedRecentChats,
      matchedWhatsAppMessages: formattedMatchedMsgs,
      requestedCount: requestedLimit,
      totalFound: matchedWhatsAppMessages.length,
      targetName: targetEntityName,
      recentEmails,
      matchedEmails,
      pendingDrafts,
      scheduledMessages: await listScheduledMessages(5),
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
      const cleanReply = aiReply.replace(replyMatch[0], '').trim();
      const displayTarget = targetRecipient.includes('@') ? targetRecipient.split('@')[0] : targetRecipient;

      if (!isDirector) {
        await botSock.sendMessage(jid, {
          text: `${cleanReply ? `${cleanReply}\n\n` : ''}💬 *Crafted Message Ready for ${displayTarget}:*\n"${messageToSend}"\n\n_💡 (Direct proxy delivery via linked session is reserved for primary account owner)_`
        });
        return;
      }

      // Resolve recipient JID: Direct Phone Number > Cache > Database > Conversation History
      const targetJid = await resolveRecipientJid(targetRecipient);

      if (targetJid && directorSock) {
        try {
          await directorSock.sendMessage(targetJid, { text: messageToSend });
          await botSock.sendMessage(jid, {
            text: `${cleanReply ? `${cleanReply}\n\n` : ''}✅ *Message sent to ${displayTarget} from your primary WhatsApp account:*\n"${messageToSend}"`
          });
          return;
        } catch (sendErr) {
          console.error('[Primary WA Send Error]:', sendErr);
          await botSock.sendMessage(jid, {
            text: `❌ Failed to deliver message from WhatsApp to ${targetRecipient}: ${sendErr.message}`
          });
          return;
        }
      } else if (!directorSock) {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Primary WhatsApp account is currently disconnected.* Please scan/connect primary WhatsApp in the dashboard before proxying messages.`
        });
        return;
      } else {
        await botSock.sendMessage(jid, {
          text: `⚠️ Could not find WhatsApp contact for "${targetRecipient}". Please provide their exact 10-digit mobile number.`
        });
        return;
      }
    }

    // Check if AI generated a schedule action block
    // Format: [ACTION:SCHEDULE_WHATSAPP | TO:recipient | TIME:timeStr | MESSAGE:text]
    const schedAiMatch = aiReply.match(/\[ACTION:SCHEDULE_WHATSAPP\s*\|\s*TO:([^|]+)\|\s*TIME:([^|]+)\|\s*MESSAGE:([^\]]+)\]/i);
    if (schedAiMatch) {
      const targetRecipient = schedAiMatch[1].trim();
      const timeExpr = schedAiMatch[2].trim();
      const messageToSend = schedAiMatch[3].trim();
      const cleanReply = aiReply.replace(schedAiMatch[0], '').trim();

      const parsedTime = parseTargetScheduledDateTime(timeExpr);
      if (parsedTime) {
        const targetJid = await resolveRecipientJid(targetRecipient);
        const schedId = await addScheduledMessage({
          recipient_target: targetRecipient,
          recipient_jid: targetJid,
          message_text: messageToSend,
          send_at: parsedTime.isoDateTime
        });

        await botSock.sendMessage(jid, {
          text: `${cleanReply ? `${cleanReply}\n\n` : ''}⏰ *Message Scheduled Successfully!* (Ref #${schedId})\n\n📤 *To:* ${targetRecipient}${targetJid ? ` (${targetJid.split('@')[0]})` : ''}\n🕒 *Delivery Time:* ${parsedTime.displayStr}\n💬 *Message:* "${messageToSend}"\n\n_I will automatically dispatch this message when the time arrives!_ 🚀`
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
      triggerDailyBriefing(jid).catch(err => {
        console.error('[Briefing Background Error]:', err);
      });
      return;
    }

    // Regular AI response
    const replyText = (typeof aiReply === 'string' && aiReply.trim()) 
      ? aiReply.trim() 
      : "I received your request! The Zoro reasoning engine is syncing. Please text again if you need immediate details.";
    if (botSock && botStatus === 'CONNECTED') {
      await botSock.sendMessage(jid, { text: replyText });
    }
  } catch (err) {
    console.error('[Bot Error]:', err);
    await logActivity('BOT_ERROR', `Error processing query from ${senderPhone}: ${err.message}`, 'ERROR');
    try {
      if (botSock && botStatus === 'CONNECTED') {
        await botSock.sendMessage(jid, {
          text: `⚠️ *Zoro AI Notice*\n\nI encountered a momentary delay: ${err.message}. Please try texting again in a moment.`
        });
      }
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

    // 4. Generate PDF strictly for Yash
    const orgName = (await getSetting('ORGANIZATION_NAME')) || process.env.ORGANIZATION_NAME || 'Zoro AI Hub';
    const directorTitle = (await getSetting('DIRECTOR_TITLE')) || process.env.DIRECTOR_TITLE || 'Office of the Director';
    const userName = (await getSetting('USER_NAME')) || (await getSetting('DIRECTOR_NAME')) || 'Yash';

    const pdfPath = await generateExecutiveBriefingPdf({
      dateStr: todayStr,
      directorName: userName,
      organizationName: orgName,
      directorTitle,
      schedules,
      emails: emailsForBriefing,
      chats: recentChats
    });

    // 5. Send PDF document & Text Summary via Bot WhatsApp or Director WhatsApp fallback
    let dispatched = false;
    const activeSock = botSock || directorSock;
    if (activeSock && recipientJid) {
      const urgentCount = emailsForBriefing.filter(e => e.priority === 'Urgent').length;
      const textDigest = `🏛️ *OFFICIAL EXECUTIVE DAILY BRIEFING*\n📅 *Date:* ${todayStr}\n\n` +
        `📋 *Meetings Today:* ${schedules.length} scheduled\n` +
        `🚨 *Inbound Emails:* ${emailsForBriefing.length} analyzed (${urgentCount} urgent)\n` +
        `💬 *WhatsApp Alerts:* ${recentChats.length} messages monitored\n\n` +
        `📎 *Attached:* High-Resolution Executive PDF Report below.`;

      try {
        await activeSock.sendMessage(recipientJid, { text: textDigest });

        // Send PDF file
        const pdfBuffer = fs.readFileSync(pdfPath);
        await activeSock.sendMessage(recipientJid, {
          document: pdfBuffer,
          mimetype: 'application/pdf',
          fileName: `Zoro_Briefing_${todayStr}.pdf`,
          caption: `Zoro Daily Intelligence Briefing - ${todayStr}`
        });

        dispatched = true;
        await logActivity('BRIEFING', `Daily briefing PDF dispatched to (${recipientJid}) via WhatsApp`, 'INFO');
      } catch (dispatchErr) {
        console.warn('[Briefing Dispatch Error]:', dispatchErr.message);
      }
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

