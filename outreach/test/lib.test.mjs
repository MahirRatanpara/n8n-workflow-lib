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
    templates, companyIndex: L.buildCompanyIndex(companies), ai: { scores: {}, pitches: {} }, ...over,
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

test('planner: cold intros respect reserve and quiet period; re-engagement', () => {
  const ex = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'].map(n => contact(n, '1028'));
  const r = L.planOutreach(baseInput({ cfg: { ...baseInput().cfg, coldPerDay: 5, reserveFreshPerCompany: 4 }, contacts: ex }));
  assert.equal(r.digest.counts.COLD_NEW, 2);
  assert.equal(r.queue[0].templateCode, 'COLD_NEW');
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
  assert.equal(res.data[1].range, "'Mail Log'!A2:N2");
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
    { _row: 5, name: 'Not Yet', company: 'Google', linkedinUrl: 'linkedin.com/in/nyet', isRelevant: '' },
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

test('setup: headers, config, templates, LEGACY backfill, Cold Mailing import', () => {
  const t0 = Date.parse('2026-10-01T05:00:00Z');
  const tabs = {
    'Cold Mailing': [['Recruiter Name', 'Recruiter Email', 'Job Link', 'Job Title', 'Job Company', 'ResumeLink', 'Status', 'TemplateId', 'ThreadId', 'Timestamp'],
      ['Asha K', 'asha@expedia.com', 'https://www.linkedin.com/jobs/view/4432092573', 'SDE II', 'Expedia Group', 'x', 'FollowUp Sent', 'Follow-Up 1', 'T1', '2026-10-05'],
      ['Ravi', 'ravi@google.com', '', '', 'Google', 'x', 'Pending', '', '', ''],
      ['Draft Only', 'd@akamai.com', '', '', 'Akamai', 'x', 'Sent', '', 'T3', '']],
  };
  const threads = [
    { id: 'T1', messages: [msg('a', 'me@x.com', 'SDE II', t0), msg('b', 'me@x.com', 'Re: SDE II', t0 + 4 * 864e5)] },
    { id: 'T3', messages: [{ ...msg('c', 'me@x.com', 'Hi', t0), labelIds: ['DRAFT'] }] },
  ];
  const compVals = [['Company', 'CompanyID', 'Bucket', 'Active', 'Notes'], ['Expedia', '2751', '1', 'True', ''], ['JPMC', '1068', '1', 'True', '']];
  const jobs = { resultHeader: ['title', 'company', 'location', 'description', 'jobid', 'applyLink', 'score', 'addedAt'], lowMatchHeader: ['title', 'jobid'],
    companies: compVals, jobIdCol: [['jobid'], ['1'], ['2'], ['']], companyCol: [['company'], ['Expedia Group'], ['JPMorganChase']], statusCol: [] };
  const s = L.planSetup({ tabs, jobs, threads, myEmail: 'me@x.com', now: new Date('2026-10-09T05:00:00Z') });
  const find = (re) => s.outreachData.filter(d => re.test(d.range));
  assert.deepEqual(find(/^'Outreach'!A1:/)[0].values[0], L.HEADERS.Outreach);
  assert.equal(find(/^'Outreach Templates'!A[2-9]\d*:E/).length, L.SEED_TEMPLATES.length);
  assert.ok(s.outreachData.some(d => d.values[0][0] === 'myEmail' && d.values[0][1] === 'me@x.com'));
  const contactsRows = find(/^'Contacts'!A[2-9]/);
  assert.equal(contactsRows.length, 3);
  const o = find(/^'Outreach'!A2:/)[0].values[0];
  const oh = L.HEADERS.Outreach;
  assert.equal(o[oh.indexOf('step')], 2);
  assert.equal(o[oh.indexOf('type')], 'JOB');
  assert.equal(o[oh.indexOf('jobId')], '4432092573');
  assert.equal(o[oh.indexOf('nextSendDate')], '2026-10-09'); // last sent Mon 5th + 4 business days (step 2 gap)
  assert.equal(find(/^'Mail Log'!A[2-9]/).length, 2);
  const legacy = s.jobsData.find(d => /^'Result'!K2:K4$/.test(d.range));
  assert.deepEqual(legacy.values, [['LEGACY'], ['LEGACY'], ['']]);
  assert.ok(s.jobsData.some(d => /^'Companies'!F2$/.test(d.range) && d.values[0][0] === 'Expedia Group'));
  assert.ok(s.jobsData.some(d => /^'Companies'!F3$/.test(d.range) && /JPMorganChase/.test(d.values[0][0])));
  assert.ok(s.summary.some(x => /Draft Only/.test(x)));
});

test('commands', () => {
  assert.deepEqual(L.parseCommand('/p4432092573'), { cmd: 'priority', jobId: '4432092573' });
  assert.deepEqual(L.parseCommand('/a_4432092573@MyBot'), { cmd: 'applied', jobId: '4432092573' });
  assert.equal(L.parseCommand('hello'), null);
  const r = L.applyCommand({ cmd: 'priority', jobId: '1' }, { title: 'SDE', company: 'G', outreachStatus: 'LEGACY' });
  assert.deepEqual(r.fields, { isPriority: 'Y', outreachStatus: '' });
});

test('ai prompt/parse', () => {
  const p = L.parseAiResponse({ text: '```json\n[{"jobid":"1","score":87,"pitch":"I built payment APIs at scale — similar to this role"},{"jobid":"2","score":null,"pitch":""}]\n```' });
  assert.deepEqual(p.scores, { 1: 87 });
  assert.equal(p.pitches['1'], 'I built payment APIs at scale, similar to this role.');
  assert.deepEqual(L.parseAiResponse({}).scores, {});
});
