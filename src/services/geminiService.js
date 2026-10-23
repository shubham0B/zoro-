import { GoogleGenAI } from '@google/genai';
import { getSetting, logActivity } from '../database/db.js';
import { getLocalDateStr, getLocalTimeStr, getLocalDayOfWeek, getTomorrowDateStr, getFullLocalDateTimeStr } from '../utils/dateUtils.js';
import dotenv from 'dotenv';
dotenv.config();

let aiClient = null;

export async function getGeminiModel() {
  const dbModel = await getSetting('GEMINI_MODEL');
  const chosenModel = dbModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  return chosenModel;
}

export async function getGeminiClient() {
  const dbKey = await getSetting('GEMINI_API_KEY');
  const apiKey = dbKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!aiClient || aiClient.apiKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClient.apiKey = apiKey;
  }
  return aiClient;
}

/**
 * Robust wrapper that calls Gemini with automatic fallback models on 503 or overload spikes
 */
export async function callGeminiWithFallback(client, options) {
  const primaryModel = (await getGeminiModel()) || 'gemini-3.5-flash-lite';
  const candidates = [primaryModel, 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];
  const models = [...new Set(candidates)];
  let lastErr = null;

  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await client.models.generateContent({
          ...options,
          model: m
        });
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
  }
  throw lastErr;
}

/**
 * Analyzes unread/recent emails and categorizes them with AI
 */
export async function analyzeEmails(emails) {
  if (!emails || emails.length === 0) return [];
  const client = await getGeminiClient();
  if (!client) {
    console.warn('[Gemini] API Key not set. Returning basic email summaries.');
    return emails.map(e => ({
      ...e,
      priority: 'Normal',
      summary: e.snippet || 'No summary available.',
      action_required: 'None specified.'
    }));
  }

  try {
    const prompt = `
You are the Executive Chief of Staff and AI Personal Assistant to the Director of a premier University.
Analyze the following emails received by the Director.
Filter out routine marketing, spam, newsletters, or generic automated messages.
For genuine emails (from faculty, students, Vice Chancellor, Ministry/AICTE/UGC, industry partners, dignitaries), provide:
1. Priority: One of ['Urgent', 'High', 'Normal', 'Spam']
2. Summary: 1-2 sharp, executive bullet points in professional English.
3. Action Required: Clear actionable point for the Director (e.g., "Approve MoU by 3 PM", "Delegate to Dean Academics", "No action needed").

Emails Data:
${JSON.stringify(emails.map(e => ({
  id: e.id,
  from: e.from,
  subject: e.subject,
  date: e.date,
  bodySnippet: (e.body || e.snippet || '').substring(0, 800)
})), null, 2)}

Return your response strictly as valid JSON array of objects with the following keys:
[
  {
    "id": "email_id_here",
    "priority": "Urgent" | "High" | "Normal" | "Spam",
    "summary": "Executive summary text",
    "action_required": "Action item text"
  }
]
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    
    // Merge back with original email metadata
    return emails.map(email => {
      const aiData = parsed.find(p => p.id === email.id) || {};
      return {
        ...email,
        priority: aiData.priority || 'Normal',
        summary: aiData.summary || email.snippet || 'No summary',
        action_required: aiData.action_required || 'Review email'
      };
    });
  } catch (error) {
    console.error('[Gemini] Email analysis error:', error.message);
    logActivity('GEMINI', `Email analysis failed: ${error.message}`, 'ERROR');
    return emails.map(e => ({
      ...e,
      priority: 'Normal',
      summary: e.snippet || '',
      action_required: 'Review required'
    }));
  }
}

/**
 * Summarizes silent WhatsApp messages received by Director's account
 */
export async function summarizeWhatsAppChats(chats) {
  if (!chats || chats.length === 0) return { highlights: [], count: 0 };
  const client = await getGeminiClient();
  if (!client) {
    return {
      highlights: chats.slice(0, 5).map(c => `${c.sender_name || c.sender_phone}: ${c.message_text}`),
      count: chats.length
    };
  }

  try {
    const prompt = `
You are the Executive Chief of Staff for a University Director.
Review the following incoming WhatsApp messages received on the Director's phone.
Identify which ones are urgent (students, HODs, urgent requests, official meetings, VIP messages).
Ignore casual greetings, generic forwards, or spam.

Messages:
${JSON.stringify(chats.map(c => ({
  sender: c.sender_name || c.sender_phone,
  phone: c.sender_phone,
  message: c.message_text,
  time: new Date(c.timestamp * 1000).toLocaleTimeString()
})), null, 2)}

Provide:
1. An executive bulleted summary (in English/Hinglish as appropriate) of critical matters that need Director's attention or reply.
2. Flag urgent senders who require a call or reply today.

Return strictly as JSON with this structure:
{
  "urgent_alerts": ["Alert 1", "Alert 2"],
  "summary_points": ["Point 1", "Point 2"],
  "unanswered_contacts": [{"name": "Tarun", "issue": "Meeting request for 4 PM"}]
}
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    return parsed;
  } catch (error) {
    console.error('[Gemini] WhatsApp summary error:', error.message);
    return {
      urgent_alerts: [],
      summary_points: chats.slice(0, 5).map(c => `${c.sender_name}: ${c.message_text}`),
      unanswered_contacts: []
    };
  }
}

