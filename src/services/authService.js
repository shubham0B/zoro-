import crypto from 'crypto';
import { query, logActivity } from '../database/db.js';

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@zoro.ai';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@2026';
const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || 'Zoro Admin';

/**
 * Hash a password using scrypt with a unique salt
 */
export function hashPassword(password, salt = null) {
  const passwordSalt = salt || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, passwordSalt, 64);
  return {
    hash: derivedKey.toString('hex'),
    salt: passwordSalt
  };
}

/**
 * Verify a plain text password against stored hash & salt
 */
export function verifyPassword(password, storedHash, salt) {
  try {
    const candidateKey = crypto.scryptSync(password, salt, 64);
    const candidateHash = candidateKey.toString('hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    const candidateBuf = Buffer.from(candidateHash, 'hex');
    if (storedBuf.length !== candidateBuf.length) return false;
    return crypto.timingSafeEqual(storedBuf, candidateBuf);
  } catch (err) {
    console.error('[Auth Error] verifyPassword exception:', err.message);
    return false;
  }
}

const DEFAULT_RECRUITER_EMAIL = 'recruiter@zoro.ai';
const DEFAULT_RECRUITER_PASSWORD = 'Deepak@2026';
const DEFAULT_RECRUITER_NAME = 'Recruiter Admin';

/**
 * Seed default admin credentials if admin_users is empty or users are missing
 */
export async function seedDefaultAdmin() {
  try {
    const users = await query('SELECT id, email, role FROM admin_users LIMIT 20');
    const existingEmails = new Set(users.map(u => u.email.toLowerCase()));

    // 1. Seed / Update Admin account
    const { hash, salt } = hashPassword(DEFAULT_ADMIN_PASSWORD);
    if (!existingEmails.has(DEFAULT_ADMIN_EMAIL.toLowerCase())) {
      await query(
        `INSERT INTO admin_users (email, name, password_hash, salt, role) 
         VALUES (?, ?, ?, ?, 'director')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [DEFAULT_ADMIN_EMAIL.toLowerCase(), DEFAULT_ADMIN_NAME, hash, salt]
      );
      console.log(`[Auth] Default admin account initialized for: ${DEFAULT_ADMIN_EMAIL}`);
    } else {
      await query(
        `UPDATE admin_users SET password_hash = ?, salt = ?, name = ? WHERE LOWER(email) = ?`,
        [hash, salt, DEFAULT_ADMIN_NAME, DEFAULT_ADMIN_EMAIL.toLowerCase()]
      );
    }

    // 2. Seed Deepak Talkudar (Recruiter Admin) if missing
    if (!existingEmails.has(DEFAULT_RECRUITER_EMAIL.toLowerCase())) {
      const { hash, salt } = hashPassword(DEFAULT_RECRUITER_PASSWORD);
      await query(
        `INSERT INTO admin_users (email, name, password_hash, salt, role) 
         VALUES (?, ?, ?, ?, 'recruiter_admin')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [DEFAULT_RECRUITER_EMAIL.toLowerCase(), DEFAULT_RECRUITER_NAME, hash, salt]
      );
      console.log(`[Auth] Default recruiter admin account initialized for: ${DEFAULT_RECRUITER_EMAIL}`);
    }
  } catch (err) {
    console.error(`[Auth Error] Failed to seed default accounts:`, err.message);
  }
}

/**
 * Log in admin user, verify credentials, create session token
 */
export async function loginUser(email, password, userAgent = '', ipAddress = '') {
  if (!email || !password) {
    return { success: false, error: 'Email and password are required' };
  }

  const cleanEmail = email.trim().toLowerCase();
  const rows = await query('SELECT * FROM admin_users WHERE LOWER(email) = ? LIMIT 1', [cleanEmail]);

  if (!rows || rows.length === 0) {
    return { success: false, error: 'Invalid email address or credentials' };
  }

  const user = rows[0];
  const isValid = verifyPassword(password, user.password_hash, user.salt);

  if (!isValid) {
    await logActivity('SECURITY', `Failed login attempt for ${cleanEmail}`, 'WARN', { ip: ipAddress });
    return { success: false, error: 'Invalid email address or password' };
  }

  // Create session token (64 hex chars = 32 random bytes)
  const token = crypto.randomBytes(32).toString('hex');
  // Token valid for 30 days
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO auth_sessions (token, user_id, email, expires_at, user_agent, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [token, user.id, user.email, expiresAt, (userAgent || '').substring(0, 250), (ipAddress || '').substring(0, 60)]
  );

  await logActivity('AUTH', `Admin logged in: ${user.email}`, 'INFO', { ip: ipAddress });

  return {
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    }
  };
}

/**
 * Validate an incoming session token
 */
