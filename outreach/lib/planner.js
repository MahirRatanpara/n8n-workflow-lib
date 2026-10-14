// ── planner.js ──────────────────────────────────────────────────────────────
// The daily decision engine. Pure: data in, decisions out. Order matters:
//   hygiene → settle jobs → merges (due recruiters at a picked company get a
//   NEW_ROLE mail) → generic follow-ups for the remaining due → budget →
//   fresh job threads by job rank → cold intros with what is left.

function businessDaysBetween(a, b, sendDays, holidays) {
  if (!a || !b || a >= b) return 0;
  let n = 0, d = a, guard = 0;
  while (d < b && guard++ < 1000) { d = addCalendarDays(d, 1); if (isBusinessDay(d, sendDays, holidays)) n++; }
  return n;
}

function loadTemplates(rows) {
  const out = {};
  for (const r of rows || []) {
    const code = str(r.templateCode).toUpperCase();
    if (code) out[code] = { subject: str(r.subject), body: String(r.body || ''), attachResume: str(r.attachResume) };
  }
  return out;
}

function firstNameOf(name) {
  const f = str(name).split(/\s+/)[0] || '';
  return f && f === f.toLowerCase() ? f.charAt(0).toUpperCase() + f.slice(1) : f;
}

function jobUrlOf(job, jobId) {
  return str(job && job.applyLink) || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : '');
}

