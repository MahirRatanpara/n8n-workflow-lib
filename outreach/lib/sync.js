// ── sync.js ─────────────────────────────────────────────────────────────────
// Reply / bounce / out-of-office detection. Input is Gmail threads fetched
// with format=metadata; output is state changes for the Outreach tab.
// Precedence per thread: human reply > bounce > out-of-office.

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail-daemon|mail delivery (sub)?system)/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|mail delivery (failed|failure)|returned mail|address not found|delivery has failed|failure notice)/i;
const OOO_TEXT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the )?office|on (annual |parental |maternity |paternity |medical )?leave|on vacation|currently away|limited access to (my )?e-?mail)/i;

function classifyMessage(msg, myEmail) {
  if ((msg.labelIds || []).includes('DRAFT')) return null;
  const fromRaw = headerOf(msg, 'From');
  const from = emailFromHeader(fromRaw);
  if (!from || from === normEmail(myEmail)) return null;
  const subject = headerOf(msg, 'Subject');
  const snippet = str(msg.snippet);
  const failed = headerOf(msg, 'X-Failed-Recipients');
  if (BOUNCE_FROM.test(fromRaw) || failed || BOUNCE_SUBJECT.test(subject)) {
    return { kind: 'BOUNCE', failed: failed.toLowerCase().split(/[,\s]+/).filter(Boolean), snippet, at: parseTs(msg.internalDate) };
  }
  const autoSub = headerOf(msg, 'Auto-Submitted').toLowerCase();
  if ((autoSub && autoSub !== 'no') || headerOf(msg, 'X-Autoreply') || headerOf(msg, 'X-Autorespond') ||
      OOO_TEXT.test(subject) || OOO_TEXT.test(snippet.slice(0, 160))) {
    return { kind: 'OOO', from, at: parseTs(msg.internalDate) };
  }
  return { kind: 'REPLY', from, subject, snippet, at: parseTs(msg.internalDate) };
}

// threads: Gmail thread objects. outreach: parsed Outreach rows. contacts:
// parsed Contacts rows. Returns { outreachChanges: Map(outreachId → fields),
// contactChanges: Map(recruiterId → fields), events: [...] } without
// touching rows it does not change.
function syncThreads({ threads, outreach, contacts, myEmail, today, cfg }) {
  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const oooDays = cfgNum(cfg, 'oooPauseDays', 5);
  const watchable = new Set(['ACTIVE', 'EXHAUSTED']);
  const byThread = new Map();
  const byEmail = new Map();
  const contactById = new Map(contacts.map(c => [str(c.recruiterId), c]));
  for (const o of outreach) {
    const st = str(o.state).toUpperCase();
    if (!watchable.has(st)) continue;
    if (str(o.threadId)) byThread.set(str(o.threadId), o);
    const c = contactById.get(str(o.recruiterId));
    if (c && normEmail(c.email)) byEmail.set(normEmail(c.email), o);
  }

  const outreachChanges = new Map(), contactChanges = new Map(), events = [];
  const verdict = new Map(); // outreachId → { kind, ... }
  const rank = { REPLY: 3, BOUNCE: 2, OOO: 1 };
  const consider = (o, v) => {
    if (!o) return;
    const prev = verdict.get(o.outreachId);
    if (!prev || rank[v.kind] > rank[prev.kind] || (v.kind === prev.kind && (v.at || 0) > (prev.at || 0))) verdict.set(o.outreachId, { ...v, o });
  };

  for (const t of threads || []) {
    if (!t || !Array.isArray(t.messages)) continue;
    const tracked = byThread.get(str(t.id));
    for (const m of t.messages) {
      const v = classifyMessage(m, myEmail);
      if (!v) continue;
      // Ignore anything older than the thread's first mail (migrated rows).
      const since = parseTs(tracked && (tracked.createdAt || tracked.lastSentAt));
      if (tracked && since && v.at && v.at < since) continue;
      if (v.kind === 'BOUNCE') {
        let target = tracked;
        const emails = v.failed.length ? v.failed : (v.snippet.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).map(e => e.toLowerCase());
        if (!target) for (const e of emails) { if (byEmail.has(e)) { target = byEmail.get(e); break; } }
        consider(target, v);
      } else if (tracked) {
        consider(tracked, v);
      }
    }
  }

  for (const [id, v] of verdict) {
    const o = v.o;
    const st = str(o.state).toUpperCase();
    const contact = contactById.get(str(o.recruiterId)) || {};
    if (v.kind === 'REPLY') {
      outreachChanges.set(id, { state: 'REPLIED', endedAt: v.at ? istTsStr(v.at) : istTsStr(new Date()), endReason: 'REPLIED', nextSendDate: '' });
      events.push({ type: 'REPLY', outreachId: id, recruiterId: o.recruiterId, name: contact.name || o.recruiterName || '', company: contact.company || o.company || '', email: v.from, snippet: v.snippet, subject: v.subject });
    } else if (v.kind === 'BOUNCE') {
      outreachChanges.set(id, { state: 'BOUNCED', endedAt: v.at ? istTsStr(v.at) : istTsStr(new Date()), endReason: 'BOUNCED', nextSendDate: '' });
      if (str(o.recruiterId)) contactChanges.set(str(o.recruiterId), { emailStatus: 'BOUNCED' });
      events.push({ type: 'BOUNCE', outreachId: id, recruiterId: o.recruiterId, name: contact.name || '', company: contact.company || '', email: contact.email || '' });
    } else if (v.kind === 'OOO' && st === 'ACTIVE') {
      const base = v.at ? istDateStr(v.at) : today;
      const pushed = addBusinessDays(base, oooDays, sendDays, holidays);
      const current = toIstDate(o.nextSendDate);
      if (!current || current < pushed) {
        outreachChanges.set(id, { nextSendDate: pushed, note: `Out of office, paused until ${pushed}` });
        events.push({ type: 'OOO', outreachId: id, name: contact.name || '', company: contact.company || '', until: pushed });
      }
    }
  }
  return { outreachChanges, contactChanges, events };
}

// Message ids from users.messages.list → threads worth fetching.
function threadsToFetch({ recent, bounces, outreach }) {
  const tracked = new Set(outreach.filter(o => ['ACTIVE', 'EXHAUSTED'].includes(str(o.state).toUpperCase())).map(o => str(o.threadId)).filter(Boolean));
  const ids = new Set();
  for (const m of ((recent && recent.messages) || [])) if (tracked.has(str(m.threadId))) ids.add(str(m.threadId));
  for (const m of ((bounces && bounces.messages) || [])) if (str(m.threadId)) ids.add(str(m.threadId));
  return [...ids];
}