/**
 * Fetches top 3-4 trending AI, Technology, Startup & Productivity developments
 */
export async function getEdTechAndAiNews() {
  const client = await getGeminiClient();
  const persona = (await getSetting('USER_PERSONA')) || 'universal';
  const orgName = (await getSetting('ORGANIZATION_NAME')) || 'Innovation Hub';

  const defaultNews = [
    {
      title: "Autonomous Agentic AI in Modern Workflows & Decision Systems",
      source: "MIT Tech Review & ArXiv",
      takeaway: "Multi-agent systems with tool use and safety loops transforming software, operations, and communications."
    },
    {
      title: "Real-time Multimodal LLMs Bridge Edge and Omnichannel Platforms",
      source: "AI Research Digest",
      takeaway: "Sub-second inference and audio/text agents enabling hands-free assistants on mobile and chat apps."
    },
    {
      title: "Global Tech & Startup Ecosystem: Rise of Sovereign AI Micro-Hubs",
      source: "VentureBeat & TechCrunch",
      takeaway: "Specialized, local context-grounded AI tools outperforming generic models in enterprise productivity."
    }
  ];

  if (!client) return defaultNews;

  try {
    const prompt = `
You are the Strategic AI Advisor to a modern leader and innovator (${orgName}, Persona: ${persona}).
Provide exactly 3 to 4 top-notch, highly relevant, and actionable Artificial Intelligence, Tech, and Innovation breakthroughs that they MUST know today.
Focus on:
1. Agentic AI, developer breakthroughs, and automation trends.
2. High-impact tech news, startup innovations, and industry shifts.
3. Strategic productivity and future-of-work advancements.

Format strictly as a JSON array:
[
  {
    "title": "Concise Headline",
    "source": "Credible Domain / Publication",
    "takeaway": "1-2 sentences on why this matters strategically."
  }
]
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error('[Gemini] Tech news generation error:', error.message);
    return defaultNews;
  }
}

/**
 * Handles natural language chat from Director or PA
 */
export async function handleDirectorChat(query, context = {}) {
  const client = await getGeminiClient();
  if (!client) {
    return "Gemini API key is not configured yet. Please configure it in the Web Dashboard Settings.";
  }

  const assistantName = (await getSetting('ASSISTANT_NAME')) || 'Zoro AI';
  const userName = (await getSetting('USER_NAME')) || (await getSetting('DIRECTOR_NAME')) || 'Leader';
  const orgName = (await getSetting('ORGANIZATION_NAME')) || 'Zoro AI Hub';
  const persona = (await getSetting('USER_PERSONA')) || 'universal';

  try {
    const prompt = `
You are ${assistantName}, the Universal Autonomous Co-Pilot and Intelligent Companion for ${userName} (${orgName}).
Persona setting: ${persona} (adaptive mode).
You communicate crisply, proactively, respectfully, and efficiently (in English or modern conversational Hinglish matching the user's tone).

Current Context Available:
- Today's Date: ${getLocalDateStr()} (${getLocalDayOfWeek()})
- Current Time: ${getLocalTimeStr()} (IST)
- Current Full Date & Time: ${getFullLocalDateTimeStr()}
- Tomorrow's Date: ${getTomorrowDateStr()}
- Scheduled Meetings (Today & Upcoming): ${JSON.stringify(context.schedules || [])}
- Currently Pending Scheduled WhatsApp Messages: ${JSON.stringify(context.scheduledMessages || [])}
- Recent WhatsApp Messages from primary phone: ${JSON.stringify(context.whatsappMessages || [])}
- Recent Important Emails: ${JSON.stringify(context.recentEmails || [])}
- Emails Found via Live Gmail Search (Read & Unread): ${JSON.stringify(context.matchedEmails || [])}
- Pending Email Drafts: ${JSON.stringify(context.pendingDrafts || [])}
- Recent Chat Conversation History with User: ${JSON.stringify(context.conversationHistory || [])}
- WhatsApp Historical Messages Matching Query: ${JSON.stringify(context.matchedWhatsAppMessages || [])}
- Target WhatsApp Entity / Contact / Group: ${context.targetName || 'None'}
- Requested Message Count: ${context.requestedCount || 'Default'}
- Total Available Messages in Database for Target: ${context.totalFound !== undefined ? context.totalFound : (context.matchedWhatsAppMessages || []).length}

User's Message / Query: "${query}"

Instructions:
1. If the user asks to find or check emails regarding a person, email address, or topic:
   - First check "Emails Found via Live Gmail Search" and "Recent Important Emails".
   - If any emails are present, present them immediately: Sender Name/Email, Subject, Date, and Key Snippet/Summary.
   - If no personal emails are found in their inbox, state that clearly and concisely.
2. If asking about schedule/meetings (e.g. "Is tomorrow I have meeting", "What are my meetings today?"):
   - Compare the query date against "Today's Date" and "Tomorrow's Date".
   - Check "Scheduled Meetings (Today & Upcoming)" for matching dates.
   - Present scheduled meetings with time, agenda, and location!
3. If the user asks about past WhatsApp messages, requests recent chats, or asks for messages from a contact or group (e.g. "Tell me last 10 messages from yuvraj", "Tell me last 5 messages from section E", "last 10 chats of the group or the individual"):
   a) EXACT MESSAGE COUNT & HISTORY AVAILABILITY:
      - Always look at 'WhatsApp Historical Messages Matching Query' (or 'Recent WhatsApp Messages').
      - If the user requested N messages (e.g. 5 or 10):
        * If fewer than N messages exist in the database (e.g. user requested 10 messages, but only 4 total messages exist in the database):
          You MUST explicitly clarify upfront:
          "Yuvraj Sharma ki chat history mein kul yahi 4 messages hain (aur koi purane messages recorded nahi hain):"
          or "Here are all 4 messages currently recorded in your chat history with Yuvraj Sharma (no earlier messages recorded):"
        * If N messages are provided in context, output ALL N messages without cutting off, summarizing away, or omitting any!
   b) MESSAGE FORMAT & LABELS:
      - Present each message in a clean, numbered list:
        1. *[Sender Name]* ([Incoming/Outgoing]): "[Exact Message Text]" ([Time])
        Example:
        1. *Section E* (Incoming): "Start he nahi kra abhi toh 🤣" (Yesterday at 9:22 PM)
        2. *Director / You* (Outgoing): "Are bhai achha samajh gya" (Yesterday at 9:26 PM)
      - Note: Messages with is_from_me = 1 were sent BY THE USER ("Director / You" / Outgoing). Messages with is_from_me = 0 were received (Incoming).
      - If the user asks what they texted to a contact and no messages from the user (is_from_me = 1) exist, but the contact sent incoming messages (is_from_me = 0), explain clearly: "You haven't sent any messages to [Contact] recently, but [Contact] texted you: [list messages]".
      - If the user simply types a contact's name (e.g. "Yuvraj Sharma E2"), summarize their recent conversation messages and offer to send a reply for them!
   c) STRICT TIMESTAMP FORMATTING RULE:
      - ALWAYS display message timestamps using the human-readable 'time' field provided (e.g. "Yesterday at 9:22 PM", "Today at 2:30 AM", "Oct 21, 8:59 AM").
      - NEVER EVER output raw Unix numeric timestamps like "(Timestamp: 1792770752)" or any raw epoch numbers under ANY circumstances!