function planOutreach(input) {
  const { cfg, today, contacts, outreach, mailLog, jobs, companyIndex } = input;
  const nowTs = input.nowTs || istTsStr(new Date());
  const templates = input.templates || {};
  const ai = input.ai || { scores: {}, pitches: {} };
  const sync = input.sync || { outreachChanges: new Map(), contactChanges: new Map(), events: [] };

  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const maxMails = cfgNum(cfg, 'maxMailsPerRecruiter', 4);
  const gaps = cfgList(cfg, 'followupGapDays', '3,4,7').map(Number).filter(n => n > 0);
  const exhaustAfter = cfgNum(cfg, 'exhaustAfterDays', 7);
  const newPerJob = cfgNum(cfg, 'newPerJob', 4);
  const maxPerJob = cfgNum(cfg, 'maxPerJob', 7);
  const cap = cfgNum(cfg, 'dailySendCap', 15);
  const cooldown = cfgNum(cfg, 'companyCooldownDays', 7);
  const maxAge = cfgNum(cfg, 'maxJobAgeDays', 3);
  const minScore = cfgNum(cfg, 'minOutreachScore', 80);
  const coldPerDay = cfgNum(cfg, 'coldPerDay', 0);
  const reserve = cfgNum(cfg, 'reserveFreshPerCompany', 4);
  const quietDays = cfgNum(cfg, 'coldCompanyQuietDays', 14);
  const reengageAfter = cfgNum(cfg, 'reengageAfterDays', 90);
  const reengageMin = cfgNum(cfg, 'reengageMinScore', 90);
  const sendable = new Set(cfgList(cfg, 'sendableEmailStatuses', 'VALID,PROBABLE').map(s => s.toUpperCase()));
  const sendDay = isBusinessDay(today, sendDays, holidays);

  const outreachWrites = new Map();
  const contactWrites = new Map();
  const jobWrites = new Map();
  const alerts = [];
  const companyName = (cid, fallback) => (companyIndex && companyIndex.names.get(str(cid))) || str(fallback);

  const oById = new Map();
  for (const o of outreach) if (str(o.outreachId)) oById.set(str(o.outreachId), o);
  const setO = (o, fields) => {
    Object.assign(o, fields);
    outreachWrites.set(str(o.outreachId), { ...(outreachWrites.get(str(o.outreachId)) || {}), ...fields });
  };
  const cById = new Map();
  for (const c of contacts) if (str(c.recruiterId)) cById.set(str(c.recruiterId), c);
  const setJob = (j, fields) => { Object.assign(j, fields); jobWrites.set(j._row, { ...(jobWrites.get(j._row) || {}), ...fields }); };

  // 0 ── apply what reply sync found ─────────────────────────────────────────
  for (const [id, f] of sync.outreachChanges || []) { const o = oById.get(id); if (o) setO(o, f); }
  for (const [rid, f] of sync.contactChanges || []) {
    const c = cById.get(rid);
    if (c) { Object.assign(c, f); contactWrites.set(rid, { ...(contactWrites.get(rid) || {}), ...f }); }
  }

  const stateOf = o => str(o.state).toUpperCase();
  const isSendableContact = c => !!c && isYes(c.isRelevant) && !isYes(c.hold) && !!normEmail(c.email) &&
    sendable.has(str(c.emailStatus).toUpperCase()) && str(c.enrichStatus).toUpperCase() !== 'DUPLICATE';

  // 1 ── hygiene: holds, bounces, duplicate threads, finished threads ────────
  const activeByRecruiter = new Map();
  const byNewest = [...oById.values()].sort((a, b) => (str(b.createdAt) > str(a.createdAt) ? 1 : -1));
  for (const o of byNewest) {
    if (stateOf(o) !== 'ACTIVE') continue;
    const rid = str(o.recruiterId);
    const c = cById.get(rid);
    if (c && isYes(c.hold)) { setO(o, { state: 'STOPPED', endedAt: nowTs, endReason: 'HOLD', nextSendDate: '' }); continue; }
    if (c && str(c.emailStatus).toUpperCase() === 'BOUNCED') { setO(o, { state: 'BOUNCED', endedAt: nowTs, endReason: 'BOUNCED', nextSendDate: '' }); continue; }
    if (activeByRecruiter.has(rid)) { setO(o, { state: 'STOPPED', endedAt: nowTs, endReason: 'DUPLICATE_THREAD', nextSendDate: '' }); continue; }
    const step = numOrNull(o.step) || 0;
    const nsd = toIstDate(o.nextSendDate);
    if (step >= maxMails && (!nsd || nsd <= today)) { setO(o, { state: 'EXHAUSTED', endedAt: nowTs, endReason: 'MAX_MAILS', nextSendDate: '' }); continue; }
    activeByRecruiter.set(rid, o);
  }

  const logged = new Set(mailLog.filter(l => str(l.result).toUpperCase() !== 'FAILED').map(l => `${str(l.outreachId)}#${str(l.step)}`));
  const outreachByRecruiter = new Map();
  for (const o of oById.values()) {
    const rid = str(o.recruiterId);
    if (!outreachByRecruiter.has(rid)) outreachByRecruiter.set(rid, []);
    outreachByRecruiter.get(rid).push(o);
  }

  // 2 ── contact pools per company ──────────────────────────────────────────
  const freshByCompany = new Map(), reengageByCompany = new Map();
  const pushTo = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const contactOrder = [...cById.values()].sort((a, b) => {
    const x = toIstDate(a.addedAt) || '9999', y = toIstDate(b.addedAt) || '9999';
    return x === y ? a._row - b._row : (x < y ? -1 : 1);
  });
  for (const c of contactOrder) {
    if (!isSendableContact(c) || !str(c.companyId)) continue;
    const os = outreachByRecruiter.get(str(c.recruiterId)) || [];
    if (os.length === 0) pushTo(freshByCompany, str(c.companyId), c);
    else if (reengageAfter > 0 && os.length === 1 && stateOf(os[0]) === 'EXHAUSTED') {
      const ended = toIstDate(os[0].endedAt);
      if (ended && daysBetween(ended, today) >= reengageAfter) pushTo(reengageByCompany, str(c.companyId), c);
    }
  }

  // 3 ── settle jobs ─────────────────────────────────────────────────────────
  const jobsById = new Map();
  for (const j of jobs) if (str(j.jobid)) jobsById.set(str(j.jobid), j);
  const lastWave = new Map();
  for (const j of jobs) {
    if (str(j.outreachStatus).toUpperCase() !== 'PICKED') continue;
    const cid = str(j.companyId) || resolveCompany(companyIndex, j.company);
    const d = toIstDate(j.outreachAt);
    if (cid && d && (!lastWave.has(cid) || d > lastWave.get(cid))) lastWave.set(cid, d);
  }
  const jobCounts = {};
  const countJob = s => { jobCounts[s] = (jobCounts[s] || 0) + 1; };
  const unresolved = new Set();
  const groups = new Map();
  if (sendDay) {
    for (const j of jobs) {
      if (str(j.outreachStatus) || !str(j.jobid)) continue;
      const prio = isYes(j.isPriority);
      const cid = str(j.companyId) || resolveCompany(companyIndex, j.company);
      if (!cid) { setJob(j, { outreachStatus: JOB_STATUS.UNRESOLVED, outreachAt: nowTs }); unresolved.add(str(j.company)); countJob('UNRESOLVED'); continue; }
      const extra = str(j.companyId) ? {} : { companyId: cid };
      const added = toIstDate(j.addedAt);
      if (!prio && (!added || businessDaysBetween(added, today, sendDays, holidays) > maxAge)) {
        setJob(j, { outreachStatus: JOB_STATUS.EXPIRED, outreachAt: nowTs, ...extra }); countJob('EXPIRED'); continue;
      }
      let score = numOrNull(j.score);
      let scoreSource = 'sheet';
      if (score === null && ai.scores && ai.scores[str(j.jobid)] !== undefined) { score = numOrNull(ai.scores[str(j.jobid)]); scoreSource = 'ai'; }
      pushTo(groups, cid, { job: j, cid, prio, score, eff: score === null ? 0 : score, scoreSource, extra });
    }
  }
  const byRank = (a, b) => (b.prio - a.prio) || (b.eff - a.eff) || cmpJobIdDesc(a.job.jobid, b.job.jobid);
  const eligible = [];
  for (const [cid, list] of groups) {
    list.sort(byRank);
    const best = list[0];
    for (const s of list.slice(1)) { setJob(s.job, { outreachStatus: JOB_STATUS.SIBLING, outreachAt: nowTs, ...s.extra }); countJob('SIBLING'); }
    const wave = lastWave.get(cid);
    if (!best.prio && wave && daysBetween(wave, today) < cooldown) { setJob(best.job, { outreachStatus: JOB_STATUS.COOLDOWN, outreachAt: nowTs, ...best.extra }); countJob('COOLDOWN'); continue; }
    if (!best.prio && best.eff < minScore) { setJob(best.job, { outreachStatus: JOB_STATUS.LOW_SCORE, outreachAt: nowTs, ...best.extra }); countJob('LOW_SCORE'); continue; }
    best.siblings = list.length - 1;
    eligible.push(best);
  }
  eligible.sort(byRank);

  // 4 ── who is due today ────────────────────────────────────────────────────
  const due = [];
  if (sendDay) {
    for (const o of activeByRecruiter.values()) {
      const step = numOrNull(o.step) || 0;
      const nsd = toIstDate(o.nextSendDate);
      if (step >= maxMails || !nsd || nsd > today || !str(o.threadId)) continue;
      const c = cById.get(str(o.recruiterId));
      if (!isSendableContact(c)) continue;
      due.push({ o, c, cid: str(o.companyId) || str(c.companyId) });
    }
  }

  // 5 ── merges, then generic follow-ups ─────────────────────────────────────
  const usedRecruiters = new Set();
  const jobPlans = [];
  for (const e of eligible) {
    const fresh = (freshByCompany.get(e.cid) || []).concat(
      (e.prio || e.eff >= reengageMin) ? (reengageByCompany.get(e.cid) || []) : []);
    const dueHere = due.filter(d => d.cid === e.cid && !usedRecruiters.has(str(d.o.recruiterId)))
      .sort((a, b) => ((str(b.o.type).toUpperCase() === 'JOB') - (str(a.o.type).toUpperCase() === 'JOB')) ||
        (str(a.o.lastSentAt) < str(b.o.lastSentAt) ? -1 : 1));
    if (!fresh.length && !dueHere.length) {
      setJob(e.job, { outreachStatus: JOB_STATUS.NO_CONTACTS, outreachAt: nowTs, ...e.extra }); countJob('NO_CONTACTS'); continue;
    }
    const mergeLimit = Math.max(0, maxPerJob - Math.min(newPerJob, fresh.length));
    const merges = dueHere.slice(0, mergeLimit);
    merges.forEach(d => usedRecruiters.add(str(d.o.recruiterId)));
    jobPlans.push({ e, fresh, merges });
  }
  const followups = due.filter(d => !usedRecruiters.has(str(d.o.recruiterId)))
    .sort((a, b) => (toIstDate(a.o.nextSendDate) < toIstDate(b.o.nextSendDate) ? -1 : toIstDate(a.o.nextSendDate) > toIstDate(b.o.nextSendDate) ? 1 : (str(a.o.lastSentAt) < str(b.o.lastSentAt) ? -1 : 1)));

  // 6 ── budget: commitments first, so new threads only start when there is room
  const mandatory = [
    ...jobPlans.flatMap(p => p.merges.map(d => ({ kind: 'NEW_ROLE', d, p }))),
    ...followups.map(d => ({ kind: 'FOLLOWUP', d })),
  ];
  const kept = mandatory.slice(0, Math.max(0, cap));
  const deferredCommitments = mandatory.length - kept.length;
  let budget = Math.max(0, cap - kept.length);
  const usedContacts = new Set();
  const freshPicks = [];
  for (const p of jobPlans) {
    const avail = p.fresh.filter(c => !usedContacts.has(str(c.recruiterId)));
    const n = Math.max(0, Math.min(newPerJob, avail.length, budget));
    avail.slice(0, n).forEach(c => { usedContacts.add(str(c.recruiterId)); freshPicks.push({ kind: 'JOB_NEW', c, p }); });
    budget -= n;
    p.freshTaken = n;
    p.freshLeft = (freshByCompany.get(p.e.cid) || []).filter(c => !usedContacts.has(str(c.recruiterId))).length;
  }

  // 7 ── cold intros (off unless coldPerDay > 0) ─────────────────────────────
  const coldPicks = [];
  if (sendDay && coldPerDay > 0 && budget > 0) {
    const busy = new Set(jobPlans.map(p => p.e.cid));
    const queues = [...freshByCompany.entries()]
      .filter(([cid]) => !busy.has(cid) && !(lastWave.has(cid) && daysBetween(lastWave.get(cid), today) < quietDays))
      .map(([cid, list]) => ({ cid, list: list.filter(c => !usedContacts.has(str(c.recruiterId))), taken: 0 }))
      .filter(q => q.list.length > reserve)
      .sort((a, b) => b.list.length - a.list.length);
    let n = Math.min(coldPerDay, budget), moved = true;
    while (n > 0 && moved) {
      moved = false;
      for (const q of queues) {
        if (n <= 0) break;
        if (q.list.length - q.taken > reserve) {
          const c = q.list[q.taken++];
          usedContacts.add(str(c.recruiterId));
          coldPicks.push({ kind: 'COLD_NEW', c, cid: q.cid });
          n--; moved = true;
        }
      }
    }
    budget -= coldPicks.length;
  }

  // 8 ── turn decisions into fully rendered mails ────────────────────────────
  const queue = [];
  const nextGap = stepAfter => (stepAfter >= maxMails ? exhaustAfter : (gaps[stepAfter - 1] || gaps[gaps.length - 1] || 3));
  const ctxFor = (c, job, cid, jobId, role) => ({
    FirstName: firstNameOf(c.name) || 'there',
    LastName: str(c.name).split(/\s+/).slice(1).join(' '),
    FullName: str(c.name),
    Company: companyName(cid, (job && job.company) || c.company),
    Role: str(job && job.title) || str(role) || 'open',
    JobURL: jobUrlOf(job, jobId),
    JobId: str(jobId),
    PitchLine: (jobId && ai.pitches && ai.pitches[str(jobId)]) || '',
    ApplyPhrase: job && isYes(job.applied) ? "I've applied for it" : "I'm applying for it now",
    SenderName: cfgStr(cfg, 'senderName', ''),
    ResumeURL: cfgStr(cfg, 'resumeLink', ''),
    MyEmail: cfgStr(cfg, 'myEmail', ''),
  });

  const makeItem = (kind, { c, o, job, cid, score, order }) => {
    const isNew = kind === 'JOB_NEW' || kind === 'COLD_NEW';
    const prevStep = isNew ? 0 : (numOrNull(o.step) || 0);
    const stepAfter = prevStep + 1;
    const oldType = o ? (str(o.type).toUpperCase() || 'JOB') : '';
    const typeAfter = kind === 'COLD_NEW' ? 'COLD' : kind === 'FOLLOWUP' ? oldType : 'JOB';
    const override = o ? str(o.templateOverride).toUpperCase() : '';
    const codes = override ? [override]
      : kind === 'FOLLOWUP' ? [`${oldType}_FU${prevStep}`, `${oldType}_FU`]
      : [kind];
    const tpl = findTemplate(templates, codes);
    const who = `${str(c.name) || c.recruiterId} @ ${companyName(cid, c.company)}`;
    if (!tpl) { alerts.push(`Template ${codes.join(' / ')} missing or empty, skipped ${who}`); return null; }
    const rid = str(c.recruiterId);
    const jobId = job ? str(job.jobid) : (o ? str(o.jobId) : '');
    const outreachId = isNew ? hashId('O', `${rid}|${today}|${jobId || 'cold'}`) : str(o.outreachId);
    if (logged.has(`${outreachId}#${stepAfter}`)) return null; // already sent (re-run safety)
    const role = job ? str(job.title) : (o ? str(o.role) : '');
    const ctx = ctxFor(c, job, cid, jobId, role);
    const subject = isNew ? renderTemplate(tpl.subject, ctx) : '';
    if (isNew && !subject) { alerts.push(`Template ${tpl.code} has no subject, skipped ${who}`); return null; }
    const body = renderTemplate(tpl.body, ctx);
    const nextSendDate = addBusinessDays(today, nextGap(stepAfter), sendDays, holidays);
    const nextTemplate = stepAfter >= maxMails ? '' : `${typeAfter}_FU${stepAfter}`;
    const common = { step: stepAfter, nextTemplate, nextSendDate, lastSentAt: '__SENT_AT__', note: '' };
    const outreachFields = isNew ? {
      outreachId, recruiterId: rid, recruiterName: str(c.name), company: companyName(cid, c.company), companyId: cid,
      type: typeAfter, originType: typeAfter, jobId, role, state: 'ACTIVE', templateOverride: '',
      threadId: '__THREAD_ID__', lastMessageId: '__MESSAGE_ID__', subject, createdAt: '__SENT_AT__', endedAt: '', endReason: '', ...common,
    } : {
      ...common, lastMessageId: '__MESSAGE_ID__',
      ...(kind === 'NEW_ROLE' ? { type: 'JOB', jobId, role } : {}),
      ...(override ? { templateOverride: '' } : {}),
    };
    return {
      order, kind, templateCode: tpl.code, attachResume: isYes(tpl.attachResume), outreachId, isNewThread: isNew,
      threadId: isNew ? '' : str(o.threadId), lastSentAt: isNew ? '' : str(o.lastSentAt), to: normEmail(c.email), recruiterId: rid, recruiterName: str(c.name),
      company: companyName(cid, c.company), companyId: cid, jobId, role, score: score === undefined ? '' : score,
      subject, body, stepAfter, outreachFields,
      checkJobId: (kind === 'JOB_NEW' || kind === 'NEW_ROLE') ? jobId : '',
    };
  };

  const add = (kind, args) => { const it = makeItem(kind, args); if (it) queue.push(it); return !!it; };
  const keptMerges = kept.filter(k => k.kind === 'NEW_ROLE');
  const mailsPerPlan = new Map();
  const bump = p => mailsPerPlan.set(p, (mailsPerPlan.get(p) || 0) + 1);
  let order = 1;
  for (const k of keptMerges) {
    const job = k.p.e.job;
    if (add('NEW_ROLE', { c: k.d.c, o: k.d.o, job, cid: k.p.e.cid, score: k.p.e.score, order: order++ })) bump(k.p);
  }
  for (const f of freshPicks) {
    const job = f.p.e.job;
    if (add('JOB_NEW', { c: f.c, job, cid: f.p.e.cid, score: f.p.e.score, order: order++ })) bump(f.p);
  }
  for (const k of kept.filter(x => x.kind === 'FOLLOWUP')) {
    const job = jobsById.get(str(k.d.o.jobId)) || null;
    add('FOLLOWUP', { c: k.d.c, o: k.d.o, job: str(k.d.o.type).toUpperCase() === 'JOB' ? job : null, cid: k.d.cid, order: order++ });
  }
  for (const cp of coldPicks) add('COLD_NEW', { c: cp.c, cid: cp.cid, order: order++ });

  const picked = [], deferredJobs = [];
  for (const p of jobPlans) {
    const n = mailsPerPlan.get(p) || 0;
    if (n > 0) {
      setJob(p.e.job, { outreachStatus: JOB_STATUS.PICKED, outreachAt: nowTs, ...p.e.extra }); countJob('PICKED');
      picked.push({
        company: companyName(p.e.cid, p.e.job.company), title: str(p.e.job.title), jobId: str(p.e.job.jobid),
        score: p.e.score, scoreSource: p.e.scoreSource, prio: p.e.prio, fresh: p.freshTaken || 0,
        merges: queue.filter(q => q.kind === 'NEW_ROLE' && q.jobId === str(p.e.job.jobid)).length,
        freshLeft: p.freshLeft, siblings: p.e.siblings || 0,
      });
    } else {
      deferredJobs.push(`${companyName(p.e.cid, p.e.job.company)}: ${str(p.e.job.title)}`);
    }
  }

  // 9 ── digest data ─────────────────────────────────────────────────────────
  const noContacts = [...jobWrites.entries()]
    .filter(([, f]) => f.outreachStatus === JOB_STATUS.NO_CONTACTS)
    .map(([row]) => jobs.find(j => j._row === row)).filter(Boolean)
    .map(j => companyName(str(j.companyId) || resolveCompany(companyIndex, j.company), j.company));
  const since = addCalendarDays(today, -30);
  const sent30 = mailLog.filter(l => toIstDate(l.sentAt) >= since && str(l.result).toUpperCase() === 'OK').length;
  const threads30 = [...oById.values()].filter(o => toIstDate(o.createdAt) >= since);
  const rate = type => {
    const t = threads30.filter(o => str(o.originType).toUpperCase() === type);
    const r = t.filter(o => stateOf(o) === 'REPLIED').length;
    return { threads: t.length, replied: r };
  };
  const counts = { NEW_ROLE: 0, JOB_NEW: 0, FOLLOWUP: 0, COLD_NEW: 0 };
  queue.forEach(q => { counts[q.kind]++; });

  return {
    sendDay,
    outreachWrites: [...outreachWrites.entries()].map(([id, fields]) => ({ outreachId: id, _row: oById.get(id) ? oById.get(id)._row : null, fields })),
    contactWrites: [...contactWrites.entries()].map(([rid, fields]) => ({ recruiterId: rid, _row: cById.get(rid) ? cById.get(rid)._row : null, fields })),
    jobWrites: [...jobWrites.entries()].map(([row, fields]) => ({ _row: row, fields })),
    queue,
    digest: {
      today, sendDay, counts, total: queue.length, cap, deferredCommitments, picked, deferredJobs,
      jobCounts, noContacts: [...new Set(noContacts)], unresolved: [...unresolved], alerts,
      events: sync.events || [],
      stats: { sent30, job: rate('JOB'), cold: rate('COLD') },
      lowPools: picked.filter(p => p.freshLeft < newPerJob).map(p => `${p.company} (${p.freshLeft} fresh left)`),
    },
  };
}
