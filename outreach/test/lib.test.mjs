import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs } from '../libs.mjs';

const L = loadLibs();
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const NONE = new Set();

test('IST dates and business days (spec timeline)', () => {
  assert.equal(L.addBusinessDays('2026-10-12', 3, WEEKDAYS, NONE), '2026-10-15');
  assert.equal(L.addBusinessDays('2026-10-15', 4, WEEKDAYS, NONE), '2026-10-21');
  assert.equal(L.addBusinessDays('2026-10-21', 7, WEEKDAYS, NONE), '2026-10-30');
  assert.equal(L.addBusinessDays('2026-10-05', 3, WEEKDAYS, NONE), '2026-10-08');
  assert.equal(L.addBusinessDays('2026-10-09', 1, WEEKDAYS, new Set(['2026-10-12'])), '2026-10-13');
  assert.equal(L.istDateStr(new Date('2026-10-09T19:00:00Z')), '2026-10-10'); // 00:30 IST next day
  assert.equal(L.toIstDate('2026-10-09 10:32:00'), '2026-10-09');
  assert.equal(L.toIstDate(46304), '2026-10-09');           // sheet serial
  assert.equal(L.toIstDate('09/10/2026'), '2026-10-09');    // DD/MM/YYYY
  assert.equal(L.toIstDate('1791522708000'), L.istDateStr(new Date(1791522708000)));
  assert.equal(L.istMinutesOfDay(new Date('2026-10-09T04:00:00Z')), 9 * 60 + 30);
});

test('hashId is deterministic and alphanumeric', () => {
  const a = L.hashId('R', 'linkedin.com/in/priya');
  assert.equal(a, L.hashId('R', 'linkedin.com/in/priya'));
  assert.notEqual(a, L.hashId('R', 'linkedin.com/in/priyA'));
  assert.match(a, /^R[0-9a-z]+$/);
});

test('company resolver maps every LinkedIn name in Result to a CompanyID', () => {
  const companies = [['Akamai', 3925], ['Expedia', 2751], ['InMobi', 272972], ['Booking Holdings', 10198247], ['Booking.com', 11348],
    ['DeShaw', 2408262], ['JPMC', 1068], ['Walmart Global Tech India', 9390173], ['Nvidia', 3608], ['Slice', 30246063],
    ['Hotstar (Disney+)', 5895894], ['JioHotstar', 105490663], ['Meta', 10667], ['Gitlab', 5101804]]
    .map(([Company, CompanyID], i) => ({ Company, CompanyID, Aliases: Company === 'JPMC' ? 'JPMorganChase; J.P. Morgan' : '', _row: i + 2 }));
  const idx = L.buildCompanyIndex(companies);
  const cases = {
    'Akamai Technologies': '3925', 'Expedia Group': '2751', 'InMobi Advertising': '272972',
    'Booking Holdings (NASDAQ: BKNG)': '10198247', 'Booking.com': '11348', 'D. E. Shaw India Private Limited': '2408262',
    JPMorganChase: '1068', 'Walmart Global Tech India': '9390173', NVIDIA: '3608', slice: '30246063', JioHotstar: '105490663',
    GitLab: '5101804', 'Meta Platforms': '', Metabase: '', '': '',
  };
  for (const [name, id] of Object.entries(cases)) assert.equal(L.resolveCompany(idx, name), id, name);
});

test('MIME: reply headers, utf-8 subject, attachment, base64url', () => {
  const raw = L.buildRawMessage({ fromName: 'Mahir R', fromEmail: 'me@x.com', to: 'r@y.com', subject: 'Re: SDE II – Bengaluru',
    body: 'Hi ₹ test', inReplyTo: '<abc@mail>', references: '<root@mail>', attachment: { b64: 'JVBERi0=', name: 'Resume.pdf' } });
  assert.doesNotMatch(raw, /[+/=]/);
  const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(text, /^From: Mahir R <me@x.com>\r\nTo: r@y.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(text, /In-Reply-To: <abc@mail>\r\nReferences: <root@mail> <abc@mail>/);
  assert.match(text, /Content-Disposition: attachment; filename="Resume.pdf"/);
  const bodyB64 = text.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, '');
  assert.equal(Buffer.from(bodyB64, 'base64').toString('utf8'), 'Hi ₹ test');
});

test('templates: blank placeholder lines collapse, fallback codes', () => {
  const t = { JOB_FU: { subject: '', body: 'Hi {{FirstName}},\n\n{{PitchLine}}\n\nThanks' } };
  assert.equal(L.findTemplate(t, ['JOB_FU2', 'JOB_FU']).code, 'JOB_FU');
  assert.equal(L.renderTemplate(t.JOB_FU.body, { FirstName: 'Priya', PitchLine: '' }), 'Hi Priya,\n\nThanks');
  assert.equal(L.replySubject('Re: hello'), 'Re: hello');
  assert.equal(L.replySubject('hello'), 'Re: hello');
});

const H = (name, value) => ({ name, value });
const msg = (id, from, subject, at, extra = []) => ({ id, threadId: 't', internalDate: String(at), snippet: '', labelIds: [], payload: { headers: [H('From', from), H('Subject', subject), ...extra] } });