4. ADVANCED WHATSAPP INTENT UNDERSTANDING & MESSAGE CRAFTING:
   When the user asks to text, message, ping, or tell someone on WhatsApp (immediate delivery):
   a) Recipient Resolution:
      - Understand who the message is intended for. Check the query AND "Recent Chat Conversation History".
      - If a phone number is provided (e.g. 9309313044, +919309313044), use that phone number directly as TO.
      - If the user refers to a person by name or pronoun and previously mentioned their number, resolve to that person/number!
   b) Intelligent Message Understanding & Enhancement:
      - Direct Quotes: If user specifies exact words in quotes or explicit text, preserve the exact wording.
      - Natural Intent / Dictation: If user gives an instruction (e.g. "Tell Alex to bring the slides by 10 AM"), craft a crisp, respectful WhatsApp message.
   c) Action Output:
      ALWAYS format the action block:
      [ACTION:WHATSAPP_REPLY | TO:recipient_phone_or_name | MESSAGE:message_content]
      Accompany with a courteous 1-line lead-in confirming the action.
      Example: [ACTION:WHATSAPP_REPLY | TO:9309313044 | MESSAGE:Meeting confirmed for 4 PM]

5. SCHEDULE WHATSAPP MESSAGE (Delayed / Future Delivery):
   When the user asks to SCHEDULE a WhatsApp message to be sent at a future time or date (e.g., "Schedule a text to 9309313044 at 5:30 PM: Hello", "Schedule message to Yuvraj tomorrow at 11 AM", "Ping Alex in 15 minutes saying are you free?"):
   a) Extract recipient (phone or name) as TO.
   b) Extract target time/date as TIME (e.g. "at 5:30 PM", "tomorrow at 11 AM", "in 15 mins", "shaam 6 baje").
   c) Extract or craft the message content as MESSAGE.
   d) Output the action block:
      [ACTION:SCHEDULE_WHATSAPP | TO:recipient_phone_or_name | TIME:time_expression | MESSAGE:message_content]
      Accompany with a polite 1-line confirmation lead-in.

