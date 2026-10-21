import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

let pool = null;
let isConnected = false;

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

export async function initDatabase() {
  try {
    // First connect without database to create database if it does not exist
    const rootConnection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password
    });

    await rootConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await rootConnection.end();

    // Now initialize the pool
    pool = mysql.createPool(dbConfig);

    // Test connection
    const connection = await pool.getConnection();
    connection.release();
    isConnected = true;
    console.log(`[Database] Connected successfully to MySQL database "${dbConfig.database}"`);

    // Create required tables
    await createTables();
    return true;
  } catch (error) {
    isConnected = false;
    console.error(`[Database Error] Failed to connect to MySQL:`, error.message);
    return false;
  }
}

async function createTables() {
  if (!pool) return;

  const tables = [
    // System Settings Table
    `CREATE TABLE IF NOT EXISTS \`system_settings\` (
      \`key_name\` VARCHAR(100) PRIMARY KEY,
      \`value\` TEXT,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Google Tokens Table for Director Gmail OAuth
    `CREATE TABLE IF NOT EXISTS \`google_tokens\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`email\` VARCHAR(255) NOT NULL,
      \`refresh_token\` TEXT,
      \`access_token\` TEXT,
      \`expiry_date\` BIGINT,
      \`scope\` TEXT,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Schedules & Meetings Table (Entered by PA or WhatsApp)
    `CREATE TABLE IF NOT EXISTS \`schedules\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`date\` DATE NOT NULL,
      \`time_slot\` VARCHAR(50) NOT NULL,
      \`title\` VARCHAR(255) NOT NULL,
      \`description\` TEXT,
      \`location\` VARCHAR(255) DEFAULT 'Director Office / Online',
      \`priority\` VARCHAR(20) DEFAULT 'Normal',
      \`created_by\` VARCHAR(50) DEFAULT 'PA',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // WhatsApp Chats Cache Table (Silent listener of Director's phone)
    `CREATE TABLE IF NOT EXISTS \`whatsapp_chats\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`msg_id\` VARCHAR(150) UNIQUE,
      \`chat_jid\` VARCHAR(100) NOT NULL,
      \`sender_name\` VARCHAR(150),
      \`sender_phone\` VARCHAR(50),
      \`message_text\` TEXT,
      \`timestamp\` BIGINT NOT NULL,
      \`is_from_me\` BOOLEAN DEFAULT FALSE,
      \`ai_summary\` TEXT,
      \`ai_urgency\` VARCHAR(20) DEFAULT 'Normal',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_chat_jid\` (\`chat_jid\`),
      INDEX \`idx_timestamp\` (\`timestamp\`)
    ) ENGINE=InnoDB;`,

    // WhatsApp Synced Contacts Table
    `CREATE TABLE IF NOT EXISTS \`whatsapp_contacts\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`jid\` VARCHAR(100) UNIQUE,
      \`phone\` VARCHAR(50),
      \`name\` VARCHAR(150),
      \`notify\` VARCHAR(150),
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX \`idx_phone\` (\`phone\`),
      INDEX \`idx_name\` (\`name\`)
    ) ENGINE=InnoDB;`,

    // Email Summaries Table (Analyzed from Gmail API)
    `CREATE TABLE IF NOT EXISTS \`email_summaries\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`gmail_id\` VARCHAR(100) UNIQUE,
      \`sender_email\` VARCHAR(255),
      \`sender_name\` VARCHAR(150),
      \`subject\` VARCHAR(500),
      \`snippet\` TEXT,
      \`date_received\` VARCHAR(100),
      \`priority\` VARCHAR(20) DEFAULT 'Normal',
      \`summary\` TEXT,
      \`action_required\` TEXT,
      \`is_processed\` BOOLEAN DEFAULT FALSE,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_priority\` (\`priority\`),
      INDEX \`idx_gmail_id\` (\`gmail_id\`)
    ) ENGINE=InnoDB;`,

    // Email Drafts Table (Director Command with Confirmation)
    `CREATE TABLE IF NOT EXISTS \`email_drafts\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`recipient_email\` VARCHAR(255) NOT NULL,
      \`recipient_name\` VARCHAR(150),
      \`subject\` VARCHAR(500) NOT NULL,
      \`body\` TEXT NOT NULL,
      \`status\` ENUM('PENDING_VERIFICATION', 'VERIFIED_SENT', 'CANCELLED') DEFAULT 'PENDING_VERIFICATION',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`sent_at\` TIMESTAMP NULL,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Daily Executive Briefings Table
    `CREATE TABLE IF NOT EXISTS \`briefings\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`briefing_date\` DATE UNIQUE,
      \`pdf_filename\` VARCHAR(255),
      \`summary_text\` MEDIUMTEXT,
      \`edtech_news\` JSON,
      \`is_sent_to_director\` BOOLEAN DEFAULT FALSE,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Activity Logs Table for Dashboard Feed
    `CREATE TABLE IF NOT EXISTS \`activity_logs\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`level\` VARCHAR(20) DEFAULT 'INFO',
      \`module\` VARCHAR(50) NOT NULL,
      \`message\` TEXT NOT NULL,
      \`metadata\` JSON,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX \`idx_created_at\` (\`created_at\`)
    ) ENGINE=InnoDB;`,

    // Administrator & Executive Login Users
    `CREATE TABLE IF NOT EXISTS \`admin_users\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`email\` VARCHAR(255) NOT NULL UNIQUE,
      \`name\` VARCHAR(150) DEFAULT 'Director',
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`salt\` VARCHAR(64) NOT NULL,
      \`role\` VARCHAR(50) DEFAULT 'director',
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX \`idx_user_email\` (\`email\`)
    ) ENGINE=InnoDB;`,

    // Auth Sessions & Active Tokens
    `CREATE TABLE IF NOT EXISTS \`auth_sessions\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`token\` VARCHAR(128) NOT NULL UNIQUE,
      \`user_id\` INT NOT NULL,
      \`email\` VARCHAR(255) NOT NULL,
      \`expires_at\` TIMESTAMP NOT NULL,
      \`user_agent\` VARCHAR(255),
      \`ip_address\` VARCHAR(64),
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX \`idx_session_token\` (\`token\`),
      INDEX \`idx_session_expires\` (\`expires_at\`),
      FOREIGN KEY (\`user_id\`) REFERENCES \`admin_users\`(\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB;`,

    // Recruitment System Configuration
    `CREATE TABLE IF NOT EXISTS \`recruitment_settings\` (
      \`key_name\` VARCHAR(100) PRIMARY KEY,
      \`value\` TEXT,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Separate Google OAuth Tokens for Recruitment / Hiring Mailbox
    `CREATE TABLE IF NOT EXISTS \`recruitment_tokens\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`email\` VARCHAR(255) NOT NULL UNIQUE,
      \`refresh_token\` TEXT,
      \`access_token\` TEXT,
      \`expiry_date\` BIGINT,
      \`scope\` TEXT,
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;`,

    // Candidate Job & Resume Applications
    `CREATE TABLE IF NOT EXISTS \`candidate_applications\` (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`application_id\` VARCHAR(50) UNIQUE,
      \`gmail_message_id\` VARCHAR(150) UNIQUE,
      \`candidate_email\` VARCHAR(255) NOT NULL,
      \`candidate_name\` VARCHAR(150),
      \`candidate_phone\` VARCHAR(50),
      \`applied_post\` VARCHAR(255),
      \`experience_years\` VARCHAR(50),
      \`skills\` TEXT,
      \`ai_summary\` TEXT,
      \`has_resume_attachment\` BOOLEAN DEFAULT TRUE,
      \`resume_filenames\` TEXT,
      \`confirmation_status\` ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED') DEFAULT 'PENDING',
      \`confirmation_method\` VARCHAR(50) DEFAULT 'GMAIL_OAUTH',
      \`confirmation_sent_at\` TIMESTAMP NULL,
      \`confirmation_error\` TEXT,
      \`email_subject\` VARCHAR(500),
      \`email_snippet\` TEXT,
      \`email_date\` VARCHAR(100),
      \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX \`idx_app_email\` (\`candidate_email\`),
      INDEX \`idx_app_status\` (\`confirmation_status\`),
      INDEX \`idx_app_post\` (\`applied_post\`),
      INDEX \`idx_app_created\` (\`created_at\`)
    ) ENGINE=InnoDB;`
  ];

  for (const tableSql of tables) {
    try {
      await pool.query(tableSql);
    } catch (err) {
      console.error(`[Database Error] Error creating table:`, err.message);
    }
  }

  // Safe ALTER TABLE migrations to ensure updated_at exists on older installations
  const safeAlterColumns = [
    `ALTER TABLE email_drafts ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    `ALTER TABLE google_tokens ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    `ALTER TABLE whatsapp_chats ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    `ALTER TABLE schedules ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    `ALTER TABLE briefings ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    `ALTER TABLE email_summaries ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
  ];

  for (const alterSql of safeAlterColumns) {
    try {
      await pool.query(alterSql);
    } catch (err) {
      // Column already exists or table not ready, safely ignore
    }
  }

  // Seed default admin credentials
  try {
    const { seedDefaultAdmin } = await import('../services/authService.js');
    await seedDefaultAdmin();
  } catch (err) {
    console.error('[Database Error] Failed to seed default admin:', err.message);
  }

  // Clean separation: Purge any recruitment/candidate emails from Director's email_summaries & google_tokens
  try {
    await pool.query(`
      DELETE FROM email_summaries 
      WHERE sender_email LIKE '%careers%' 
         OR sender_email LIKE '%recruitment%' 
         OR sender_email LIKE '%jecrchospital%' 
         OR subject LIKE '%application for%' 
         OR subject LIKE '%curriculum vitae%' 
         OR summary LIKE '%candidate%'
    `);
    await pool.query(`
      DELETE FROM google_tokens 
      WHERE email LIKE '%careers.jecrchospital%' 
         OR email IN (SELECT email FROM recruitment_tokens)
    `);
  } catch (cleanErr) {
    // Non-critical cleanup
  }

  console.log(`[Database] All MySQL tables verified/created successfully.`);
}

