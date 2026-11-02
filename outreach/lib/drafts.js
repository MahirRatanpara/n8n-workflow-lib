// ── drafts.js ───────────────────────────────────────────────────────────────
// "Outreach - Send Drafts Now". In DRAFT mode the daily run leaves Gmail
// drafts; you review them, then run Send Drafts Now. It sends every Gmail
// draft whose subject contains sendNowSubjectContains ("Serving Notice
// Period"), plus every draft the daily run logged in Mail Log (job threads
// started before the phrase was in their subject), sendNowGapMin apart. When
// a sent draft is one the daily run logged, its Mail Log row and the thread's
// follow-up clock are updated.

function sendNowPhrase(cfg) { return cfgStr(cfg, 'sendNowSubjectContains', 'Serving Notice Period'); }

// users.drafts.list with Gmail search, so only matching drafts come back.
function sendNowListUrl(cfg) {
  return 'https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=500&q=' +
    encodeURIComponent(`subject:"${sendNowPhrase(cfg).replace(/"/g, '')}"`);
}

// users.drafts.get (format=metadata) → is it really one to send? Drafts the
// daily run logged (logged = true) go regardless of subject.
function inspectDraft(draft, cfg, logged) {
  const msg = (draft && draft.message) || {};
  const subject = headerOf(msg, 'Subject'), to = headerOf(msg, 'To');
  const phrase = sendNowPhrase(cfg).toLowerCase();
  return {
    ok: !!(draft && draft.id) && (!!logged || (!!phrase && subject.toLowerCase().includes(phrase))),
    subject, to, threadId: str(msg.threadId), messageId: str(msg.id),
  };
}

// The pending Mail Log row of a draft the daily run created, if any.
const DRAFT_PENDING = new Set(['', 'DRAFTED', 'SCHEDULED', 'SENDING']);
function mailLogRowForDraft(mailLog, draftId, threadId) {
  const pending = mailLog.filter(l => str(l.mode).toUpperCase() === 'DRAFT' && !str(l.deliveredAt) &&
    DRAFT_PENDING.has(str(l.delivery).toUpperCase()));
  return pending.find(l => draftId && str(l.draftId) === str(draftId)) ||
    pending.filter(l => threadId && str(l.threadId) === str(threadId)).pop() || null;
}

// Gmail accepted drafts.send: mark it delivered and restart the follow-up
// clock from the real send day.
function recordDraftDelivery({ row, o, response, now, cfg }) {
  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const ts = istTsStr(now), today = istDateStr(now);
  const messageId = str(response && response.id), threadId = str(response && response.threadId) || str(row.threadId);
  const log = { delivery: 'SENT', deliveredAt: ts, messageId, threadId };
  const step = numOrNull(row.step) || numOrNull(o && o.step) || 1;
  const outreachFields = o ? {
    lastSentAt: ts, lastMessageId: messageId, ...(str(o.threadId) ? {} : { threadId }),
    nextSendDate: addBusinessDays(today, gapAfterStep(cfg, step), sendDays, holidays),
  } : null;
  return { log, outreachFields };
}

function draftFailure({ error, now }) {
  const text = JSON.stringify(error || {});
  const gone = /\b404\b|not ?found|notFound/i.test(text);
  return {
    gone,
    log: gone ? { note: `Draft no longer exists in Gmail (${istTsStr(now)})` } : { delivery: 'FAILED', note: `Gmail error ${text.slice(0, 180)}` },
  };
}

// Draft ids of pipeline drafts still waiting in Mail Log.
function loggedDraftIds(mailLog) {
  return [...new Set(mailLog.filter(l => str(l.mode).toUpperCase() === 'DRAFT' && !str(l.deliveredAt) &&
    str(l.result).toUpperCase() !== 'FAILED' && DRAFT_PENDING.has(str(l.delivery).toUpperCase()) && str(l.draftId)).map(l => str(l.draftId)))];
}

// ── draft reconciliation (Reply Sync) ──────────────────────────────────────
// A pipeline draft that is no longer in Gmail was either sent by hand (its
// thread has a SENT mail from after the draft) or deleted. Deleted = never
// went out: the mail becomes DISCARDED and the thread rolls back so the step
// is retried — a first email makes the recruiter fresh again, a follow-up is
// due again on the next business day. Drafts still sitting in Gmail are left
// alone.

// Drafts from users.drafts.list, indexed by draft id and by thread.
function indexDrafts(list) {
  const byId = new Map(), byThread = new Map();
  for (const d of (list && list.drafts) || []) {
    byId.set(str(d.id), d);
    const t = str(d.message && d.message.threadId);
    if (t && !byThread.has(t)) byThread.set(t, d);
  }
  return { byId, byThread };
}

function pendingPipelineDrafts(mailLog) {
  return mailLog.filter(l => str(l.mode).toUpperCase() === 'DRAFT' && !str(l.deliveredAt) &&
    str(l.result).toUpperCase() !== 'FAILED' && DRAFT_PENDING.has(str(l.delivery).toUpperCase()));
}

// The drafts.list answer is only trustworthy when it is complete; otherwise
// every pending draft would look deleted.
function draftListComplete(list) {
  return !!list && !list.error && !list.nextPageToken && (Array.isArray(list.drafts) || 'resultSizeEstimate' in list);
}