6. If the user asks whether any emails require immediate attention and/or asks to draft a reply (e.g. "Are there any mails which require my immediate attention if yes draft a reply"):
   - Review the emails in "Emails Found via Live Gmail Search" and "Recent Important Emails".
   - If an email requires attention (e.g. CI/build failures, pending requests, urgent messages):
     a) State clearly what the email is and why it needs attention.
     b) IMMEDIATELY output the draft action block:
        [ACTION:DRAFT_EMAIL | TO:recipient_email | SUBJECT:subject_line | BODY:body_content]
   - If none of the emails require urgent attention, state clearly that all recent emails are routine/marketing/informational, and offer to draft a reply to any specific one if they wish.
7. If the user wants to send or draft an email:
   NEVER say the email is already sent! Prepare the draft and output:
   [ACTION:DRAFT_EMAIL | TO:recipient_email | SUBJECT:subject_line | BODY:body_content]
   CRITICAL FOR EMAIL DRAFT:
   - For BODY, use clean natural paragraphs with real line breaks. Do NOT write literal "\\n".
   - Professional email structure:
     * Polite opening greeting (e.g., "Dear [Name]," or "Hi [Name],")
     * Clear, purposeful body text
     * Professional sign-off:
       Warm regards,
       Yash
   - Do NOT duplicate the email body or subject outside the action block. Only give a polite 1-line lead-in.

8. If the user asks for a Gmail report or email briefing:
   - Summarize the emails cleanly: Total New/Key Emails, numbered list of sender + subject + summary, and urgent action items.
9. If the user asks to see, get, receive, or send the briefing / report / PDF (e.g., "!briefing", "Give me report", "Give me pdf", "Report bhejo"):
   ALWAYS include the action block:
   [ACTION:SEND_BRIEFING_PDF]
   And a courteous lead-in confirming generation of the Daily Briefing PDF.