test('sync: reply beats out-of-office; bounce matched by failed recipient', () => {
  const cfg = {};
  const outreach = [
    { outreachId: 'O1', recruiterId: 'R1', state: 'ACTIVE', threadId: 'T1', nextSendDate: '2026-10-12', createdAt: '2026-10-01 10:00:00' },
    { outreachId: 'O2', recruiterId: 'R2', state: 'ACTIVE', threadId: 'T2', nextSendDate: '2026-10-12', createdAt: '2026-10-01 10:00:00' },
    { outreachId: 'O3', recruiterId: 'R3', state: 'ACTIVE', threadId: 'T3', nextSendDate: '2026-10-12', createdAt: '2026-10-01 10:00:00' },
  ];
  const contacts = [{ recruiterId: 'R1', email: 'a@c.com', name: 'A' }, { recruiterId: 'R2', email: 'b@c.com', name: 'B' }, { recruiterId: 'R3', email: 'c@c.com', name: 'C' }];
  const t0 = Date.parse('2026-10-08T05:00:00Z');
  const threads = [
    { id: 'T1', messages: [msg('m1', 'Me <me@x.com>', 'Hi', t0), msg('m2', 'A <a@c.com>', 'Automatic reply: Hi', t0 + 1e6), msg('m3', 'A <a@c.com>', 'Re: Hi', t0 + 2e6)] },
    { id: 'T2', messages: [msg('m4', 'Me <me@x.com>', 'Hi', t0), msg('m5', 'B <b@c.com>', 'Out of Office', t0 + 1e6)] },
    { id: 'TX', messages: [msg('m6', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', t0, [H('X-Failed-Recipients', 'c@c.com')])] },
  ];
  const r = L.syncThreads({ threads, outreach, contacts, myEmail: 'me@x.com', today: '2026-10-09', cfg });
  assert.equal(r.outreachChanges.get('O1').state, 'REPLIED');
  assert.equal(r.outreachChanges.get('O2').nextSendDate, '2026-10-15'); // OOO on Thu 8th + 5 business days
  assert.equal(r.outreachChanges.get('O3').state, 'BOUNCED');
  assert.equal(r.contactChanges.get('R3').emailStatus, 'BOUNCED');
  // idempotent: re-running with the pushed date does not push again
  outreach[1].nextSendDate = '2026-10-15';
  const again = L.syncThreads({ threads, outreach, contacts, myEmail: 'me@x.com', today: '2026-10-10', cfg });
  assert.equal(again.outreachChanges.has('O2'), false);
});

// ── planner scenarios ───────────────────────────────────────────────────────
const companies = [{ Company: 'Google', CompanyID: '1441', _row: 2 }, { Company: 'Expedia', CompanyID: '2751', _row: 3 },
  { Company: 'Akamai', CompanyID: '3925', _row: 4 }, { Company: 'Nutanix', CompanyID: '735085', _row: 5 }, { Company: 'Oracle', CompanyID: '1028', _row: 6 },
  { Company: 'Meesho', CompanyID: '10037698', _row: 7 }];
const templates = Object.fromEntries(L.SEED_TEMPLATES.map(t => [t[0], { subject: t[1], body: t[2], attachResume: t[3] }]));
let rowSeq = 2;
const contact = (name, cid, extra = {}) => ({ _row: rowSeq++, recruiterId: L.hashId('R', name), name, company: '', companyId: cid, isRelevant: 'Y', hold: '', email: `${name.toLowerCase()}@x.com`, emailStatus: 'VALID', addedAt: '2026-10-01 10:00:00', ...extra });
const job = (id, company, cid, score, extra = {}) => ({ _row: rowSeq++, jobid: id, title: `SDE II ${id}`, company, companyId: cid, score, addedAt: '2026-10-12 08:00:00', isPriority: '', outreachStatus: '', outreachAt: '', applied: '', ...extra });

function baseInput(over = {}) {
  return {
    cfg: { dailySendCap: 40, senderName: 'Mahir', resumeLink: 'https://drive/x', myEmail: 'me@x.com', coldPerDay: 0 },
    today: '2026-10-13', nowTs: '2026-10-13 09:30:00', contacts: [], outreach: [], mailLog: [], jobs: [],
    templates, companyIndex: L.buildCompanyIndex(companies), ...over,
  };
}

test('planner: sample Tuesday from the spec', () => {
  const g = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].map(n => contact(n, '1441'));
  const e = ['E1', 'E2', 'E3'].map(n => contact(n, '2751'));
  const a = ['A1', 'A2', 'A3', 'A4', 'A5'].map(n => contact(n, '3925'));
  const n = ['N1'].map(x => contact(x, '735085'));
  const dueG1 = { _row: 2, outreachId: 'OG1', recruiterId: g[4].recruiterId, companyId: '1441', type: 'JOB', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-13', threadId: 'tg1', lastSentAt: '2026-10-08 09:40:00', createdAt: '2026-10-08 09:40:00' };
  const dueG2 = { _row: 3, outreachId: 'OG2', recruiterId: g[5].recruiterId, companyId: '1441', type: 'COLD', state: 'ACTIVE', step: 2, nextSendDate: '2026-10-12', threadId: 'tg2', lastSentAt: '2026-10-06 09:40:00', createdAt: '2026-10-01 09:40:00' };
  const dueA = { _row: 4, outreachId: 'OA5', recruiterId: a[4].recruiterId, companyId: '3925', type: 'COLD', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-13', threadId: 'ta5', lastSentAt: '2026-10-08 09:40:00', createdAt: '2026-10-08 09:40:00' };
  const dueN = { _row: 5, outreachId: 'ON1', recruiterId: n[0].recruiterId, companyId: '735085', type: 'JOB', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-13', threadId: 'tn1', lastSentAt: '2026-10-08 09:40:00', createdAt: '2026-10-08 09:40:00' };
  const jobs = [
    job('4400000001', 'Akamai Technologies', '', 72, { isPriority: 'Y' }),
    job('4400000010', 'Google', '1441', 91), job('4400000011', 'Google', '1441', 85), job('4400000012', 'Google', '1441', null),
    job('4400000020', 'Expedia Group', '', 88),
    job('4400000030', 'Nutanix', '735085', 84),
    job('4400000040', 'Oracle', '1028', 65),
    job('4400000050', 'Meesho', '10037698', 90),
    job('4400000060', 'Google', '1441', 95, { addedAt: '2026-10-06 08:00:00' }), // too old
    job('4300000000', 'Nutanix', '735085', 80, { outreachStatus: 'PICKED', outreachAt: '2026-10-09 09:30:00' }),
  ];
  const r = L.planOutreach(baseInput({ contacts: [...g, ...e, ...a, ...n], outreach: [dueG1, dueG2, dueA, dueN], jobs }));
  const st = Object.fromEntries(r.jobWrites.map(w => [jobs.find(j => j._row === w._row).jobid, w.fields.outreachStatus]));
  assert.equal(st['4400000001'], 'PICKED');      // priority, score 72 still goes
  assert.equal(st['4400000010'], 'PICKED');      // Google best
  assert.equal(st['4400000011'], 'SIBLING');
  assert.equal(st['4400000012'], 'SIBLING');
  assert.equal(st['4400000020'], 'PICKED');
  assert.equal(st['4400000030'], 'COOLDOWN');    // Nutanix wave 4 days ago
  assert.equal(st['4400000040'], 'LOW_SCORE');
  assert.equal(st['4400000050'], 'NO_CONTACTS');
  assert.equal(st['4400000060'], 'EXPIRED');
  assert.equal(r.digest.picked[0].company, 'Akamai'); // priority ranks first
  const kinds = r.queue.map(q => `${q.kind}:${q.company}`);
  assert.deepEqual(r.digest.counts, { NEW_ROLE: 3, JOB_NEW: 11, FOLLOWUP: 1, COLD_NEW: 0 });
  assert.ok(kinds.includes('FOLLOWUP:Nutanix'));      // cooldown company still gets its due follow-up
  const nr = r.queue.filter(q => q.kind === 'NEW_ROLE');
  assert.equal(nr[0].company, 'Akamai');
  assert.equal(nr[1].outreachId, 'OG1');                // job thread before cold thread
  assert.equal(nr[1].outreachFields.type, 'JOB');
  assert.equal(nr[2].outreachFields.type, 'JOB');       // cold → job conversion
  assert.equal(nr[2].outreachFields.step, 3);
  assert.equal(nr[2].outreachFields.nextSendDate, '2026-10-22'); // after 3rd mail: +7 business days
  const fresh = r.queue.filter(q => q.kind === 'JOB_NEW');
  assert.equal(fresh.filter(q => q.company === 'Google').length, 4);
  assert.equal(fresh.filter(q => q.company === 'Expedia').length, 3);
  assert.equal(fresh[0].outreachFields.nextSendDate, '2026-10-16'); // +3 business days
  assert.match(fresh[0].subject, /^SDE II \d+ at (Akamai|Google) \(Job ID \d+\)$/);
  assert.equal(fresh[0].attachResume, true);
  assert.equal(nr[0].attachResume, false);
  assert.match(nr[0].body, /https:\/\/drive\/x/);
  assert.deepEqual(r.digest.noContacts, ['Meesho']);
});

test('planner: cap defers new threads, never commitments first', () => {
  const g = ['G1', 'G2', 'G3', 'G4', 'G5'].map(n => contact(n, '1441'));
  const fu = g.slice(0, 2).map((c, i) => ({ _row: i + 2, outreachId: `O${i}`, recruiterId: c.recruiterId, companyId: '2751', type: 'COLD', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-13', threadId: `t${i}`, lastSentAt: '2026-10-08', createdAt: '2026-10-08' }));
  // these two are due but belong to Expedia ids for this test; contacts live at Google → generic follow-ups
  g[0].companyId = '2751'; g[1].companyId = '2751';
  const jobs = [job('4400000010', 'Google', '1441', 91)];
  const r = L.planOutreach(baseInput({ cfg: { ...baseInput().cfg, dailySendCap: 3 }, contacts: g, outreach: fu, jobs }));
  assert.deepEqual(r.digest.counts, { NEW_ROLE: 0, JOB_NEW: 1, FOLLOWUP: 2, COLD_NEW: 0 });
  // cap 2 → no room for fresh, job stays blank (deferred)
  const r2 = L.planOutreach(baseInput({ cfg: { ...baseInput().cfg, dailySendCap: 2 }, contacts: g.map(c => ({ ...c })), outreach: fu.map(o => ({ ...o })), jobs: [job('4400000013', 'Google', '1441', 91)] }));
  assert.equal(r2.digest.counts.JOB_NEW, 0);
  assert.equal(r2.jobWrites.length, 0);
  assert.equal(r2.digest.deferredJobs.length, 1);
});

test('planner: hygiene, idempotency, weekend, max mails, holds', () => {
  const c1 = contact('H1', '1441', { hold: 'Y' });
  const c2 = contact('H2', '1441');
  const c3 = contact('H3', '1441');
  const outreach = [
    { _row: 2, outreachId: 'OH1', recruiterId: c1.recruiterId, companyId: '1441', type: 'JOB', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-13', threadId: 't1', createdAt: '2026-10-01' },
    { _row: 3, outreachId: 'OH2', recruiterId: c2.recruiterId, companyId: '1441', type: 'JOB', state: 'ACTIVE', step: 4, nextSendDate: '2026-10-13', threadId: 't2', createdAt: '2026-10-01' },
    { _row: 4, outreachId: 'OH3', recruiterId: c3.recruiterId, companyId: '1441', type: 'JOB', state: 'ACTIVE', step: 2, nextSendDate: '2026-10-13', threadId: 't3', createdAt: '2026-10-01' },
  ];
  const mailLog = [{ outreachId: 'OH3', step: 3, result: 'OK', sentAt: '2026-10-13 09:31:00' }];
  const r = L.planOutreach(baseInput({ contacts: [c1, c2, c3], outreach, mailLog }));
  const w = Object.fromEntries(r.outreachWrites.map(x => [x.outreachId, x.fields]));
  assert.equal(w.OH1.state, 'STOPPED');
  assert.equal(w.OH2.state, 'EXHAUSTED');
  assert.equal(r.queue.length, 0); // OH3 step 3 already logged today
  const weekend = L.planOutreach(baseInput({ today: '2026-10-17', contacts: [c3], outreach: [{ ...outreach[2] }], jobs: [job('4400000099', 'Google', '1441', 99)] }));
  assert.equal(weekend.sendDay, false);
  assert.equal(weekend.queue.length, 0);
  assert.equal(weekend.jobWrites.length, 0);
});

test('planner: cold intros only where there is no recent opening; re-engagement', () => {
  const oracle = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'].map(n => contact(n, '1028'));     // no openings at all
  const google = ['Y1', 'Y2'].map(n => contact(n, '1441'));                           // opening 2 days ago (not picked)
  const expedia = ['W1'].map(n => contact(n, '2751'));                                // last opening 6 days ago
  const jobs = [job('4400000301', 'Google', '1441', 70, { addedAt: '2026-10-11 08:00:00', outreachStatus: 'LOW_SCORE' }),
    job('4400000302', 'Expedia', '2751', 90, { addedAt: '2026-10-07 08:00:00', outreachStatus: 'PICKED', outreachAt: '2026-10-07 09:30:00' })];
  const r = L.planOutreach(baseInput({ cfg: { ...baseInput().cfg, coldPerDay: 5 }, contacts: [...oracle, ...google, ...expedia], jobs }));
  const cold = r.queue.filter(q => q.kind === 'COLD_NEW');
  assert.equal(cold.length, 3);
  assert.deepEqual([...new Set(cold.map(q => q.company))].sort(), ['Expedia', 'Oracle']);
  assert.equal(cold.filter(q => q.company === 'Oracle').length, 2);                  // coldPerCompanyPerDay
  assert.deepEqual(r.digest.coldHeldForOpenings, ['Google']);
  assert.equal(cold[0].templateCode, 'COLD_NEW');
  // re-engagement: exhausted 100 days ago, only for score >= 90
  const old = contact('Z1', '1441');
  const out = [{ _row: 2, outreachId: 'OZ', recruiterId: old.recruiterId, companyId: '1441', type: 'JOB', state: 'EXHAUSTED', step: 4, endedAt: '2026-07-01 10:00:00', createdAt: '2026-06-01' }];
  const hi = L.planOutreach(baseInput({ contacts: [old], outreach: out, jobs: [job('4400000101', 'Google', '1441', 92)] }));
  assert.equal(hi.digest.counts.JOB_NEW, 1);
  const lo = L.planOutreach(baseInput({ contacts: [{ ...old }], outreach: out.map(o => ({ ...o })), jobs: [job('4400000102', 'Google', '1441', 85)] }));
  assert.equal(lo.digest.counts.JOB_NEW, 0);
  assert.deepEqual(lo.digest.noContacts, ['Google']);
});

test('compose: refuses to send when a reply landed after planning', () => {
  const thread = { messages: [msg('m1', 'me@x.com', 'SDE II at Google', 1, [H('Message-ID', '<a@x>')]), msg('m2', 'R <r@g.com>', 'Re: SDE II at Google', 2)] };
  const item = { isNewThread: false, threadId: 't', to: 'r@g.com', body: 'hi', attachResume: false };
  const res = L.composeMail({ item, cfg: { mode: 'SEND', myEmail: 'me@x.com' }, thread, resume: null });
  assert.equal(res.reason, 'REPLIED');
  const ok = L.composeMail({ item, cfg: { mode: 'SEND', myEmail: 'me@x.com' }, thread: { messages: [thread.messages[0]] }, resume: null });
  assert.equal(ok.skip, false);
  assert.equal(ok.apiBody.threadId, 't');
  assert.equal(ok.subject, 'Re: SDE II at Google');
  const justNow = { messages: [msg('m9', 'me@x.com', 'SDE II at Google', Date.now() - 3600e3, [H('Message-ID', '<z@x>')])] };
  const dup = L.composeMail({ item: { ...item, lastSentAt: '2026-10-01 09:30:00' }, cfg: { mode: 'SEND', myEmail: 'me@x.com' }, thread: justNow, resume: null });
  assert.equal(dup.reason, 'ALREADY_SENT');
  const recorded = L.istTsStr(new Date(Date.now() - 3600e3));
  assert.equal(L.composeMail({ item: { ...item, lastSentAt: recorded }, cfg: { mode: 'SEND', myEmail: 'me@x.com' }, thread: justNow, resume: null }).skip, false);
  const draft = L.composeMail({ item: { ...item, isNewThread: true, subject: 'Hello' }, cfg: { mode: 'DRAFT', myEmail: 'me@x.com' }, resume: null });
  assert.match(draft.apiUrl, /drafts$/);
  assert.equal(L.gateItem({ cfg: {}, now: new Date('2026-10-13T08:00:00Z') }).skip, true); // 13:30 IST
});

test('record: upsert by id, append mail log once', () => {
  const headers = { Outreach: L.HEADERS.Outreach, 'Mail Log': L.HEADERS['Mail Log'] };
  const item = { outreachId: 'O9', isNewThread: true, stepAfter: 1, recruiterId: 'R9', jobId: '1', templateCode: 'JOB_NEW', kind: 'JOB_NEW', to: 'r@x.com',
    outreachFields: { outreachId: 'O9', step: 1, state: 'ACTIVE', threadId: '__THREAD_ID__', lastSentAt: '__SENT_AT__', lastMessageId: '__MESSAGE_ID__' } };
  const res = L.recordMail({ item, response: { id: 'msg1', threadId: 'thr1' }, mode: 'SEND', now: new Date('2026-10-13T04:10:00Z'), headers, subject: 'S',
    idColumns: { Outreach: [['outreachId'], ['O1']], 'Mail Log': [['logId']] } });
  assert.equal(res.data[0].range, "'Outreach'!A3:V3");
  assert.equal(res.data[0].values[0][L.HEADERS.Outreach.indexOf('threadId')], 'thr1');
  assert.equal(res.data[1].range, "'Mail Log'!A2:R2");
  const draft = L.recordMail({ item, response: { id: 'r-draft-1', message: { id: 'm1', threadId: 'thr1' } }, mode: 'DRAFT', now: new Date(), headers, subject: 'S',
    idColumns: { Outreach: [['outreachId']], 'Mail Log': [['logId']] } });
  const lr = draft.data[1].values[0], lh = L.HEADERS['Mail Log'];
  assert.equal(lr[lh.indexOf('draftId')], 'r-draft-1');
  assert.equal(lr[lh.indexOf('messageId')], 'm1');
  assert.equal(lr[lh.indexOf('delivery')], 'DRAFTED');
  const upd = L.recordMail({ item: { ...item, isNewThread: false }, response: { id: 'm2', threadId: 'thr1' }, mode: 'SEND', now: new Date(), headers,
    idColumns: { Outreach: [['outreachId'], ['O1'], ['O9']], 'Mail Log': [['logId'], [L.hashId('L', 'O9#1')]] } });
  assert.equal(upd.data.length, 5); // 5 changed cells, no duplicate log row
  assert.ok(upd.data.every(d => /^'Outreach'!/.test(d.range)));
});

test('enrichment: ids, duplicates, submit body, results mapping', () => {
  const idx = L.buildCompanyIndex(companies);
  const contacts = [
    { _row: 2, name: 'Priya Sharma', company: 'Expedia Group', linkedinUrl: 'https://www.linkedin.com/in/priya/', isRelevant: 'Y' },
    { _row: 3, name: 'Priya S', company: 'Expedia', linkedinUrl: 'linkedin.com/in/priya', isRelevant: 'Y' },
    { _row: 4, name: 'Solo', company: 'Expedia', isRelevant: 'Y' },
    { _row: 5, name: 'Not Me', company: 'Google', linkedinUrl: 'linkedin.com/in/nyet', isRelevant: 'N' },
  ];
  const p = L.prepareEnrichment({ contacts, companyIndex: idx, cfg: {}, nowTs: '2026-10-13 10:00:00' });
  const byRow = Object.fromEntries(p.updates.map(u => [u._row, u.fields]));
  assert.equal(byRow[2].companyId, '2751');
  assert.equal(byRow[3].enrichStatus, 'DUPLICATE');
  assert.equal(p.submit.datas.length, 1);
  assert.deepEqual(p.submit.datas[0].enrich_fields, ['contact.emails']);
  assert.equal(p.submit.datas[0].company_name, 'Expedia');
  assert.ok(p.alerts.some(a => /Solo/.test(a)));
  const rid = byRow[2].recruiterId;
  const fresh = [{ _row: 2, recruiterId: rid, enrichmentId: 'E1', enrichStatus: 'PENDING' }];
  const res = L.applyEnrichmentResults({ results: [{ id: 'E1', status: 'FINISHED', datas: [{ custom: { recruiterId: rid }, contact: { most_probable_email: 'priya@expedia.com', most_probable_email_status: 'DELIVERABLE' } }] }], contacts: fresh, nowTs: 'x' });
  assert.equal(res.updates[0].fields.emailStatus, 'VALID');
  assert.equal(res.found, 1);
  const inprog = L.applyEnrichmentResults({ results: [{ error: { message: 'in progress' } }], contacts: fresh, nowTs: 'x' });
  assert.equal(inprog.updates.length, 0);
});

test('enrichment: a row with only a LinkedIn URL gets id, relevance, then profile + email', () => {
  const idx = L.buildCompanyIndex(companies.concat([{ Company: 'JPMC', CompanyID: '1068', Aliases: 'JPMorganChase', _row: 9 }]));
  const talveen = { _row: 11, recruiterId: 1, name: 'Talveen', linkedinUrl: 'https://www.linkedin.com/in/talveen-kaur-768196194/', company: '', isRelevant: '', email: '' };
  const kept = { _row: 12, recruiterId: 'legacy7', name: 'Kept Id', linkedinUrl: 'linkedin.com/in/kept', isRelevant: 'Y', email: 'k@x.com', emailStatus: 'VALID' };
  const p = L.prepareEnrichment({ contacts: [talveen, kept], companyIndex: idx, cfg: {}, nowTs: '2026-10-14 10:00:00', referencedIds: ['legacy7'] });
  const f = p.updates.find(u => u._row === 11).fields;
  assert.match(f.recruiterId, /^R[0-9a-z]{9}$/);                 // "1" replaced
  assert.equal(f.isRelevant, 'Y');
  assert.equal(f.source, 'Manual');
  assert.equal(p.updates.find(u => u._row === 12).fields.recruiterId, undefined); // id used by Outreach is kept
  assert.deepEqual(p.submit.datas, [{ linkedin_url: talveen.linkedinUrl, enrich_fields: ['contact.emails'], custom: { recruiterId: f.recruiterId } }]);
  const off = L.prepareEnrichment({ contacts: [{ ...talveen }], companyIndex: idx, cfg: { defaultRelevant: 'N' }, nowTs: 'x' });
  assert.equal(off.submit, null);

  const pending = [{ ...talveen, recruiterId: f.recruiterId, enrichStatus: 'PENDING', enrichmentId: 'E1' }];
  const record = { custom: { recruiterId: f.recruiterId }, contact: {
    firstname: 'Talveen', lastname: 'Kaur', most_probable_email: 'talveen.kaur@jpmchase.com', most_probable_email_status: 'DELIVERABLE',
    profile: { firstname: 'Talveen', lastname: 'Kaur', linkedin_url: 'https://www.linkedin.com/in/talveen-kaur-768196194',
      position: { title: 'Technical Recruiter', company: { linkedin_id: 1068, name: 'JPMorganChase' } } } } };
  const r = L.applyEnrichmentResults({ results: [{ id: 'E1', status: 'FINISHED', datas: [record] }], contacts: pending, nowTs: 'now', companyIndex: idx });
  assert.deepEqual(r.updates[0].fields, { name: 'Talveen Kaur', title: 'Technical Recruiter', company: 'JPMorganChase', companyId: '1068',
    email: 'talveen.kaur@jpmchase.com', emailStatus: 'VALID', enrichStatus: 'DONE', enrichedAt: 'now' });
  // employer not in Companies: id still recorded, you get told
  const other = JSON.parse(JSON.stringify(record));
  other.contact.profile.position.company = { linkedin_id: 4242, name: 'Delivery Hero' };
  const r2 = L.applyEnrichmentResults({ results: [{ id: 'E1', status: 'FINISHED', datas: [other] }], contacts: pending, nowTs: 'now', companyIndex: idx });
  assert.equal(r2.updates[0].fields.companyId, '4242');
  assert.match(r2.alerts[0], /Delivery Hero \(LinkedIn id 4242\), which is not in the Companies tab/);
});

test('setup: headers, config, templates, LEGACY jobs and LEGACY recruiters (no Gmail)', () => {
  const coldMailing = [['Recruiter Name', 'Recruiter Email', 'Job Link', 'Job Title', 'Job Company', 'ResumeLink', 'Status', 'TemplateId', 'ThreadId', 'Timestamp'],
    ['Asha K', 'asha@expedia.com', 'https://www.linkedin.com/jobs/view/4432092573', 'SDE II', 'Expedia Group', 'x', 'FollowUp Sent', 'Follow-Up 1', 'T1', '2026-10-05'],
    ['Ravi', 'ravi@google.com', '', '', 'Google', 'x', 'Pending', '', '', ''],
    ['Dup', 'ASHA@expedia.com', '', '', 'Expedia', 'x', 'Sent', '', 'T3', '']];
  const compVals = [['Company', 'CompanyID', 'Bucket', 'Active', 'Notes'], ['Expedia', '2751', '1', 'True', ''], ['JPMC', '1068', '1', 'True', '']];
  const jobs = { resultHeader: ['title', 'company', 'location', 'description', 'jobid', 'applyLink', 'score', 'addedAt'], lowMatchHeader: ['title', 'jobid'],
    companies: compVals, jobIdCol: [['jobid'], ['1'], ['2'], ['']], companyCol: [['company'], ['Expedia Group'], ['JPMorganChase']], statusCol: [] };
  const s = L.planSetup({ tabs: {}, jobs, coldMailing, myEmail: 'me@x.com', now: new Date('2026-10-09T05:00:00Z') });
  const find = (re) => s.data.filter(d => re.test(d.range));
  assert.deepEqual(find(/^'Outreach'!A1:/)[0].values[0], L.HEADERS.Outreach);
  assert.equal(find(/^'Outreach Templates'!A[2-9]\d*:E/).length, L.SEED_TEMPLATES.length);
  assert.ok(s.data.some(d => d.values[0][0] === 'myEmail' && d.values[0][1] === 'me@x.com'));
  const ch = L.HEADERS.Contacts;
  const contacts = find(/^'Contacts'!A[2-9]/).map(d => d.values[0]);
  assert.equal(contacts.length, 2);                                   // duplicate email skipped
  assert.ok(contacts.every(r => r[ch.indexOf('hold')] === 'Y' && r[ch.indexOf('source')] === 'LEGACY'));
  assert.equal(contacts[0][ch.indexOf('companyId')], '2751');
  assert.equal(find(/^'Outreach'!A2/).length, 0);                    // no thread state imported
  assert.equal(find(/^'Mail Log'!A2/).length, 0);
  assert.deepEqual(s.data.find(d => /^'Result'!K2:K4$/.test(d.range)).values, [['LEGACY'], ['LEGACY'], ['']]);
  assert.ok(s.data.some(d => /^'Companies'!F2$/.test(d.range) && d.values[0][0] === 'Expedia Group'));
  assert.ok(s.data.some(d => /^'Companies'!F3$/.test(d.range) && /JPMorganChase/.test(d.values[0][0])));
  assert.ok(s.summary.some(x => /2 recruiters from Cold Mailing added to Contacts as LEGACY/.test(x)));
  // second run: nothing re-imported, no LEGACY rewrite
  const cfgTab = [['Setting', 'Value', 'Notes'], ['setupCompletedAt', '2026-10-09 10:00:00', ''], ['myEmail', 'me@x.com', '']];
  const again = L.planSetup({ tabs: { 'Outreach Config': cfgTab }, jobs, coldMailing, myEmail: 'me@x.com', now: new Date() });
  assert.equal(again.data.filter(d => /^'Contacts'!A[2-9]|^'Result'!K2/.test(d.range)).length, 0);
});

test('planner: a legacy (held) address is never mailed, even via a duplicate row', () => {
  const legacy = contact('Legacy', '1441', { hold: 'Y', email: 'old@google.com' });
  const again = contact('Again', '1441', { email: 'OLD@google.com' });
  const other = contact('Other', '1441');
  const r = L.planOutreach(baseInput({ contacts: [legacy, again, other], jobs: [job('4400000201', 'Google', '1441', 95)] }));
  assert.deepEqual(r.queue.map(q => q.to), ['other@x.com']);
});

test('commands', () => {
  assert.deepEqual(L.parseCommand('/p4432092573'), { cmd: 'priority', jobId: '4432092573' });
  assert.deepEqual(L.parseCommand('/a_4432092573@MyBot'), { cmd: 'applied', jobId: '4432092573' });
  assert.equal(L.parseCommand('hello'), null);
  const r = L.applyCommand({ cmd: 'priority', jobId: '1' }, { title: 'SDE', company: 'G', outreachStatus: 'LEGACY' });
  assert.deepEqual(r.fields, { isPriority: 'Y', outreachStatus: '' });
});


test('mail: HTML part keeps template line breaks only, links clickable', () => {
  const html = L.textToHtml('Hi Priya,\n\nI build services <fast> & safe.\n• one\nLinkedIn: linkedin.com/in/mahir-ratanpara\nhttps://x.com/a.');
  assert.equal(html, '<div dir="ltr">Hi Priya,<br>\n<br>\nI build services &lt;fast&gt; &amp; safe.<br>\n• one<br>\nLinkedIn: <a href="https://linkedin.com/in/mahir-ratanpara">linkedin.com/in/mahir-ratanpara</a><br>\n<a href="https://x.com/a">https://x.com/a</a>.</div>');
  const raw = L.buildRawMessage({ fromEmail: 'me@x.com', to: 'r@y.com', subject: 'S', body: 'a long paragraph '.repeat(20) });
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(mime, /Content-Type: multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/html/);
});

test('drafts: send now picks drafts by subject; pipeline drafts update Mail Log', () => {
  assert.equal(L.sendNowListUrl({}), 'https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=500&q=' + encodeURIComponent('subject:"Serving Notice Period"'));
  assert.match(L.sendNowListUrl({ sendNowSubjectContains: 'Open to SDE roles' }), /Open%20to%20SDE%20roles/);
  const draft = (subject, to = 'p@airbnb.com') => ({ id: 'r1', message: { id: 'm1', threadId: 'T1', payload: { headers: [{ name: 'Subject', value: subject }, { name: 'To', value: to }] } } });
  assert.equal(L.inspectDraft(draft('Exploring SDE Opportunities at Airbnb | Serving Notice Period'), {}).ok, true);
  assert.equal(L.inspectDraft(draft('Re: Exploring SDE Opportunities at Airbnb | serving notice period'), {}).ok, true);
  assert.equal(L.inspectDraft(draft('Dinner on Friday?'), {}).ok, false);
  assert.equal(L.inspectDraft(draft('Exploring SDE Opportunities | Serving Notice Period'), {}).to, 'p@airbnb.com');
  const log = [{ _row: 2, mode: 'DRAFT', delivery: 'DRAFTED', draftId: 'r1', threadId: 'T1', outreachId: 'O1', step: 1 },
    { _row: 3, mode: 'DRAFT', delivery: 'DRAFTED', draftId: 'old', threadId: 'T2', outreachId: 'O2', step: 2 },
    { _row: 4, mode: 'DRAFT', delivery: 'SENT', draftId: 'r9', threadId: 'T9', deliveredAt: 'x' }];
  assert.equal(L.mailLogRowForDraft(log, 'r1', 'T1')._row, 2);
  assert.equal(L.mailLogRowForDraft(log, 'edited', 'T2')._row, 3);      // edited draft: new id, same thread
  assert.equal(L.mailLogRowForDraft(log, 'r9', 'T9'), null);             // already delivered
  assert.equal(L.mailLogRowForDraft(log, 'x', 'TX'), null);              // a draft you wrote by hand
  const rec = L.recordDraftDelivery({ row: log[0], o: { _row: 2, step: 1, threadId: 'T1' }, response: { id: 'sent1', threadId: 'T1' }, now: new Date('2026-10-26T03:41:00Z'), cfg: {} });
  assert.equal(rec.log.delivery, 'SENT');
  assert.equal(rec.outreachFields.nextSendDate, '2026-10-29');           // Mon + 3 business days
  assert.equal(L.draftFailure({ error: { message: '500 backend error' }, now: new Date() }).log.delivery, 'FAILED');
});

test('drafts: reconcile deleted / sent / waiting drafts and roll threads back', () => {
  const now = new Date('2026-10-29T06:00:00Z');          // Thu 11:30 IST
  const t = iso => String(Date.parse(iso));
  const mailLog = [
    // A: first email drafted, deleted → recruiter fresh again
    { _row: 2, outreachId: 'OA', step: 1, mode: 'DRAFT', result: 'OK', delivery: 'DRAFTED', draftId: 'dA', threadId: 'TA', sentAt: '2026-10-28 09:31:00', email: 'a@x.com' },
    // B: first email sent, follow-up 1 drafted then deleted → back to step 1, due again
    { _row: 3, outreachId: 'OB', step: 1, mode: 'SEND', result: 'OK', delivery: 'SENT', threadId: 'TB', messageId: 'mB1', sentAt: '2026-10-20 09:31:00', deliveredAt: '2026-10-20 09:31:00', templateCode: 'COLD_NEW' },
    { _row: 4, outreachId: 'OB', step: 2, mode: 'DRAFT', result: 'OK', delivery: 'DRAFTED', draftId: 'dB2', threadId: 'TB', sentAt: '2026-10-28 09:32:00', templateCode: 'NEW_ROLE', jobId: '44' },
    // C: still sitting in Gmail → untouched
    { _row: 5, outreachId: 'OC', step: 1, mode: 'DRAFT', result: 'OK', delivery: 'DRAFTED', draftId: 'dC', threadId: 'TC', sentAt: '2026-10-28 09:33:00' },
    // D: sent from Gmail (no draft left, SENT message in thread)
    { _row: 6, outreachId: 'OD', step: 1, mode: 'DRAFT', result: 'OK', delivery: '', draftId: '', threadId: 'TD', sentAt: '2026-10-16 15:57:18' },
    // E: old follow-up draft deleted, a later step was sent afterwards → only the log changes, no false "sent"
    { _row: 7, outreachId: 'OE', step: 2, mode: 'DRAFT', result: 'OK', delivery: '', draftId: '', threadId: 'TE', sentAt: '2026-10-20 15:00:07' },
    { _row: 8, outreachId: 'OE', step: 3, mode: 'DRAFT', result: 'OK', delivery: 'SENT', draftId: 'dE3', threadId: 'TE', sentAt: '2026-10-27 09:31:00', deliveredAt: '2026-10-27 10:00:00' },
    // F: blocked earlier by hand (FAILED) → ignored
    { _row: 9, outreachId: 'OF', step: 3, mode: 'DRAFT', result: 'FAILED', delivery: '', threadId: 'TF', sentAt: '2026-10-23 15:00:00' },
  ];
  const outreach = [
    { _row: 2, outreachId: 'OA', state: 'ACTIVE', step: 1, type: 'JOB', recruiterName: 'A', company: 'G' },
    { _row: 3, outreachId: 'OB', state: 'ACTIVE', step: 2, type: 'JOB', jobId: '44', recruiterName: 'B', company: 'G' },
    { _row: 4, outreachId: 'OC', state: 'ACTIVE', step: 1, recruiterName: 'C', company: 'G' },
    { _row: 5, outreachId: 'OD', state: 'ACTIVE', step: 1, recruiterName: 'D', company: 'G' },
    { _row: 6, outreachId: 'OE', state: 'ACTIVE', step: 3, recruiterName: 'E', company: 'G' },
  ];
  const drafts = { drafts: [{ id: 'dC', message: { threadId: 'TC' } }, { id: 'personal', message: { threadId: 'TP' } }], resultSizeEstimate: 2 };
  assert.deepEqual(L.missingDraftThreads({ mailLog, drafts }).sort(), ['TA', 'TB', 'TD', 'TE']);
  const threads = [
    { id: 'TB', messages: [{ id: 'mB1', labelIds: ['SENT'], internalDate: t('2026-10-20T04:01:00Z') }] },
    { id: 'TD', messages: [{ id: 'mD1', labelIds: ['SENT'], internalDate: t('2026-10-16T12:00:00Z') }] },
    { id: 'TE', messages: [{ id: 'mE1', labelIds: ['SENT'], internalDate: t('2026-10-16T10:00:00Z') }, { id: 'mE3', labelIds: ['SENT'], internalDate: t('2026-10-27T04:30:00Z') }] },
  ];
  const r = L.reconcileDrafts({ mailLog, outreach, drafts, threads, now, cfg: {} });
  const log = Object.fromEntries(r.logUpdates.map(u => [u._row, u.fields]));
  const out = Object.fromEntries(r.outreachUpdates.map(u => [u._row, u.fields]));
  assert.equal(log[2].delivery, 'DISCARDED');
  assert.equal(out[2].state, 'DISCARDED');
  assert.equal(log[4].delivery, 'DISCARDED');
  assert.deepEqual({ step: out[3].step, next: out[3].nextSendDate, last: out[3].lastSentAt, msg: out[3].lastMessageId, type: out[3].type, state: out[3].state },
    { step: 1, next: '2026-10-30', last: '2026-10-20 09:31:00', msg: 'mB1', type: 'COLD', state: 'ACTIVE' });
  assert.equal(log[5], undefined);                                   // still a draft
  assert.equal(log[6].delivery, 'SENT');
  assert.equal(log[6].messageId, 'mD1');
  assert.equal(out[5].nextSendDate, L.addBusinessDays('2026-10-16', 3, new Set([1, 2, 3, 4, 5]), new Set()));
  assert.equal(log[7].delivery, 'DISCARDED');                        // mE3 belongs to step 3, not this draft
  assert.equal(out[6], undefined);                                   // later step exists → no rollback
  assert.equal(log[9], undefined);
  assert.match(L.formatReconcileNote(r), /3 drafts deleted without sending/);
  // never trust an incomplete or failed draft list
  assert.equal(L.reconcileDrafts({ mailLog, outreach, drafts: { ...drafts, nextPageToken: 'x' }, threads, now, cfg: {} }).skipped, true);
  assert.equal(L.reconcileDrafts({ mailLog, outreach, drafts: { error: { message: '500' } }, threads, now, cfg: {} }).logUpdates.length, 0);
  assert.deepEqual(L.missingDraftThreads({ mailLog, drafts: {} }), []);

  // planner: the discarded first email frees the recruiter; the rolled-back follow-up is re-planned
  const cA = contact('Ann', '1441', { recruiterId: 'RA' });
  const cB = contact('Ben', '1441', { recruiterId: 'RB' });
  const after = [{ _row: 2, outreachId: 'OA', recruiterId: 'RA', companyId: '1441', state: 'DISCARDED', step: 1, createdAt: '2026-10-28' },
    { _row: 3, outreachId: 'OB', recruiterId: 'RB', companyId: '1441', type: 'COLD', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-30', threadId: 'TB', lastSentAt: '2026-10-20 09:31:00', createdAt: '2026-10-20' }];
  const logAfter = mailLog.map(l => ({ ...l, ...(log[l._row] || {}) }));
  const p = L.planOutreach(baseInput({ today: '2026-10-30', contacts: [cA, cB], outreach: after, mailLog: logAfter,
    cfg: { ...baseInput().cfg, coldPerDay: 5 } }));
  assert.ok(p.queue.some(q => q.kind === 'FOLLOWUP' && q.outreachId === 'OB' && q.stepAfter === 2));
  assert.ok(p.queue.some(q => q.kind === 'COLD_NEW' && q.recruiterId === 'RA'));
});