function draftStillThere(index, row) {
  return str(row.draftId) ? index.byId.has(str(row.draftId)) : !!(str(row.threadId) && index.byThread.has(str(row.threadId)));
}

function missingDraftThreads({ mailLog, drafts }) {
  if (!draftListComplete(drafts)) return [];
  const index = indexDrafts(drafts);
  return [...new Set(pendingPipelineDrafts(mailLog).filter(r => !draftStillThere(index, r) && str(r.threadId)).map(r => str(r.threadId)))];
}

function reconcileDrafts({ mailLog, outreach, drafts, threads, now, cfg }) {
  const out = { logUpdates: [], outreachUpdates: [], discarded: [], manual: [], skipped: !draftListComplete(drafts) };
  if (out.skipped) return out;
  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const today = istDateStr(now), nowTs = istTsStr(now);
  const index = indexDrafts(drafts);
  const oById = new Map(outreach.map(o => [str(o.outreachId), o]));
  const threadById = new Map((threads || []).filter(t => t && t.id).map(t => [str(t.id), t]));
  for (const row of pendingPipelineDrafts(mailLog)) {
    if (draftStillThere(index, row)) continue;
    const o = oById.get(str(row.outreachId)) || null;
    const who = `${str(o && o.recruiterName) || str(row.email)} @ ${str(o && o.company)}`;
    const step = numOrNull(row.step) || 1;
    const loggedAt = parseTs(row.sentAt);
    // a mail sent between this draft and the thread's next logged step is this one
    const next = mailLog.filter(l => str(l.outreachId) === str(row.outreachId) && (numOrNull(l.step) || 0) > step)
      .map(l => parseTs(l.sentAt)).filter(Boolean).sort((a, b) => a - b)[0];
    const t = threadById.get(str(row.threadId));
    const sent = ((t && t.messages) || []).filter(m => (m.labelIds || []).includes('SENT') && !(m.labelIds || []).includes('DRAFT') &&
      (!loggedAt || Number(m.internalDate) >= loggedAt.getTime() - 120e3) && (!next || Number(m.internalDate) < next.getTime() - 60e3))
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const latest = o && (numOrNull(o.step) || 0) === step;
    if (sent.length) {
      const m = sent[0], at = parseTs(m.internalDate);
      out.logUpdates.push({ _row: row._row, fields: { delivery: 'SENT', deliveredAt: istTsStr(at), messageId: str(m.id), note: 'Found sent in Gmail' } });
      if (latest) out.outreachUpdates.push({ _row: o._row, fields: { lastSentAt: istTsStr(at), lastMessageId: str(m.id),
        nextSendDate: addBusinessDays(istDateStr(at), gapAfterStep(cfg, step), sendDays, holidays) } });
      out.manual.push(who);
      continue;
    }
    out.logUpdates.push({ _row: row._row, fields: { delivery: 'DISCARDED', note: `Draft deleted in Gmail without sending (${nowTs})` } });
    out.discarded.push({ who, step });
    if (!latest) continue;                                   // a later mail exists on this thread: only the log changes
    if (step <= 1) {
      // the thread never started: the recruiter is fresh again
      out.outreachUpdates.push({ _row: o._row, fields: { state: 'DISCARDED', endedAt: nowTs, endReason: 'DRAFT_DISCARDED', nextSendDate: '' } });
      continue;
    }
    // roll the thread back to the previous mail and make this step due again
    const prev = mailLog.filter(l => str(l.outreachId) === str(row.outreachId) && (numOrNull(l.step) || 0) === step - 1 &&
      str(l.delivery).toUpperCase() !== 'DISCARDED' && str(l.result).toUpperCase() !== 'FAILED').pop();
    const prevType = prev && /^COLD/i.test(str(prev.templateCode)) ? 'COLD' : str(o.type).toUpperCase() || 'JOB';
    const live = ['ACTIVE', 'EXHAUSTED'].includes(str(o.state).toUpperCase());
    out.outreachUpdates.push({ _row: o._row, fields: {
      step: step - 1, nextTemplate: `${prevType}_FU${step - 1}`,
      nextSendDate: addBusinessDays(today, 1, sendDays, holidays),
      ...(prev ? { lastSentAt: str(prev.deliveredAt) || str(prev.sentAt), lastMessageId: str(prev.messageId), type: prevType, jobId: str(prev.jobId) } : {}),
      ...(live ? { state: 'ACTIVE', endedAt: '', endReason: '' } : {}),
      note: `Step ${step} draft deleted ${today}, due again`,
    } });
  }
  return out;
}

function formatReconcileNote(r) {
  const L = [];
  if (r.discarded.length) L.push(`🗑 ${r.discarded.length} draft${r.discarded.length > 1 ? 's' : ''} deleted without sending, rolled back to retry: ` +
    r.discarded.map(d => `${d.who}${d.step <= 1 ? ' (first email)' : ` (email ${d.step})`}`).join(', '));
  if (r.manual.length) L.push(`✉️ Found sent in Gmail and logged: ${r.manual.length} (${r.manual.slice(0, 10).join(', ')}${r.manual.length > 10 ? ', …' : ''})`);
  return L.join('\n');
}
