import { query, logActivity } from '../database/db.js';
import { getLocalDateStr, getLocalTimeStr, getLocalDayOfWeek, getTomorrowDateStr, getFullLocalDateTimeStr } from '../utils/dateUtils.js';

export async function addSchedule({ date, time_slot, title, description = '', location = "Director's Office", priority = 'Normal', created_by = 'PA' }) {
  const scheduleDate = date || getLocalDateStr();
  const result = await query(
    `INSERT INTO schedules (date, time_slot, title, description, location, priority, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [scheduleDate, time_slot, title, description, location, priority, created_by]
  );
  await logActivity('SCHEDULE', `New meeting scheduled: ${title} on ${scheduleDate} at ${time_slot}`, 'INFO');
  return result.insertId;
}

export async function getSchedulesByDate(date) {
  const formattedDate = date instanceof Date ? getLocalDateStr(date) : (date || getLocalDateStr());
  return await query(
    `SELECT * FROM schedules WHERE date = ? ORDER BY time_slot ASC`,
    [formattedDate]
  );
}

export async function getUpcomingSchedules() {
  const today = getLocalDateStr();
  return await query(
    `SELECT * FROM schedules WHERE date >= ? ORDER BY date ASC, time_slot ASC LIMIT 20`,
    [today]
  );
}

export async function deleteSchedule(id) {
  return await query(`DELETE FROM schedules WHERE id = ?`, [id]);
}

/**
 * Parses PA's text message into structured schedules.
 * Format examples:
 * "!schedule 10:00 AM - HOD Meet; 02:00 PM - AI Lab Review"
 * "Tomorrow schedule: 11am Exam Board, 3pm Dean Council"
 */
export async function parseScheduleFromText(text, targetDate = null) {
  const dateToUse = targetDate || getLocalDateStr();
  const cleaned = text.replace(/^!schedule\s*/i, '').trim();
  const items = cleaned.split(/;|\n/);
  const added = [];

  for (const item of items) {
    if (!item.trim()) continue;
    const parts = item.split(/-|:/);
    let timeSlot = 'TBD';
    let title = item.trim();

    if (item.includes('-')) {
      const splitDash = item.split('-');
      timeSlot = splitDash[0].trim();
      title = splitDash.slice(1).join('-').trim();
    }

    const id = await addSchedule({
      date: dateToUse,
      time_slot: timeSlot,
      title: title || 'Scheduled Discussion',
      created_by: 'PA via WhatsApp'
    });
    added.push({ id, time_slot: timeSlot, title });
  }

  return added;
}

/**
 * Uses Gemini AI to understand natural language schedule commands from the PA
 */
export async function parseScheduleIntentWithAI(text, referenceDate = null) {
  const ref = referenceDate || getLocalDateStr();
  const dayOfWeek = getLocalDayOfWeek();
  const tomorrowStr = getTomorrowDateStr();
  const currentTime = getLocalTimeStr();

  try {
    const { getGeminiClient, callGeminiWithFallback } = await import('./geminiService.js');
    const client = await getGeminiClient();
    if (!client) return null;

    const prompt = `
You are the Executive Scheduling Assistant for a University Director's office.
The Director's PA is messaging on WhatsApp to manage the Director's calendar.

Current Context:
- Today's Date: ${ref} (${dayOfWeek})
- Current Time: ${currentTime} (IST)
- Tomorrow's Date: ${tomorrowStr}

PA's WhatsApp Message: "${text}"

Determine the PA's intent:
1. "ADD_MEETING": PA is instructing to add, schedule, or record a meeting (e.g. "Thoolle there is meeting tomorrow at 7 pm , this is very important meet", "Schedule time-7pm Meeting title-thoolle", "Kal 3 baje Dean ke saath meet hai").
2. "VIEW_SCHEDULE": PA is asking to view or check scheduled meetings (e.g. "What is today's schedule?", "Kal ki meetings dikhao", "Show appointments").
3. "GENERAL_QUERY": General chit-chat or question not related to meetings.

If ADD_MEETING:
- date: YYYY-MM-DD (resolve "tomorrow" to ${tomorrowStr}, "today" to ${ref}, or specific dates)
- time_slot: clear time string (e.g. "07:00 PM" or "10:30 AM")
- title: concise meeting title (e.g. "Meeting with Thoolle")
- description: any notes or attendee details
- priority: "Urgent" (if very important/critical), "High", or "Normal"
- location: location or "Director's Office"

If VIEW_SCHEDULE:
- date: YYYY-MM-DD to check (default to ${ref})

Output strictly in JSON:
{
  "intent": "ADD_MEETING" | "VIEW_SCHEDULE" | "GENERAL_QUERY",
  "meeting": {
    "date": "YYYY-MM-DD",
    "time_slot": "07:00 PM",
    "title": "Meeting with Thoolle",
    "description": "Very important meet",
    "priority": "Urgent",
    "location": "Director's Office"
  },
  "viewDate": "YYYY-MM-DD",
  "message": "Friendly response if general query"
}
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const raw = typeof response.text === 'function' ? response.text() : (response.text || '');
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Schedule AI] Failed to parse PA schedule intent:', err.message);
    return null;
  }
}

