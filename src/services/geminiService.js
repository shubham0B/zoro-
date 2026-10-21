import { GoogleGenAI } from '@google/genai';
import { getSetting, logActivity } from '../database/db.js';
import dotenv from 'dotenv';
dotenv.config();

let aiClient = null;

export async function getGeminiModel() {
  const dbModel = await getSetting('GEMINI_MODEL');
  const chosenModel = dbModel || process.env.GEMINI_MODEL || 'gemini-3.7-flash';
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
  const primaryModel = (await getGeminiModel()) || 'gemini-3.7-flash';
  const candidates = [primaryModel, 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'];
  const models = [...new Set(candidates)];
  let lastErr = null;

  for (const m of models) {
    try {
      const res = await client.models.generateContent({
        ...options,
        model: m
      });
      return res;
    } catch (err) {
      console.warn(`[Gemini] Model ${m} spike/error: ${err.message.slice(0, 90)}. Trying fallback...`);
      lastErr = err;
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
 * Fetches top 3-4 trending EdTech & Higher Education AI developments
 */
export async function getEdTechAndAiNews() {
  const client = await getGeminiClient();
  const defaultNews = [
    {
      title: "Agentic AI in Higher Education Curricula",
      source: "EdTech Global & NEP 2020 Insights",
      takeaway: "Top universities integrating autonomous AI workflows into engineering and management pedagogy for industry alignment."
    },
    {
      title: "UGC / AICTE Framework on Generative AI & Academic Integrity",
      source: "Regulatory Updates",
      takeaway: "New institutional guidelines on ethical AI adoption, intellectual property, and research publication compliance."
    },
    {
      title: "Campus-Wide Personalized Learning via LLM Tutors",
      source: "Higher Education Tech Review",
      takeaway: "Institutions reporting 25% improvement in foundational STEM courses through adaptive 24/7 AI teaching assistants."
    }
  ];

  if (!client) return defaultNews;

  try {
    const prompt = `
You are the Chief AI Strategic Advisor to a University Director.
Provide exactly 3 to 4 top-notch, highly relevant, and actionable EdTech & Artificial Intelligence news/trends that a University Director MUST know today.
Focus on:
1. Higher Education AI implementation & research funding.
2. NEP / UGC / AICTE policy advancements or global academic tech breakthroughs.
3. Student placement and industry-academia AI partnerships.

Format strictly as a JSON array:
[
  {
    "title": "Concise Headline",
    "source": "Credible Domain / Publication",
    "takeaway": "1-2 sentences on why this matters strategically to the Director and the university."
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
    console.error('[Gemini] EdTech news generation error:', error.message);
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

  try {
    const prompt = `
You are the AI Executive Chief of Staff to the University Director.
You communicate respectfully, crisply, and efficiently (English or professional Hinglish matching Director's tone).

Current Context Available:
- Today's Date: ${new Date().toISOString().split('T')[0]}
- Tomorrow's Date: ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}
- Scheduled Meetings (Today & Upcoming): ${JSON.stringify(context.schedules || [])}
- Recent WhatsApp Messages from Director's phone: ${JSON.stringify(context.whatsappMessages || [])}
- Recent Important Emails: ${JSON.stringify(context.recentEmails || [])}
- Emails Found via Live Gmail Search (Read & Unread): ${JSON.stringify(context.matchedEmails || [])}
- Pending Email Drafts: ${JSON.stringify(context.pendingDrafts || [])}
- Recent Chat Conversation History with Director: ${JSON.stringify(context.conversationHistory || [])}
- WhatsApp Historical Messages Matching Query: ${JSON.stringify(context.matchedWhatsAppMessages || [])}

Director's Message / Query: "${query}"

Instructions:
1. If the Director asks to find or check emails regarding a person, email address, or topic (e.g. "Dheemant", "Amitdheemant@jecrcu.edu.in", "IIT Bombay", "Techfest"):
   - First check "Emails Found via Live Gmail Search" and "Recent Important Emails".
   - If any emails are present (even if marked read in Gmail), present them immediately: Sender Name/Email, Subject, Date, and Key Snippet/Summary.
   - If no personal emails are found in their inbox, state that clearly, and if applicable provide official public directory contact details.
2. If asking about schedule/meetings (e.g. "Is tomorrow I have meeting", "What are my meetings today?"):
   - Compare the query date against "Today's Date" and "Tomorrow's Date".
   - Check "Scheduled Meetings (Today & Upcoming)" for matching dates.
   - If a meeting exists for tomorrow (e.g. "Meeting with Yuvraj"), tell the Director immediately with time, agenda, and details!
3. If the Director asks about old/past WhatsApp messages, or what someone texted on WhatsApp (e.g., 'Can you read old chats?', 'Tarun ne kya text kiya?', 'Check WhatsApp messages from Yuvraj'):
   - Check 'WhatsApp Historical Messages Matching Query' and 'Recent WhatsApp Messages'.
   - If past messages exist, summarize them factually with sender, date/time, and content.
   - If no messages are found for that person in database, answer: 'Sir, our local WhatsApp history database currently has no saved messages from [Name]. When Director WhatsApp is linked, recent past messages synced by WhatsApp are archived here for instant lookup.'
4. ADVANCED WHATSAPP INTENT UNDERSTANDING & MESSAGE CRAFTING:
   When the Director asks to text, message, ping, or tell someone on WhatsApp (in English, Hindi, Hinglish, informal dictation, or raw phrases):
   a) Recipient Resolution:
      - Understand who the message is intended for. Check the query AND "Recent Chat Conversation History with Director".
      - If a phone number is provided (e.g. 9309313044, +919309313044), use that phone number directly as TO.
      - If the Director refers to a person by name or pronoun ("yuvraj", "him", "them", "is number pe", "unko") and previously mentioned their number, resolve to that person/number!
      - NEVER claim a phone number is invalid or cannot be found! The backend system dispatches directly to any valid mobile number.
   b) Intelligent Message Understanding & Enhancement:
      - Direct Quotes: If the Director specifies exact words in quotes (e.g. 'kaha hai kutte') or explicit casual text, preserve the Director's direct wording.
      - Natural Intent / Dictation: If the Director gives an instruction (e.g. "Tell Yuvraj to bring the syllabus by 10 AM", "Kashish ko bolo form check kar le"), understand the intent and craft a crisp, respectful, professional WhatsApp message from the Director.
      - Raw Hinglish / Conversational: Intelligently extract the intended message.
   c) Action Output:
      ALWAYS format the action block:
      [ACTION:WHATSAPP_REPLY | TO:recipient_phone_or_name | MESSAGE:message_content]
      Accompany with a courteous 1-line lead-in confirming the dispatch.
      Example: [ACTION:WHATSAPP_REPLY | TO:9309313044 | MESSAGE:kaha hai kutte]
5. If the Director wants to send an email (e.g. "Tarun ko email bhej do...", "Send email to..."):
   NEVER say the email is already sent! Prepare the draft and output:
   [ACTION:DRAFT_EMAIL | TO:recipient_email | SUBJECT:subject_line | BODY:body_content]
   CRITICAL FOR EMAIL DRAFT:
   - For BODY, use clean natural paragraphs with real line breaks. Do NOT write literal "\n" or escaped slashes.
   - Do NOT duplicate the email body or subject outside the action block. Only give a polite 1-line lead-in like:
     "Sir, I have prepared the email draft for your review:"
6. If the Director asks for a Gmail report or email briefing (e.g., "give me the gmail today report", "today email report", "gmail report", "check emails", "unread emails"):
   - CRITICAL DATA SEPARATION: Recruitment and candidate applications are handled in a separate system. NEVER mention or merge recruiter team emails, candidate applications, resumes, or hospital recruitment data here.
   - Present ONLY genuine executive/university emails belonging to the Director's connected email.
   - Summarize the emails cleanly:
     * 📧 *Total New/Key Emails*
     * Numbered list with: *Sender*, *Subject*, *Time/Date*, and a 1-line *Key Summary*
     * Any *Urgent Action Items* required from the Director.
7. If the Director asks to see, get, receive, or send the executive report / briefing / PDF (e.g., "Give me the report", "Give me pdf", "Give me here", "Send the PDF here", "Report bhejo", "PDF document do"):
   ALWAYS include the action block:
   [ACTION:SEND_BRIEFING_PDF]
   And a courteous lead-in: "Sir, I am generating your real-time Executive Daily Briefing PDF and sending the document directly here on WhatsApp right now."
8. For general queries, answer directly with executive clarity.
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
 * Drafts an executive email for Director's verification
 */
export async function draftExecutiveEmail(instruction, recipientEmail, recipientName = '') {
  const client = await getGeminiClient();
  if (!client) {
    return {
      subject: 'University Update',
      body: instruction
    };
  }

  try {
    const prompt = `
You are the University Director's executive assistant.
Write a polished, professional email based on this instruction: "${instruction}"
Recipient: ${recipientName} <${recipientEmail}>
Sign-off: Office of the Director, University

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
      subject: 'Message from Office of the Director',
      body: instruction
    };
  }
}

/**
 * Synthesizes an executive Morning Brief based strictly on real institutional data
 */
export async function synthesizeEditorialBrief({
  dateStr,
  directorName = 'Dheemant',
  schedules = [],
  emails = [],
  chats = [],
  edTechNews = []
}) {
  const fallback = buildDefaultEditorialBrief({ dateStr, directorName, schedules, emails, chats, edTechNews });
  const client = await getGeminiClient();
  if (!client) return fallback;

  try {
    const prompt = `
You are the Private Executive Editor and Chief of Staff to Director ${directorName}.
Synthesize a sharp, prestigious, and accurate daily morning intelligence brief for the Director.

CRITICAL ACCURACY REQUIREMENT:
You must STRICTLY base your briefing on the REAL institutional data provided below.
DO NOT invent or hallucinate fictional faculty, fake events, fake rupee amounts, fake student complaints, or fake city news.
DO NOT invent robotic filler text like "Open focus time for strategic university administration".
DO NOT include any outgoing emails that the Director requested to send to someone.

Real Inputs for ${dateStr}:
- Scheduled Itinerary: ${JSON.stringify(schedules)}
- Inbound Incoming Emails: ${JSON.stringify(emails.slice(0, 12))}
- Monitored Campus WhatsApp Messages: ${JSON.stringify(chats.slice(0, 15))}
- AI & Higher Ed Intelligence: ${JSON.stringify(edTechNews)}

Return STRICTLY valid JSON with this exact schema:
{
  "headline": "One sharp, executive headline addressing Director ${directorName} highlighting today's most critical scheduled meeting or priority incoming email.",
  "needsAttention": [
    {
      "title": "Email Subject / Critical Topic",
      "body": "Sender name, concise 1-2 sentence summary of what they wrote, and recommended executive action."
    }
  ],
  "whatsappUpdates": [
    {
      "title": "Sender Name / Contact",
      "body": "Concise summary of their incoming message and key issue."
    }
  ],
  "aiEdTech": [
    {
      "title": "Strategic Trend Title",
      "body": "Actionable takeaway for university leadership and curriculum strategy."
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
      whatsappUpdates: Array.isArray(parsed.whatsappUpdates) && parsed.whatsappUpdates.length > 0 ? parsed.whatsappUpdates : fallback.whatsappUpdates,
      aiEdTech: Array.isArray(parsed.aiEdTech) && parsed.aiEdTech.length > 0 ? parsed.aiEdTech : fallback.aiEdTech
    };
  } catch (err) {
    console.warn('[Gemini] Editorial brief synthesis failed, using real fallback brief:', err.message);
    return fallback;
  }
}

/**
 * 100% Real, Data-Driven Fallback Brief (Zero hardcoded fake people, zero filler schedule blocks)
 */
function buildDefaultEditorialBrief({ dateStr, directorName, schedules = [], emails = [], chats = [], edTechNews = [] }) {
  // 1. Dynamic Headline based strictly on actual data
  const urgentEmails = (emails || []).filter(e => e.priority === 'Urgent');
  let headline = `Your executive briefing and official daily schedule, ${directorName}.`;
  if (urgentEmails.length > 0 && urgentEmails[0].subject) {
    headline = `${urgentEmails[0].subject.replace(/^(Re:|Fwd:)\s*/i, '')} requires your executive attention today, ${directorName}.`;
  } else if (schedules.length > 0) {
    headline = `${schedules[0].title} anchors your official schedule today, ${directorName}.`;
  } else if (emails.length > 0) {
    headline = `${emails.length} inbound communications await your review today, ${directorName}.`;
  }

  // 2. Needs Attention - populated ONLY from real analyzed inbound emails
  const attentionItems = [];
  if (emails && emails.length > 0) {
    emails.forEach(em => {
      // Exclude emails sent by Director or self
      if (em.sender_email && em.sender_email.toLowerCase().includes('amit.dheemant')) return;
      const title = em.subject ? em.subject.replace(/^(Re:|Fwd:)\s*/i, '') : 'Inbound Correspondence';
      const sender = em.sender_name || em.senderName || em.sender_email || em.senderEmail || 'Sender';
      const summary = em.summary || em.snippet || 'Review requested';
      const action = em.action_required || 'Review email thread and take necessary action.';
      attentionItems.push({
        title,
        body: `${sender} wrote regarding: "${summary}". Suggested action: ${action}`
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

  // 4. AI & EdTech Strategic Intelligence
  const aiEdTechItems = (edTechNews && edTechNews.length > 0) ? edTechNews.slice(0, 3).map(n => ({
    title: n.title,
    body: `${n.takeaway || ''}${n.source ? ` Source: ${n.source}.` : ''}`
  })) : [];

  return {
    headline,
    needsAttention: attentionItems,
    whatsappUpdates: whatsappItems,
    aiEdTech: aiEdTechItems
  };
}

