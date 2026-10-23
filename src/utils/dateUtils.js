import dotenv from 'dotenv';
dotenv.config();

const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'Asia/Kolkata';

export function getTimeZone() {
  return DEFAULT_TIMEZONE;
}

/**
 * Returns YYYY-MM-DD for a given date in the local timezone (default Asia/Kolkata).
 */
export function getLocalDateStr(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/**
 * Returns formatted time e.g. "02:18 AM"
 */
export function getLocalTimeStr(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(d);
}

/**
 * Returns day of week e.g. "Saturday"
 */
export function getLocalDayOfWeek(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long'
  }).format(d);
}

/**
 * Returns tomorrow's date string YYYY-MM-DD in local timezone
 */
export function getTomorrowDateStr(timeZone = DEFAULT_TIMEZONE) {
  const tomorrow = new Date(Date.now() + 86400000);
  return getLocalDateStr(tomorrow, timeZone);
}

/**
 * Returns a human-friendly full date-time string e.g.:
 * "Saturday, Oct 24, 2026 at 02:18 AM (IST)"
 */
export function getFullLocalDateTimeStr(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(d);
  const timePart = getLocalTimeStr(d, timeZone);
  return `${datePart} at ${timePart} (IST)`;
}

/**
 * Returns Unix timestamp range [start, end] in seconds for a day name or relative date (in IST)
 */
export function getDayTimestampRange(keyword, timeZone = DEFAULT_TIMEZONE) {
  if (!keyword) return null;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const now = new Date();
  const todayStr = getLocalDateStr(now, timeZone);
  const todayDayIdx = new Date(todayStr + 'T12:00:00+05:30').getDay();
  const k = keyword.toLowerCase().trim();

  let targetDateStr = todayStr;
  let dayName = getLocalDayOfWeek(now, timeZone);

  if (k === 'yesterday' || k === 'kal') {
    const y = new Date(new Date(todayStr + 'T12:00:00+05:30').getTime() - 86400000);
    targetDateStr = getLocalDateStr(y, timeZone);
    dayName = getLocalDayOfWeek(y, timeZone);
  } else if (k === 'today' || k === 'aaj') {
    targetDateStr = todayStr;
    dayName = getLocalDayOfWeek(now, timeZone);
  } else if (days.includes(k)) {
    const targetIdx = days.indexOf(k);
    let diff = (todayDayIdx - targetIdx + 7) % 7;
    const targetD = new Date(new Date(todayStr + 'T12:00:00+05:30').getTime() - diff * 86400000);
    targetDateStr = getLocalDateStr(targetD, timeZone);
    dayName = getLocalDayOfWeek(targetD, timeZone);
  } else {
    return null;
  }

  const start = Math.floor(new Date(targetDateStr + 'T00:00:00+05:30').getTime() / 1000);
  const end = Math.floor(new Date(targetDateStr + 'T23:59:59+05:30').getTime() / 1000);
  return { start, end, targetDateStr, dayName };
}

/**
 * Formats a Unix timestamp (seconds or milliseconds) into clean, human-friendly local time in IST.
 * e.g., "Today at 2:30 AM", "Yesterday at 9:22 PM", or "Oct 21, 8:59 AM"
 */
export function formatMessageTimestamp(ts, timeZone = DEFAULT_TIMEZONE) {
  if (!ts) return 'Unknown time';
  const ms = Number(ts) < 10000000000 ? Number(ts) * 1000 : Number(ts);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return 'Unknown time';

  const now = new Date();
  const dateStr = getLocalDateStr(d, timeZone);
  const todayStr = getLocalDateStr(now, timeZone);

  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = getLocalDateStr(yesterday, timeZone);

  const timePart = getLocalTimeStr(d, timeZone);

  if (dateStr === todayStr) {
    return `Today at ${timePart}`;
  } else if (dateStr === yesterdayStr) {
    return `Yesterday at ${timePart}`;
  } else {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(d);
  }
}

/**
 * Returns current timestamp string in YYYY-MM-DD HH:mm:ss for IST
 */
export function getCurrentISTDateTimeStr(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);

  const getPart = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${getPart('year')}-${getPart('month')}-${getPart('day')} ${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;
}

/**
 * Parses user scheduling input into a normalized future IST datetime string: "YYYY-MM-DD HH:mm:ss"
 * Handles:
 * - "at 5:30 PM", "5:30pm", "17:30", "5 PM"
 * - "today at 6 PM", "tomorrow at 11 AM", "kal 10 baje", "shaam 6 baje"
 * - "in 10 minutes", "in 1 hour", "in 30 mins", "in 2 hours"
 * - "YYYY-MM-DD HH:mm:ss"
 */
