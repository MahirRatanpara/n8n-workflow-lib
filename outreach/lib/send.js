// ── send.js ─────────────────────────────────────────────────────────────────
// Per-mail steps inside the send loop: window gate → compose → record.

function gateItem({ cfg, now }) {
  if (isYes(cfg.ignoreSendWindow)) return { skip: false };
  const mins = istMinutesOfDay(now);
  const start = hhmmToMinutes(cfg.sendWindowStart, 9 * 60);
  const end = hhmmToMinutes(cfg.sendWindowEnd, 12 * 60 + 30);
  if (mins < start || mins > end) return { skip: true, reason: 'OUTSIDE_SEND_WINDOW' };
  return { skip: false };
}

function jobLooksClosed(html) {
  return /no longer accepting applications|this job is no longer available|job has expired/i.test(String(html || ''));
}

// item: a planner queue entry. thread: Gmail thread (replies only).
// resume: { b64, name, mimeType }. Returns { skip, reason } or the API call.
function composeMail({ item, cfg, thread, resume, jobClosed }) {
  const mode = cfgStr(cfg, 'mode', 'DRY_RUN').toUpperCase();
  const myEmail = cfgStr(cfg, 'myEmail', '');
  if (!myEmail) return { skip: true, reason: 'myEmail missing in Outreach Config' };
  if (!item.to) return { skip: true, reason: 'NO_EMAIL' };
  if (jobClosed) return { skip: true, reason: 'JOB_CLOSED' };
  let subject = item.subject, inReplyTo = '', references = '', threadId = '';
  if (!item.isNewThread) {
    const info = threadReplyInfo(thread, myEmail);
    if (!info) return { skip: true, reason: 'THREAD_NOT_FOUND' };
    const fresh = info.inbound.map(m => classifyMessage(m, myEmail)).filter(Boolean);
    if (fresh.some(v => v.kind === 'REPLY')) return { skip: true, reason: 'REPLIED' };
    if (fresh.some(v => v.kind === 'BOUNCE')) return { skip: true, reason: 'BOUNCED' };
    // Crash between Gmail and the sheet write on an earlier run: a mail from
    // you landed on this thread in the last 20h, after the recorded send.
    const recorded = parseTs(item.lastSentAt);
    if (info.lastMineAt && Date.now() - info.lastMineAt.getTime() < 20 * 3600e3 &&
        (!recorded || info.lastMineAt.getTime() > recorded.getTime() + 60e3)) return { skip: true, reason: 'ALREADY_SENT' };
    subject = replySubject(info.subject || item.subject);
    inReplyTo = info.inReplyTo;
    references = info.references;
    threadId = item.threadId;
  }
  let attachment = null;
  if (item.attachResume) {
    if (!resume || !resume.b64) return { skip: true, reason: 'RESUME_MISSING' };
    attachment = resume;
  }
  const raw = buildRawMessage({
    fromName: cfgStr(cfg, 'senderName', ''), fromEmail: myEmail, to: item.to,
    subject, body: item.body, inReplyTo, references, attachment,
  });
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
  if (mode === 'DRAFT') {
    return { skip: false, mode, subject, apiUrl: `${base}/drafts`, apiBody: { message: threadId ? { raw, threadId } : { raw } } };
  }
  if (mode === 'SEND') {
    return { skip: false, mode, subject, apiUrl: `${base}/messages/send`, apiBody: threadId ? { raw, threadId } : { raw } };
  }
  return { skip: true, reason: `MODE_${mode}` };
}

// After Gmail accepted the mail: one Outreach upsert + one Mail Log append.
// idColumns: { Outreach: values of the id column, 'Mail Log': values }.
function recordMail({ item, response, mode, now, headers, idColumns, subject }) {
  const sentAt = istTsStr(now);
  const msg = (response && response.message) || response || {};
  const threadId = str(msg.threadId) || str(response && response.threadId) || str(item.threadId);
  const messageId = str(msg.id) || str(response && response.id);
  const fields = {};
  for (const [k, v] of Object.entries(item.outreachFields || {})) {
    fields[k] = v === '__SENT_AT__' ? sentAt : v === '__THREAD_ID__' ? threadId : v === '__MESSAGE_ID__' ? messageId : v;
  }
  if (item.isNewThread && subject) fields.subject = subject;
  const oHeaders = headers.Outreach, lHeaders = headers['Mail Log'];
  const oIds = (idColumns.Outreach || []).map(r => str(Array.isArray(r) ? r[0] : r));
  const lIds = (idColumns['Mail Log'] || []).map(r => str(Array.isArray(r) ? r[0] : r));
  const data = [];
  const at = oIds.indexOf(item.outreachId, 1);
  if (at > 0) {
    const { outreachId, ...rest } = fields;
    data.push(...cellWrites('Outreach', oHeaders, at + 1, rest));
  } else {
    data.push(rowWrite('Outreach', oHeaders, Math.max(oIds.length, 1) + 1, { ...fields, outreachId: item.outreachId }));
  }
  const logId = hashId('L', `${item.outreachId}#${item.stepAfter}`);
  if (!lIds.includes(logId)) {
    data.push(rowWrite('Mail Log', lHeaders, Math.max(lIds.length, 1) + 1, {
      logId, sentAt, outreachId: item.outreachId, recruiterId: item.recruiterId, jobId: item.jobId,
      templateCode: item.templateCode, kind: item.kind, mode, step: item.stepAfter, email: item.to,
      threadId, messageId, result: 'OK', note: '',
    }));
  }
  return { data, threadId, messageId, sentAt };
}