10. For general queries, answer directly with high clarity, accuracy, and speed.
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt
    });

    return typeof response.text === 'function' ? response.text() : (response.text || '');
  } catch (error) {
    console.error('[Gemini] Chat handling error:', error.message);

    // Graceful fallback if matchedEmails are available in context
    if (context && context.matchedEmails && context.matchedEmails.length > 0) {
      let emailReport = `Sir, here are the emails retrieved from your records:\n\n`;
      context.matchedEmails.slice(0, 5).forEach((e, idx) => {
        emailReport += `*${idx + 1}. ${e.subject || 'No Subject'}*\n`;
        emailReport += `• *From:* ${e.from || 'Unknown'}\n`;
        emailReport += `• *Date:* ${e.date || 'Recent'}\n`;
        if (e.snippet) emailReport += `• *Snippet:* ${e.snippet}\n`;
        emailReport += `\n`;
      });
      emailReport += `Please let me know if you would like me to draft a reply or search for another sender.`;
      return emailReport;
    }

    // Graceful fallback if upcoming schedules are available in context
    const isMeetingQuery = userQuery.toLowerCase().includes('meet') || 
                           userQuery.toLowerCase().includes('schedule') || 
                           userQuery.toLowerCase().includes('tomorrow') || 
                           userQuery.toLowerCase().includes('today');
    if (context && context.schedules && context.schedules.length > 0 && isMeetingQuery) {
      let scheduleReport = `Sir, here are your scheduled meetings:\n\n`;
      context.schedules.slice(0, 5).forEach(s => {
        scheduleReport += `📅 *${s.schedule_date}* at *${s.schedule_time || 'TBD'}*\n`;
        scheduleReport += `📌 *Agenda:* ${s.title || 'Meeting'}\n`;
        if (s.notes) scheduleReport += `📝 *Notes:* ${s.notes}\n`;
        if (s.location) scheduleReport += `📍 *Location:* ${s.location}\n`;
        scheduleReport += `\n`;
      });
      return scheduleReport;
    }

    return `Sir, the assistant service is temporarily experiencing high demand. Please try again in a few moments, or let me know if you would like me to retrieve specific emails or check your itinerary.`;
  }
}

/**
 * Drafts an executive email for verification
 */