export function parseTargetScheduledDateTime(inputStr, timeZone = DEFAULT_TIMEZONE) {
  if (!inputStr) return null;
  const raw = inputStr.trim();
  const lower = raw.toLowerCase();
  const now = new Date();
  const nowISTStr = getCurrentISTDateTimeStr(now, timeZone);

  // 1. Direct standard formatted string (YYYY-MM-DD HH:mm:ss or YYYY-MM-DDTHH:mm:ss)
  const fullIsoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (fullIsoMatch) {
    const [, yr, mo, dy, hr, min, sec] = fullIsoMatch;
    const isoDateTime = `${yr}-${mo}-${dy} ${hr.padStart(2, '0')}:${min.padStart(2, '0')}:${(sec || '00').padStart(2, '0')}`;
    return {
      isoDateTime,
      displayStr: `${isoDateTime} (IST)`
    };
  }

  // 2. Relative offset: "in 10 minutes", "in 1 hour", "in 30 mins", "in 45 seconds"
  const relMatch = lower.match(/\bin\s+(\d+)\s*(second|sec|s|minute|min|m|hour|hr|h)s?\b/);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    let msToAdd = 0;
    if (unit.startsWith('s')) msToAdd = amount * 1000;
    else if (unit.startsWith('m')) msToAdd = amount * 60 * 1000;
    else if (unit.startsWith('h')) msToAdd = amount * 3600 * 1000;

    const targetDate = new Date(now.getTime() + msToAdd);
    const isoDateTime = getCurrentISTDateTimeStr(targetDate, timeZone);
    const timeDisplay = getLocalTimeStr(targetDate, timeZone);
    return {
      isoDateTime,
      displayStr: `In ${amount} ${unit}${amount > 1 ? 's' : ''} (at ${timeDisplay} IST)`
    };
  }

  // 3. Natural date & time parsing
  let isTomorrow = /\b(tomorrow|kal)\b/i.test(lower);
  let isToday = /\b(today|aaj)\b/i.test(lower);

  // Time extraction
  let hours = null;
  let minutes = 0;

  // 12-hour AM/PM: e.g. "5:30 pm", "11:00 am", "5pm", "11am", "at 7:45 PM"
  const ampmMatch = lower.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const meridiem = ampmMatch[3];
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    hours = h;
    minutes = m;
  }

  // 24-hour: e.g. "17:30", "at 14:00"
  if (hours === null) {
    const militaryMatch = lower.match(/(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (militaryMatch) {
      hours = parseInt(militaryMatch[1], 10);
      minutes = parseInt(militaryMatch[2], 10);
    }
  }

  // Hindi format: e.g. "shaam 6 baje", "subah 10 baje", "5 baje", "dopahar 2 baje"
  if (hours === null) {
    const hindiMatch = lower.match(/(?:(?:subah|shaam|sham|raat|dopahar)\s+)?(\d{1,2})(?::(\d{2}))?\s*baje\b/);
    if (hindiMatch) {
      let h = parseInt(hindiMatch[1], 10);
      const m = hindiMatch[2] ? parseInt(hindiMatch[2], 10) : 0;
      if (/(shaam|sham|raat)/.test(lower) && h < 12) h += 12;
      if (/dopahar/.test(lower) && h < 12 && h >= 1 && h <= 5) h += 12;
      hours = h;
      minutes = m;
    }
  }

  if (hours === null) return null;

  // Calculate target date string
  const todayDateStr = getLocalDateStr(now, timeZone);
  const tomorrowDateStr = getTomorrowDateStr(timeZone);

  let targetDateStr = isTomorrow ? tomorrowDateStr : todayDateStr;
  const candidateIso = `${targetDateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

  // If user didn't say "today" or "tomorrow" and candidate is in past today, advance to tomorrow!
  if (!isToday && !isTomorrow && candidateIso <= nowISTStr) {
    targetDateStr = tomorrowDateStr;
    isTomorrow = true;
  }

  const finalIso = `${targetDateStr} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
  const displayHour = hours % 12 || 12;
  const displayMeridiem = hours >= 12 ? 'PM' : 'AM';
  const displayTime = `${displayHour}:${String(minutes).padStart(2, '0')} ${displayMeridiem}`;
  const dayPrefix = isTomorrow ? 'Tomorrow' : 'Today';

  return {
    isoDateTime: finalIso,
    displayStr: `${dayPrefix} at ${displayTime} (IST)`
  };
}