export async function query(sql, params = []) {
  if (!pool) {
    const initialized = await initDatabase();
    if (!initialized) {
      throw new Error('Database not connected. Please verify MySQL is running.');
    }
  }
  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function getSetting(key, defaultValue = null) {
  try {
    const rows = await query('SELECT value FROM system_settings WHERE key_name = ?', [key]);
    if (rows.length > 0) {
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
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database
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
    dispatch_method: 'gmail', // 'gmail' or 'smtp'
    smtp_host: '',
    smtp_port: '587',
    smtp_secure: 'false',
    smtp_user: '',
    smtp_pass: '',
    smtp_from_name: 'JECRC University Recruitment Office',
    smtp_from_email: '',
    auto_reply_enabled: 'true',
    email_subject_template: 'Application Received: {applied_post} at JECRC University (Ref: {application_id})',
    email_body_template: `Dear {candidate_name},

Thank you for your interest in joining JECRC University. We have successfully received your CV/Resume application for the position of {applied_post}.

Your Application Reference Number is: {application_id}

Our Selection & Scrutiny Committee is currently reviewing candidate submissions. Should your profile and academic qualifications align with our institutional requirements, our recruitment desk will contact you regarding subsequent evaluation or interview rounds.

Please retain your Application Reference ID for all future communication.

Warm regards,
Human Resources & Recruitment Cell
JECRC University, Jaipur
Website: https://jecrcuniversity.edu.in`
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

