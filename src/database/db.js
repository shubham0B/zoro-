import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pool = null;
let sqliteDb = null;
let isConnected = false;
let dbType = process.env.DB_CLIENT === 'mysql' ? 'mysql' : 'sqlite';

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'executive_ai_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const CONFLICT_TARGETS = {
  system_settings: 'key_name',
  recruitment_settings: 'key_name',
  whatsapp_contacts: 'jid',
  whatsapp_chats: 'msg_id',
  email_summaries: 'gmail_id',
  email_drafts: 'id',
  briefings: 'briefing_date',
  google_tokens: 'email',
  recruitment_tokens: 'email',
  admin_users: 'email',
  candidate_applications: 'gmail_message_id',
  activity_logs: 'id',
  schedules: 'id',
  scheduled_messages: 'id',
  auth_sessions: 'token'
};

function translateSqlForSqlite(sql, params) {
  let s = sql.trim();

  // 1. TRUNCATE TABLE x -> DELETE FROM x
  s = s.replace(/TRUNCATE\s+TABLE\s+[`'"]?(\w+)[`'"]?/gi, 'DELETE FROM $1');

  // 2. NOW() - INTERVAL (\d+) DAY -> datetime('now', '-$1 days')
  s = s.replace(/NOW\(\)\s*-\s*INTERVAL\s+(\d+)\s+DAY/gi, "datetime('now', '-$1 days')");

  // 3. NOW() -> CURRENT_TIMESTAMP
  s = s.replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP');

  // 4. ON DUPLICATE KEY UPDATE translation for SQLite ON CONFLICT
  if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(s)) {
    const tableMatch = s.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+[`'"]?(\w+)[`'"]?/i);
    const tableName = tableMatch ? tableMatch[1].toLowerCase() : '';
    const conflictKey = CONFLICT_TARGETS[tableName] || 'id';

    s = s.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i, `ON CONFLICT(${conflictKey}) DO UPDATE SET`);
    s = s.replace(/VALUES\s*\(\s*[`'"]?(\w+)[`'"]?\s*\)/gi, 'excluded.$1');
  }

  // 5. Clean MySQL backticks
  s = s.replace(/`(\w+)`/g, '$1');

  // 6. Normalize parameters (boolean -> 1/0, Date -> string, objects -> JSON string)
  const normalizedParams = params.map(p => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString().slice(0, 19).replace('T', ' ');
    if (p === undefined) return null;
    if (typeof p === 'object' && p !== null && !Buffer.isBuffer(p)) {
      return JSON.stringify(p);
    }
    return p;
  });

  return { sql: s, params: normalizedParams };
}

function initSqlite() {
  const storageDir = path.join(__dirname, '../../storage');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const dbPath = path.join(storageDir, 'zoro.db');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  createSqliteTables();
  isConnected = true;
  dbType = 'sqlite';
  console.log(`[Database] SQLite database initialized successfully at: ${dbPath}`);
}

function createSqliteTables() {
  const schema = `
    CREATE TABLE IF NOT EXISTS system_settings (
      key_name TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS google_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      refresh_token TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT DEFAULT 'Director Office / Online',
      priority TEXT DEFAULT 'Normal',
      created_by TEXT DEFAULT 'PA',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_target TEXT NOT NULL,
      recipient_jid TEXT,
      message_text TEXT NOT NULL,
      send_at TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sched_msg_status ON scheduled_messages(status, send_at);

    CREATE TABLE IF NOT EXISTS whatsapp_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE,
      chat_jid TEXT NOT NULL,
      sender_name TEXT,
      sender_phone TEXT,
      message_text TEXT,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      ai_summary TEXT,
      ai_urgency TEXT DEFAULT 'Normal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chats_jid ON whatsapp_chats(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_chats_timestamp ON whatsapp_chats(timestamp);

    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE,
      phone TEXT,
      name TEXT,
      notify TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON whatsapp_contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON whatsapp_contacts(name);

    CREATE TABLE IF NOT EXISTS email_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_id TEXT UNIQUE,
      sender_email TEXT,
      sender_name TEXT,
      subject TEXT,
      snippet TEXT,
      date_received TEXT,
      priority TEXT DEFAULT 'Normal',
      summary TEXT,
      action_required TEXT,
      is_processed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_emails_priority ON email_summaries(priority);
    CREATE INDEX IF NOT EXISTS idx_emails_gmail_id ON email_summaries(gmail_id);

    CREATE TABLE IF NOT EXISTS email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING_VERIFICATION',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      briefing_date TEXT UNIQUE,
      pdf_filename TEXT,
      summary_text TEXT,
      edtech_news TEXT,
      is_sent_to_director INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'INFO',
      module TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT DEFAULT 'Director',
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'director',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      user_agent TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recruitment_settings (
      key_name TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recruitment_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      refresh_token TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS candidate_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT UNIQUE,
      gmail_message_id TEXT UNIQUE,
      candidate_email TEXT NOT NULL,
      candidate_name TEXT,
      candidate_phone TEXT,
      applied_post TEXT,
      experience_years TEXT,
      skills TEXT,
      ai_summary TEXT,
      has_resume_attachment INTEGER DEFAULT 1,
      resume_filenames TEXT,
      confirmation_status TEXT DEFAULT 'PENDING',
      confirmation_method TEXT DEFAULT 'GMAIL_OAUTH',
      confirmation_sent_at DATETIME,
      confirmation_error TEXT,
      email_subject TEXT,
      email_snippet TEXT,
      email_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_app_email ON candidate_applications(candidate_email);
    CREATE INDEX IF NOT EXISTS idx_app_status ON candidate_applications(confirmation_status);
    CREATE INDEX IF NOT EXISTS idx_app_post ON candidate_applications(applied_post);
  `;
  sqliteDb.exec(schema);
}

export async function initDatabase() {
  if (process.env.DB_CLIENT === 'mysql') {
    try {
      const rootConnection = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password
      });

      await rootConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      await rootConnection.end();

      pool = mysql.createPool(dbConfig);
      const connection = await pool.getConnection();
      connection.release();
      isConnected = true;
      dbType = 'mysql';
      console.log(`[Database] Connected successfully to MySQL database "${dbConfig.database}"`);
      await createTables();
      return true;
    } catch (error) {
      console.warn(`[Database Warning] MySQL connection failed (${error.message}). Falling back to SQLite...`);
    }
  }

  // SQLite Initialization
  try {
    initSqlite();
    await postDatabaseInit();
    return true;
  } catch (err) {
    console.error(`[Database Error] SQLite initialization failed:`, err.message);
    isConnected = false;
    return false;
  }
}

async function postDatabaseInit() {
  // 1. Seed admin credentials
  try {
    const { seedDefaultAdmin } = await import('../services/authService.js');
    await seedDefaultAdmin();
  } catch (err) {
    console.error('[Database Error] Failed to seed default admin:', err.message);
  }

  // 2. Seed Mock Dataset
  await seedMockDataset();
}

async function seedMockDataset() {
  try {
    // Check if schedules exist
    const schedules = await query('SELECT COUNT(*) as count FROM schedules');
    const scheduleCount = schedules[0]?.count || 0;

    if (scheduleCount === 0) {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

      const mockSchedules = [
        [today, '10:00 AM - 11:30 AM', 'Academic Council & Curriculum Strategy', 'Quarterly curriculum benchmarking with HODs.', 'Senate Hall', 'High', 'PA'],
        [today, '02:00 PM - 03:00 PM', 'AI Lab & Robotics Center Inspection', 'Review setup of GPU clusters and humanoid robotics kits.', 'Computer Science Block', 'Urgent', 'PA'],
        [today, '04:30 PM - 05:30 PM', 'Executive Consultation & Faculty Hiring Review', 'Shortlisting senior professor candidates with Dean.', 'Director Boardroom', 'Normal', 'Director'],
        [tomorrow, '11:00 AM - 12:00 PM', 'Industry Partnership MoUs - Tech Giants', 'Signing ceremony and strategic roadmap discussion.', 'Conference Hall A', 'High', 'PA']
      ];

      for (const s of mockSchedules) {
        await query(
          'INSERT INTO schedules (date, time_slot, title, description, location, priority, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          s
        );
      }
      console.log('[Dataset] Sample Executive Schedules seeded.');
    }

    // Check if candidates exist
    const candidates = await query('SELECT COUNT(*) as count FROM candidate_applications');
    const candidateCount = candidates[0]?.count || 0;

    if (candidateCount === 0) {
      const mockCandidates = [
        [
          'APP-2026-AI-101', 'msg-001', 'aarav.sharma@example.com', 'Dr. Aarav Sharma', '+91 98765 43210',
          'Associate Professor - Artificial Intelligence', '7 Years',
          'Deep Learning, PyTorch, Large Language Models, Multi-Agent Systems, NLP',
          'Published 12 SCI papers, 4 patent grants in AI computer vision. Outstanding academic background.',
          1, 'Aarav_Sharma_CV.pdf', 'SENT', 'GMAIL_OAUTH', 'Application: Associate Professor AI - Dr. Aarav Sharma',
          'Please find attached my CV and list of publications for the faculty position.', 'Today at 09:30 AM'
        ],
        [
          'APP-2026-CS-102', 'msg-002', 'neha.verma@example.com', 'Neha Verma', '+91 98123 45678',
          'Assistant Professor - Cyber Security & Cloud', '4.5 Years',
          'Ethical Hacking, Cryptography, AWS/GCP Security, Network Forensics',
          'CISSP certified with extensive industrial research experience at top cybersecurity firms.',
          1, 'Neha_Verma_Resume.pdf', 'SENT', 'GMAIL_OAUTH', 'Job Application - Assistant Professor Cyber Security',
          'Enclosed is my resume detailing my 4+ years teaching and consulting experience.', 'Today at 10:15 AM'
        ],
        [
          'APP-2026-ROB-103', 'msg-003', 'karan.malhotra@example.com', 'Karan Malhotra', '+91 97654 32109',
          'Lead Robotics Engineer - Innovation Hub', '5 Years',
          'ROS2, Embedded C++, SLAM, LiDAR Navigation, Drone Systems, Autonomous Navigation',
          'Spearheaded 3 autonomous vehicle prototypes. Strong hands-on engineering track record.',
          1, 'Karan_Malhotra_Portfolio.pdf', 'PENDING', 'GMAIL_OAUTH', 'Resume Submission: Lead Robotics Engineer',
          'Sharing my resume and GitHub portfolio demonstrating autonomous robotics platforms.', 'Today at 11:45 AM'
        ]
      ];

      for (const c of mockCandidates) {
        await query(
          `INSERT INTO candidate_applications (
            application_id, gmail_message_id, candidate_email, candidate_name, candidate_phone,
            applied_post, experience_years, skills, ai_summary, has_resume_attachment,
            resume_filenames, confirmation_status, confirmation_method, email_subject, email_snippet, email_date
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c
        );
      }
      console.log('[Dataset] Sample Candidate Applications seeded.');
    }

    // Check if contacts exist
    const contacts = await query('SELECT COUNT(*) as count FROM whatsapp_contacts');
    const contactCount = contacts[0]?.count || 0;

    if (contactCount === 0) {
      const mockContacts = [
        ['919876543210@s.whatsapp.net', '919876543210', 'Tarun Pachori', 'Tarun'],
        ['919812345678@s.whatsapp.net', '919812345678', 'Dean Academics', 'Dean'],
        ['919898989898@s.whatsapp.net', '919898989898', 'Prof. VC Office', 'Vice Chancellor']
      ];

      for (const c of mockContacts) {
        await query('INSERT INTO whatsapp_contacts (jid, phone, name, notify) VALUES (?, ?, ?, ?)', c);
      }
      console.log('[Dataset] Sample WhatsApp Contacts seeded.');
    }

    // Log Activity
    await logActivity('SYSTEM', 'Zoro AI Co-Pilot database initialized successfully with SQLite & sample dataset.', 'INFO');
  } catch (err) {
    console.warn('[Dataset] Error seeding sample dataset:', err.message);
  }
}

async function createTables() {
  if (!pool) return;
  // Fallback for MySQL if active
}

export async function query(sql, params = []) {
  if (!isConnected) {
    const initialized = await initDatabase();
    if (!initialized) {
      throw new Error('Database not connected.');
    }
  }

  if (dbType === 'sqlite') {
    const { sql: translatedSql, params: normParams } = translateSqlForSqlite(sql, params);
    const trimmed = translatedSql.trim();
    const isSelect = /^(SELECT|PRAGMA|EXPLAIN)\b/i.test(trimmed);

    try {
      const stmt = sqliteDb.prepare(translatedSql);
      if (isSelect) {
        return stmt.all(...normParams);
      } else {
        const info = stmt.run(...normParams);
        return {
          insertId: Number(info.lastInsertRowid),
          affectedRows: info.changes,
          changedRows: info.changes,
          changes: info.changes,
          lastInsertRowid: Number(info.lastInsertRowid)
        };
      }
    } catch (err) {
      console.error(`[SQLite Error] Query failed: "${translatedSql}"`, err.message);
      throw err;
    }
  }

  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function getSetting(key, defaultValue = null) {
  try {
    const rows = await query('SELECT value FROM system_settings WHERE key_name = ?', [key]);
    if (rows && rows.length > 0) {
      return rows[0].value;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function setSetting(key, value) {
  try {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await query(
      `INSERT INTO system_settings (key_name, value) VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE value = ?`,
      [key, stringValue, stringValue]
    );
    return true;
  } catch (err) {
    console.error(`[Database Error] setSetting failed for ${key}:`, err.message);
    return false;
  }
}

export async function logActivity(module, message, level = 'INFO', metadata = null) {
  try {
    const metaJson = metadata ? JSON.stringify(metadata) : null;
    await query(
      'INSERT INTO activity_logs (module, message, level, metadata) VALUES (?, ?, ?, ?)',
      [module, message, level, metaJson]
    );
  } catch (err) {
    console.error(`[Activity Log Error]:`, err.message);
  }
}

export function getDbStatus() {
  return {
    connected: isConnected,
    type: dbType,
    host: dbType === 'sqlite' ? 'local-file' : dbConfig.host,
    port: dbType === 'sqlite' ? 0 : dbConfig.port,
    database: dbType === 'sqlite' ? 'storage/zoro.db' : dbConfig.database
  };
}

export async function getRecruitmentSetting(key, defaultValue = null) {
  try {
    const rows = await query('SELECT value FROM recruitment_settings WHERE key_name = ?', [key]);
    if (rows && rows.length > 0) {
      return rows[0].value;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function setRecruitmentSetting(key, value) {
  try {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await query(
      `INSERT INTO recruitment_settings (key_name, value) VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE value = ?`,
      [key, stringValue, stringValue]
    );
    return true;
  } catch (err) {
    console.error(`[Database Error] setRecruitmentSetting failed for ${key}:`, err.message);
    return false;
  }
}

export async function getAllRecruitmentSettings() {
  const defaults = {
    dispatch_method: 'gmail',
    smtp_host: '',
    smtp_port: '587',
    smtp_secure: 'false',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_name: 'Zoro Recruitment Hub',
    smtp_from_email: '',
    auto_reply_enabled: 'true',
    email_subject_template: 'Application Received: {applied_post} (Ref: {application_id})',
    email_body_template: `Dear {candidate_name},

Thank you for your interest in joining our organization. We have successfully received your CV/Resume application for the position of {applied_post}.

Your Application Reference Number is: {application_id}

Our Scrutiny Committee is currently reviewing submissions. Should your profile align with our institutional requirements, our recruitment desk will contact you regarding subsequent evaluation rounds.

Please retain your Application Reference ID for all future communication.

Warm regards,
Recruitment Cell`
  };

  try {
    const rows = await query('SELECT key_name, value FROM recruitment_settings');
    const settings = { ...defaults };
    if (rows && rows.length > 0) {
      for (const row of rows) {
        settings[row.key_name] = row.value;
      }
    }
    return settings;
  } catch (err) {
    return defaults;
  }
}

/**
 * Scheduled Messages Database Helpers
 */
export async function addScheduledMessage({ recipient_target, recipient_jid, message_text, send_at }) {
  const result = await query(
    `INSERT INTO scheduled_messages (recipient_target, recipient_jid, message_text, send_at, status) 
     VALUES (?, ?, ?, ?, 'PENDING')`,
    [recipient_target, recipient_jid || null, message_text, send_at]
  );
  return result?.insertId || result?.lastInsertRowid;
}

export async function getPendingScheduledMessages(nowStr) {
  return await query(
    `SELECT * FROM scheduled_messages 
     WHERE status = 'PENDING' AND send_at <= ? 
     ORDER BY send_at ASC`,
    [nowStr]
  );
}

export async function markScheduledMessageSent(id) {
  return await query(
    `UPDATE scheduled_messages 
     SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [id]
  );
}

export async function markScheduledMessageFailed(id, errorMessage) {
  return await query(
    `UPDATE scheduled_messages 
     SET status = 'FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [errorMessage, id]
  );
}

export async function listScheduledMessages(limit = 10) {
  return await query(
    `SELECT * FROM scheduled_messages 
     WHERE status = 'PENDING' 
     ORDER BY send_at ASC 
     LIMIT ?`,
    [limit]
  );
}

export async function cancelScheduledMessage(id) {
  const existing = await query(`SELECT * FROM scheduled_messages WHERE id = ?`, [id]);
  if (!existing || existing.length === 0) return null;
  await query(
    `UPDATE scheduled_messages 
     SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP 
     WHERE id = ?`,
    [id]
  );
  return existing[0];
}