export async function validateSession(token) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    return null;
  }

  try {
    const rows = await query(
      `SELECT s.token, s.expires_at, u.id, u.email, u.name, u.role
       FROM auth_sessions s
       JOIN admin_users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (rows && rows.length > 0) {
      return {
        id: rows[0].id,
        email: rows[0].email,
        name: rows[0].name,
        role: rows[0].role
      };
    }
    return null;
  } catch (err) {
    console.error('[Auth Error] validateSession exception:', err.message);
    return null;
  }
}

/**
 * Terminate an active session token
 */
export async function logoutSession(token) {
  if (!token) return;
  try {
    await query('DELETE FROM auth_sessions WHERE token = ?', [token]);
  } catch (err) {
    console.error('[Auth Error] logoutSession error:', err.message);
  }
}

/**
 * Change password for an authenticated user
 */
export async function changeUserPassword(userId, currentPassword, newPassword) {
  if (!userId) {
    return { success: false, error: 'Unauthorized request' };
  }
  if (!currentPassword) {
    return { success: false, error: 'Current password is required' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters long' };
  }

  const rows = await query('SELECT * FROM admin_users WHERE id = ? LIMIT 1', [userId]);
  if (!rows || rows.length === 0) {
    return { success: false, error: 'User account not found' };
  }

  const user = rows[0];
  const isCurrentValid = verifyPassword(currentPassword, user.password_hash, user.salt);
  if (!isCurrentValid) {
    return { success: false, error: 'Current password entered is incorrect' };
  }

  // Hash new password with new salt
  const { hash, salt } = hashPassword(newPassword);
  await query(
    'UPDATE admin_users SET password_hash = ?, salt = ?, updated_at = NOW() WHERE id = ?',
    [hash, salt, userId]
  );

  await logActivity('SECURITY', `Password successfully updated for user ${user.email}`, 'INFO');

  return {
    success: true,
    message: 'Password updated successfully. You can now use your new password.'
  };
}

/**
 * Update email address and/or display name for an authenticated user
 */
export async function updateUserProfile(userId, newEmail, newName) {
  if (!userId) {
    return { success: false, error: 'Unauthorized request' };
  }
  if (!newEmail || !newEmail.includes('@')) {
    return { success: false, error: 'A valid email address is required' };
  }

  const cleanEmail = newEmail.trim().toLowerCase();
  const cleanName = (newName || '').trim();

  // Check if another user already uses this email
  const existing = await query('SELECT id FROM admin_users WHERE LOWER(email) = ? AND id != ? LIMIT 1', [cleanEmail, userId]);
  if (existing && existing.length > 0) {
    return { success: false, error: 'This email address is already assigned to another account' };
  }

  await query(
    'UPDATE admin_users SET email = ?, name = COALESCE(NULLIF(?, ""), name), updated_at = NOW() WHERE id = ?',
    [cleanEmail, cleanName, userId]
  );

  // Sync active sessions email
  await query('UPDATE auth_sessions SET email = ? WHERE user_id = ?', [cleanEmail, userId]);

  const [updated] = await query('SELECT id, email, name, role FROM admin_users WHERE id = ? LIMIT 1', [userId]);

  await logActivity('SECURITY', `Profile updated for user ID ${userId}: ${cleanEmail}`, 'INFO');

  return {
    success: true,
    message: 'Profile updated successfully',
    user: updated
  };
}

/**
 * Add a new team member/recruiter
 */
export async function addTeamMember(requester, { email, name, password, role = 'recruiter' }) {
  if (!requester || (requester.role !== 'recruiter_admin' && requester.role !== 'director')) {
    return { success: false, error: 'Unauthorized: Only recruiter administrator can add team members' };
  }

  if (!email || !email.includes('@')) {
    return { success: false, error: 'A valid email address is required' };
  }
  if (!password || password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters long' };
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName = (name || 'Recruiter').trim();
  const assignedRole = requester.role === 'director' ? (role || 'recruiter') : 'recruiter';

  // Check duplicate
  const existing = await query('SELECT id FROM admin_users WHERE LOWER(email) = ? LIMIT 1', [cleanEmail]);
  if (existing && existing.length > 0) {
    return { success: false, error: 'An account with this email address already exists' };
  }

  const { hash, salt } = hashPassword(password);
  const result = await query(
    `INSERT INTO admin_users (email, name, password_hash, salt, role)
     VALUES (?, ?, ?, ?, ?)`,
    [cleanEmail, cleanName, hash, salt, assignedRole]
  );

  await logActivity('AUTH', `New team member added: ${cleanEmail} (${assignedRole}) by ${requester.email}`, 'INFO');

  return {
    success: true,
    message: `Team member ${cleanName} added successfully.`,
    user: {
      id: result.insertId,
      email: cleanEmail,
      name: cleanName,
      role: assignedRole
    }
  };
}

/**
 * List team members for the Recruitment Portal
 */
export async function getTeamMembers() {
  try {
    const rows = await query(
      `SELECT id, email, name, role, created_at, updated_at
       FROM admin_users
       WHERE role IN ('recruiter_admin', 'recruiter')
       ORDER BY created_at ASC`
    );
    return rows;
  } catch (err) {
    console.error('[Auth Error] getTeamMembers error:', err.message);
    return [];
  }
}

/**
 * Delete a recruiter team member
 */
export async function deleteTeamMember(memberId, requester) {
  if (!requester || (requester.role !== 'recruiter_admin' && requester.role !== 'director')) {
    return { success: false, error: 'Unauthorized: Only administrators can manage team members' };
  }

  if (parseInt(memberId) === parseInt(requester.id)) {
    return { success: false, error: 'Cannot delete your own active account' };
  }

  const targetUsers = await query('SELECT id, email, role FROM admin_users WHERE id = ? LIMIT 1', [memberId]);
  if (!targetUsers || targetUsers.length === 0) {
    return { success: false, error: 'Team member not found' };
  }

  const target = targetUsers[0];
  if (target.role === 'director') {
    return { success: false, error: 'Cannot delete director account' };
  }

  await query('DELETE FROM admin_users WHERE id = ?', [memberId]);
  await logActivity('AUTH', `Team member removed: ${target.email} by ${requester.email}`, 'INFO');

  return {
    success: true,
    message: `Team member ${target.email} has been removed successfully.`
  };
}

