// ── mail.js ─────────────────────────────────────────────────────────────────
// Template lookup/rendering and RFC 2822 message building for the Gmail API.
// Pure JS base64 so it works with or without Buffer in the Code-node sandbox.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(s) {
  const out = [];
  for (const ch of String(s)) {
    let c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? '=' : B64[(n >> 6) & 63]) + (c === undefined ? '=' : B64[n & 63]);
  }
  return s;
}
function b64Utf8(s) { return bytesToB64(utf8Bytes(s)); }
function b64ToUrl(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function wrap76(b64) { return (b64.match(/.{1,76}/g) || ['']).join('\r\n'); }

function encodeHeaderWord(s) {
  const v = String(s || '');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64Utf8(v)}?=`;
}

// ── templates ───────────────────────────────────────────────────────────────
// templates: { CODE: { subject, body, attachResume } }. Lookup tries each code
// in order, so 'JOB_FU2' can fall back to 'JOB_FU'.
function findTemplate(templates, codes) {
  for (const c of codes) {
    const t = templates[c];
    if (t && str(t.body)) return { code: c, ...t };
  }
  return null;
}

function renderTemplate(text, ctx) {
  const filled = String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (ctx[k] === undefined || ctx[k] === null ? '' : String(ctx[k])));
  return filled
    .replace(/\r\n/g, '\n')
    .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')       // a blank placeholder line (e.g. {{PitchLine}}) leaves no gap
    .trim();
}

function replySubject(subject) {
  const s = str(subject);
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// Plain text → HTML that keeps the template's own line breaks and nothing
// else. Gmail hard-wraps text/plain drafts at ~78 characters when they are
// sent from its composer, which turned paragraphs into ragged short lines;
// with an HTML part the composer opens in rich mode and lines reflow.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function textToHtml(text) {
  const linked = escapeHtml(String(text || '').replace(/\r\n/g, '\n'))
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, u => `<a href="${u}">${u}</a>`)
    .replace(/(^|[\s(])((?:www\.)?linkedin\.com\/[^\s<]+[^\s<.,;:!?)\]])/g, (m, pre, u) => `${pre}<a href="https://${u}">${u}</a>`)
    .replace(/(^|[\s(])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g, (m, pre, e) => `${pre}<a href="mailto:${e}">${e}</a>`);
  return `<div dir="ltr">${linked.split('\n').join('<br>\n')}</div>`;
}

// Returns base64url "raw" for users.messages.send / drafts.create:
// multipart/alternative (text + HTML), inside multipart/mixed when the
// resume is attached.
function buildRawMessage({ fromName, fromEmail, to, subject, body, inReplyTo, references, attachment }) {
  const from = fromName ? `${encodeHeaderWord(fromName)} <${fromEmail}>` : fromEmail;
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
  ];
  if (inReplyTo) head.push(`In-Reply-To: ${inReplyTo}`);
  if (references || inReplyTo) head.push(`References: ${[references, inReplyTo].filter(Boolean).join(' ').trim()}`);
  const text = String(body || '').replace(/\r?\n/g, '\r\n');
  const seed = hashId('', subject + to + text.length);
  const alt = 'a_' + seed;
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    wrap76(b64Utf8(text)),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64', '',
    wrap76(b64Utf8(textToHtml(body))),
    `--${alt}--`,
  ];
  let mime;
  if (attachment && attachment.b64) {
    const mixed = 'm_' + seed;
    const name = encodeHeaderWord(attachment.name || 'resume.pdf');
    mime = head.concat([
      `Content-Type: multipart/mixed; boundary="${mixed}"`, '',
      `--${mixed}`,
      ...alternative,
      `--${mixed}`,
      `Content-Type: ${attachment.mimeType || 'application/pdf'}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64', '',
      wrap76(String(attachment.b64).replace(/\s+/g, '')),
      `--${mixed}--`, '',
    ]).join('\r\n');
  } else {
    mime = head.concat(alternative, ['']).join('\r\n');
  }
  return b64ToUrl(bytesToB64(utf8Bytes(mime)));
}

// Gmail thread (format=metadata) → what a reply needs.
function headerOf(msg, name) {
  const hs = (msg && msg.payload && msg.payload.headers) || [];
  const h = hs.find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
}
function emailFromHeader(v) {
  const m = String(v || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(v || '')).trim().toLowerCase();
}
function threadReplyInfo(thread, myEmail) {
  const msgs = ((thread && thread.messages) || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
  if (!msgs.length) return null;
  const first = msgs[0], last = msgs[msgs.length - 1];
  const me = normEmail(myEmail);
  const inbound = msgs.filter(m => {
    const f = emailFromHeader(headerOf(m, 'From'));
    return f && f !== me;
  });
  return {
    subject: headerOf(first, 'Subject'),
    inReplyTo: headerOf(last, 'Message-ID') || headerOf(last, 'Message-Id'),
    references: headerOf(last, 'References'),
    lastMessageId: last.id,
    sentByMe: msgs.length - inbound.length,
    lastMineAt: (() => { const mine = msgs.filter(m => !inbound.includes(m)); return mine.length ? parseTs(mine[mine.length - 1].internalDate) : null; })(),
    inbound,
  };
}