export async function draftExecutiveEmail(instruction, recipientEmail, recipientName = '') {
  const client = await getGeminiClient();
  if (!client) {
    return {
      subject: 'Update from Yash',
      body: instruction
    };
  }

  try {
    const prompt = `
You are the executive assistant to Yash.
Write a polished, professional email based on this instruction: "${instruction}"
Recipient: ${recipientName} <${recipientEmail}>
Sign-off: Warm regards,\nYash

Return strictly as JSON:
{
  "subject": "Professional email subject line",
  "body": "Complete professional email body"
}
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error('[Gemini] Draft generation error:', error.message);
    return {
      subject: 'Message from Yash',
      body: instruction
    };
  }
}

/**
 * Synthesizes an executive Morning Brief based strictly on real institutional data
 */
export async function synthesizeEditorialBrief({
  dateStr,
  directorName = 'Yash',
  schedules = [],
  emails = [],
  chats = []
}) {
  const fallback = buildDefaultEditorialBrief({ dateStr, directorName, schedules, emails, chats });
  const client = await getGeminiClient();
  if (!client) return fallback;

  try {
    const prompt = `
You are the Private Executive Editor and Chief of Staff to Yash.
Synthesize a sharp, prestigious, and accurate daily morning intelligence brief for Yash.

CRITICAL ACCURACY REQUIREMENT:
You must STRICTLY base your briefing on the REAL institutional data provided below.
DO NOT invent or hallucinate fictional faculty, fake events, fake rupee amounts, fake student complaints, or fake city news.
DO NOT invent robotic filler text like "Open focus time for strategic university administration".
DO NOT include any outgoing emails that Yash requested to send to someone.

Real Inputs for ${dateStr}:
- Scheduled Itinerary: ${JSON.stringify(schedules)}
- Inbound Incoming Emails: ${JSON.stringify(emails.slice(0, 12))}
- Monitored Campus WhatsApp Messages: ${JSON.stringify(chats.slice(0, 15))}

Return STRICTLY valid JSON with this exact schema:
{
  "headline": "One sharp, executive headline addressing Yash (e.g. 'Yash, priority focus today on...') highlighting today's most critical scheduled meeting or priority incoming email.",
  "needsAttention": [
    {
      "title": "Clean Subject Line without emoji symbols or garbage",
      "sender": "Sender Name / Email (e.g. Railway <hello@notify.railway.app>)",
      "summary": "Crisp 1-2 sentence core message",
      "action": "Recommended next step or executive action"
    }
  ],
  "whatsappUpdates": [
    {
      "title": "Sender Name / Group / Contact",
      "body": "Concise summary of their incoming message and key issue."
    }
  ]
}
`;

    const callPromise = callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI synthesis timed out after 15s')), 15000)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);

    return {
      headline: parsed.headline || fallback.headline,
      needsAttention: Array.isArray(parsed.needsAttention) && parsed.needsAttention.length > 0 ? parsed.needsAttention : fallback.needsAttention,
      whatsappUpdates: Array.isArray(parsed.whatsappUpdates) && parsed.whatsappUpdates.length > 0 ? parsed.whatsappUpdates : fallback.whatsappUpdates
    };
  } catch (err) {
    console.warn('[Gemini] Editorial brief synthesis failed, using real fallback brief:', err.message);
    return fallback;
  }
}

/**
 * 100% Real, Data-Driven Fallback Brief (Zero hardcoded fake people, zero filler schedule blocks)
 */
function buildDefaultEditorialBrief({ dateStr, directorName = 'Yash', schedules = [], emails = [], chats = [] }) {
  // 1. Dynamic Headline based strictly on actual data
  const name = (directorName && !directorName.toLowerCase().includes('dheemant')) ? directorName : 'Yash';
  const urgentEmails = (emails || []).filter(e => e.priority === 'Urgent');
  let headline = `Your executive briefing and official daily schedule, ${name}.`;
  if (urgentEmails.length > 0 && urgentEmails[0].subject) {
    headline = `${urgentEmails[0].subject.replace(/^(Re:|Fwd:)\s*/i, '')} requires your executive attention today, ${name}.`;
  } else if (schedules.length > 0) {
    headline = `${schedules[0].title} anchors your official schedule today, ${name}.`;
  } else if (emails.length > 0) {
    headline = `${emails.length} inbound communications await your review today, ${name}.`;
  }

  // 2. Needs Attention - populated ONLY from real analyzed inbound emails with structured format
  const attentionItems = [];
  if (emails && emails.length > 0) {
    emails.forEach(em => {
      if (em.sender_email && em.sender_email.toLowerCase().includes('amit.dheemant')) return;
      const title = em.subject ? em.subject.replace(/^(Re:|Fwd:)\s*/i, '').replace(/[^\x20-\x7E]/g, '') : 'Inbound Correspondence';
      const sender = em.sender_name || em.senderName || em.sender_email || em.senderEmail || 'Sender';
      const summary = em.summary || em.snippet || 'Review requested';
      const action = em.action_required || 'Review email thread and take necessary action.';
      attentionItems.push({
        title,
        sender,
        summary,
        action
      });
    });
  }


  // 3. WhatsApp Communications - strictly from real incoming chats
  const whatsappItems = [];
  if (chats && chats.length > 0) {
    chats.slice(0, 6).forEach(c => {
      if (typeof c === 'string') {
        whatsappItems.push({
          title: "Campus Communication Alert",
          body: c
        });
      } else if (c.sender_name || c.message_text) {
        const sender = c.sender_name || c.sender_phone || 'Campus Contact';
        const msg = (c.message_text || c.ai_summary || '').slice(0, 200);
        whatsappItems.push({
          title: `WhatsApp from ${sender}${c.sender_phone ? ` (${c.sender_phone})` : ''}`,
          body: `"${msg}"`
        });
      }
    });
  }

  return {
    headline,
    needsAttention: attentionItems,
    whatsappUpdates: whatsappItems
  };
}

