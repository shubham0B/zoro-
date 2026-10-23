import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { synthesizeEditorialBrief } from './geminiService.js';
import { getSetting } from '../database/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function formatEditorialDate(dateStr) {
  try {
    const d = new Date(dateStr);
    const day = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const month = d.toLocaleDateString('en-US', { month: 'long' }).toUpperCase();
    const dayNum = d.getDate();
    const year = d.getFullYear();
    return `${day} · ${month} ${dayNum} ${year}`;
  } catch (e) {
    return (dateStr || '').toUpperCase();
  }
}

function getFormattedTopTimestamp() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const y = String(now.getFullYear()).slice(-2);
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${m}/${d}/${y}, ${time}`;
}

function drawPageTopHeader(doc, topTimestamp, orgName = 'Zoro AI') {
  doc.save();
  doc.fontSize(8.5).font('Helvetica').fillColor('#6B7280');
  doc.text(topTimestamp, 48, 38);
  doc.text(`${orgName} · Daily Intelligence Brief`, 48, 38, { width: 499, align: 'right' });
  doc.restore();
}

function drawMinimalistIllustration(doc, y) {
  doc.save();
  // Minimalist rising sun outline in rose / coral red (#E11D48)
  doc.circle(135, y + 20, 8.5)
     .lineWidth(1.1)
     .strokeColor('#E11D48')
     .stroke();

  // Minimal flying birds in upper right sky
  doc.lineWidth(1).strokeColor('#1F2937');
  // Bird 1
  doc.moveTo(380, y + 16)
     .bezierCurveTo(383, y + 12, 387, y + 12, 390, y + 16)
     .bezierCurveTo(393, y + 12, 397, y + 12, 400, y + 16)
     .stroke();

  // Bird 2
  doc.moveTo(395, y + 25)
     .bezierCurveTo(398, y + 21, 402, y + 21, 405, y + 25)
     .bezierCurveTo(408, y + 21, 412, y + 21, 415, y + 25)
     .stroke();

  // Rolling hill contour line stretching smoothly across page
  doc.lineWidth(1.2).strokeColor('#1F2937');
  doc.moveTo(48, y + 46)
     .bezierCurveTo(180, y + 40, 290, y + 34, 420, y + 44)
     .bezierCurveTo(460, y + 46, 500, y + 46, 547, y + 46)
     .stroke();
  doc.restore();
}

function sanitizeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/₹/g, 'Rs. ')
    .replace(/’/g, "'")
    .replace(/‘/g, "'")
    .replace(/“/g, '"')
    .replace(/”/g, '"')
    .replace(/—/g, ' - ')
    .replace(/–/g, '-');
}

/**
 * Dynamic, Data-Driven Schedule Section (No hardcoded 3-chunk blocks)
 */
function drawScheduleSection(doc, startY, schedules = []) {
  let y = startY;

  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#111827')
     .text("TODAY'S SCHEDULE & OFFICIAL ITINERARY", 48, y, { characterSpacing: 1.2 });
  y += 18;

  if (!schedules || schedules.length === 0) {
    doc.save();
    doc.roundedRect(48, y, 499, 44, 4).fillAndStroke('#F9FAFB', '#E5E7EB');
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#374151')
       .text("Open Calendar for Strategic Governance", 62, y + 11);
    doc.fontSize(8).font('Helvetica').fillColor('#6B7280')
       .text("No official meetings or appointments scheduled on the Director's calendar for today.", 62, y + 25);
    doc.restore();
    return y + 60;
  }

  schedules.forEach((item) => {
    const timeText = sanitizeText(item.time_slot || item.time || 'Scheduled');
    const titleText = sanitizeText(item.title || 'Official Appointment');
    const locText = sanitizeText(item.location ? `Venue: ${item.location}` : '');
    const descText = sanitizeText(item.description || item.notes || '');
    const priority = item.priority || 'Normal';

    const detailsParts = [];
    if (locText) detailsParts.push(locText);
    if (descText) detailsParts.push(`Agenda: ${descText}`);
    const detailsLine = detailsParts.join(' · ');

    doc.fontSize(9.5).font('Helvetica-Bold');
    const titleH = doc.heightOfString(titleText, { width: 375 });

    doc.fontSize(8.5).font('Helvetica');
    const detailsH = detailsLine ? doc.heightOfString(detailsLine, { width: 375, lineGap: 2 }) : 0;
    const rowH = Math.max(26, titleH + detailsH + 8);

    // Page overflow check
    if (y + rowH > doc.page.height - 75) {
      doc.addPage();
      drawPageTopHeader(doc, getFormattedTopTimestamp());
      y = 52;
    }

    // Time Badge
    const isUrgent = priority === 'Urgent';
    const isHigh = priority === 'High';
    const badgeBg = isUrgent ? '#FEE2E2' : (isHigh ? '#FEF3C7' : '#EEF2FF');
    const badgeColor = isUrgent ? '#991B1B' : (isHigh ? '#92400E' : '#4338CA');

    doc.save();
    doc.roundedRect(48, y + 2, 100, 18, 4).fill(badgeBg);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(badgeColor)
       .text(timeText, 48, y + 6, { width: 100, align: 'center' });
    doc.restore();

    // Meeting Title
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#111827')
       .text(titleText, 160, y + 2, { width: 385 });

    // Venue & Notes
    if (detailsLine) {
      doc.fontSize(8.5).font('Helvetica').fillColor('#4B5563')
         .text(detailsLine, 160, y + titleH + 4, { width: 385, lineGap: 2 });
    }

    y += rowH + 8;
  });

  // Divider rule below schedule
  doc.save();
  doc.lineWidth(0.75).strokeColor('#E5E7EB');
  doc.moveTo(48, y).lineTo(547, y).stroke();
  doc.restore();

  return y + 20;
}

function drawEditorialCategory(doc, categoryTitle, items = [], state) {
  if (!items || items.length === 0) return;

  if (state.y + 70 > doc.page.height - 70) {
    doc.addPage();
    drawPageTopHeader(doc, state.topTimestamp);
    state.y = 52;
  }

  // Category Header
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#111827')
     .text(categoryTitle.toUpperCase(), 48, state.y, { characterSpacing: 1.2 });
  state.y += 20;

  items.forEach((item, index) => {
    const titleText = sanitizeText(item.title);
    const bodyText = sanitizeText(item.body);

    doc.fontSize(10).font('Times-Bold');
    const titleH = doc.heightOfString(titleText, { width: 475 });
    doc.fontSize(9).font('Helvetica');
    const bodyH = doc.heightOfString(bodyText, { width: 475, lineGap: 3 });
    const totalH = titleH + bodyH + 18;

    if (state.y + totalH > doc.page.height - 75) {
      doc.addPage();
      drawPageTopHeader(doc, state.topTimestamp);
      state.y = 52;
    }

    // Number on left
    doc.fontSize(9).font('Helvetica').fillColor('#9CA3AF')
       .text(String(index + 1), 48, state.y);

    // Headline
    doc.fontSize(10).font('Times-Bold').fillColor('#111827')
       .text(titleText, 72, state.y, { width: 475 });

    // Narrative Body
    doc.fontSize(9).font('Helvetica').fillColor('#4B5563')
       .text(bodyText, 72, state.y + titleH + 4, { width: 475, lineGap: 3 });

    state.y += totalH;
  });

  state.y += 18;
}

export async function generateExecutiveBriefingPdf({
  dateStr,
  directorName = null,
  organizationName = 'JECRC University',
  directorTitle = 'Office of the Director',
  schedules = [],
  emails = [],
  chats = [],
  whatsappSummary = null,
  edTechNews = []
}) {
  const outputDir = path.join(__dirname, '../../storage/briefings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeDate = dateStr.replace(/[^0-9-]/g, '_');
  const filePath = path.join(outputDir, `executive_briefing_${safeDate}.pdf`);

  // Resolve Director Name
  let resolvedDirectorName = directorName;
  if (!resolvedDirectorName) {
    resolvedDirectorName = (await getSetting('DIRECTOR_NAME')) || 'Dheemant';
  }

  // Synthesize editorial content strictly from real data
  const chatsList = (Array.isArray(chats) && chats.length > 0) 
    ? chats 
    : (whatsappSummary?.summary_points || []);

  const briefData = await synthesizeEditorialBrief({
    dateStr,
    directorName: resolvedDirectorName,
    schedules,
    emails,
    chats: chatsList,
    edTechNews
  });

  const topTimestamp = getFormattedTopTimestamp();
  const dateFormatted = formatEditorialDate(dateStr);

  const orgName = (await getSetting('ORGANIZATION_NAME')) || 'Zoro AI Hub';
  const assistantName = (await getSetting('ASSISTANT_NAME')) || 'Zoro AI';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      bufferPages: true,
      info: {
        Title: `Intelligence Brief - ${dateStr}`,
        Author: assistantName
      }
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const state = {
      y: 48,
      topTimestamp
    };

    // --- PAGE 1 ---
    drawPageTopHeader(doc, topTimestamp, orgName);

    // Date Subtitle
    state.y = 68;
    doc.fontSize(8.5).font('Helvetica').fillColor('#6B7280')
       .text(dateFormatted, 48, state.y, { characterSpacing: 1.5 });

    // Hero Headline
    state.y = 88;
    const cleanHeadline = sanitizeText(briefData.headline);
    doc.fontSize(22).font('Times-Bold').fillColor('#111827')
       .text(cleanHeadline, 48, state.y, { width: 499, lineGap: 3 });

    const headlineHeight = doc.heightOfString(cleanHeadline, { width: 499, font: 'Times-Bold', size: 22, lineGap: 3 });
    const illustrationY = state.y + headlineHeight + 10;

    // Artistic Landscape Illustration
    drawMinimalistIllustration(doc, illustrationY);

    // Dynamic, Data-Driven Schedule Section (No hardcoded 3-chunk blocks)
    const scheduleY = illustrationY + 68;
    state.y = drawScheduleSection(doc, scheduleY, schedules);

    // Categories (rendered ONLY if real items exist)
    if (briefData.needsAttention && briefData.needsAttention.length > 0) {
      drawEditorialCategory(doc, 'CRITICAL INCOMING CORRESPONDENCE & EMAILS', briefData.needsAttention, state);
    }
    if (briefData.whatsappUpdates && briefData.whatsappUpdates.length > 0) {
      drawEditorialCategory(doc, 'PRIORITY COMMUNICATIONS & WHATSAPP UPDATES', briefData.whatsappUpdates, state);
    }
    if (briefData.aiEdTech && briefData.aiEdTech.length > 0) {
      drawEditorialCategory(doc, 'STRATEGIC AI & TECH INNOVATION RADAR', briefData.aiEdTech, state);
    }

    // Final Footnote on last page
    doc.page.margins.bottom = 0;
    doc.fontSize(8.5).font('Helvetica-Oblique').fillColor('#6B7280')
       .text(`Generated by ${assistantName} · Live omnichannel sync with Calendar, Gmail & WhatsApp.`, 48, doc.page.height - 58, { width: 499, lineBreak: false });

    // Apply Page Numbers & Domain Reference across all buffered pages
    const range = doc.bufferedPageRange();
    const totalPages = range.count;

    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      const oldBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;

      doc.fontSize(7.5).font('Helvetica').fillColor('#6B7280');
      doc.text(`${orgName} · Autonomous Command Platform`, 48, doc.page.height - 28, { lineBreak: false });
      doc.text(`${i + 1}/${totalPages}`, 48, doc.page.height - 28, { align: 'right', width: 499, lineBreak: false });

      doc.page.margins.bottom = oldBottom;
    }

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
}
