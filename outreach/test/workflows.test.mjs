// Runs the GENERATED Code nodes (from the workflow JSON files) in order with a
// small n8n look-alike ($, $input, $json, this.helpers) and fake API
// responses, to catch glue errors between nodes that unit tests cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibs } from '../libs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const L = loadLibs();
const load = f => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function dollar(outputs, idx) {
  return name => {
    if (!(name in outputs)) {
      const boom = () => { throw new Error(`node "${name}" has not run`); };
      return { isExecuted: false, first: boom, all: boom, get item() { return boom(); } };
    }
    const items = outputs[name];
    return { isExecuted: true, first: () => items[0], all: () => items, get item() { return items[Math.min(idx, items.length - 1)]; } };
  };
}
const asItems = r => (Array.isArray(r) ? r : r ? [r] : []).map(x => (x && x.json ? x : { json: x }));

async function run(wf, name, input, outputs, helpers = {}) {
  const node = wf.nodes.find(n => n.name === name);
  assert.ok(node, `node ${name} exists`);
  const fn = new AsyncFunction('$', '$input', '$json', node.parameters.jsCode);
  let out = [];
  if (node.parameters.mode === 'runOnceForEachItem') {
    for (let i = 0; i < input.length; i++) {
      const r = await fn.call({ helpers }, dollar(outputs, i), { item: input[i], first: () => input[0], all: () => input }, input[i].json);
      out.push(...asItems(r));
    }
  } else {
    const r = await fn.call({ helpers }, dollar(outputs, 0), { item: input[0], first: () => input[0], all: () => input }, (input[0] || {}).json);
    out = asItems(r);
  }
  outputs[name] = out;
  return out;
}
function expr(wf, name, field, outputs, item) {
  const node = wf.nodes.find(n => n.name === name);
  const raw = field.split('.').reduce((o, k) => o[k], node.parameters);
  const m = String(raw).match(/^=\{\{([\s\S]*)\}\}$/);
  if (!m) return String(raw).replace(/^=/, '').replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => new Function('$', '$json', `return (${e});`)(dollar(outputs, 0), item));
  return new Function('$', '$json', `return (${m[1]});`)(dollar(outputs, 0), item);
}
const vr = (range, values) => ({ range, values });

test('every generated workflow is well-formed and every Code node compiles', () => {
  for (const f of ['Outreach - Setup run once.json', 'Outreach - Contact Enrichment.json', 'Outreach - Reply Sync.json', 'Outreach - Daily Run.json',
    'Outreach - Telegram Commands.json', 'Outreach - Error Alert.json', 'Linkedin Job Search v3.json']) {
    const wf = load(f);
    const names = new Set(wf.nodes.map(n => n.name));
    assert.equal(names.size, wf.nodes.length, `${f}: duplicate node names`);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${f}: ${from}`);
      for (const outs of Object.values(c)) for (const o of outs) for (const t of o) assert.ok(names.has(t.node), `${f}: ${t.node}`);
    }
    for (const n of wf.nodes.filter(x => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new AsyncFunction('$', '$input', '$json', n.parameters.jsCode), `${f} / ${n.name}`);
    }
    if (f.startsWith('Outreach')) assert.equal(wf.settings.timezone, 'Asia/Kolkata');
  }
});

// ── fixtures shared by the daily run ────────────────────────────────────────
const H = L.HEADERS;
const resultHeader = ['title', 'company', 'location', 'description', 'jobid', 'applyLink', 'score', 'addedAt', ...L.JOB_COLUMNS_ADDED];
const companies = [['Company', 'CompanyID', 'Bucket', 'Active', 'Notes', 'Aliases'], ['Google', '1441', '4', 'True', '', ''], ['Expedia', '2751', '1', 'True', '', 'Expedia Group']];
const cfgRows = [H['Outreach Config'], ...L.CONFIG_DEFAULTS.map(([k, v, n]) => [k, v, n])].map(r => {
  if (r[0] === 'mode') return ['mode', 'SEND', ''];
  if (r[0] === 'myEmail') return ['myEmail', 'me@x.com', ''];
  if (r[0] === 'setupCompletedAt') return ['setupCompletedAt', '2026-10-09 10:00:00', ''];
  return r;
}).concat([['ignoreSendWindow', 'Y', '']]);
const row = (headers, o) => headers.map(h => (o[h] === undefined ? '' : o[h]));
const rid = n => L.hashId('R', n);
const contactsRows = [H.Contacts,
  ...['g1', 'g2', 'g3'].map(n => row(H.Contacts, { recruiterId: rid(n), name: `${n} Kumar`, company: 'Google', companyId: '1441', isRelevant: 'Y', email: `${n}@google.com`, emailStatus: 'VALID', addedAt: '2026-10-01 10:00:00' })),
  row(H.Contacts, { recruiterId: rid('e1'), name: 'Priya Sharma', company: 'Expedia', companyId: '2751', isRelevant: 'Y', email: 'priya@expedia.com', emailStatus: 'VALID', addedAt: '2026-10-01 10:00:00' }),
  row(H.Contacts, { recruiterId: rid('r1'), name: 'Reply Person', company: 'Expedia', companyId: '2751', isRelevant: 'Y', email: 'rp@expedia.com', emailStatus: 'VALID', addedAt: '2026-10-01 10:00:00' }),
];
const outreachRows = [H.Outreach,
  row(H.Outreach, { outreachId: 'OE1', recruiterId: rid('e1'), recruiterName: 'Priya Sharma', company: 'Expedia', companyId: '2751', type: 'COLD', originType: 'COLD', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-01', threadId: 'TE1', subject: 'Hello', lastSentAt: '2026-10-07 10:00:00', createdAt: '2026-10-07 10:00:00' }),
  row(H.Outreach, { outreachId: 'OR1', recruiterId: rid('r1'), recruiterName: 'Reply Person', company: 'Expedia', companyId: '2751', type: 'COLD', originType: 'COLD', state: 'ACTIVE', step: 1, nextSendDate: '2026-10-12', threadId: 'TR1', subject: 'Hello', lastSentAt: '2026-10-07 10:00:00', createdAt: '2026-10-07 10:00:00' }),
];
const today = L.istDateStr(new Date());
const jobs = [
  { title: 'SDE II', company: 'Google', description: 'Java microservices', jobid: '4432000001', applyLink: 'https://www.linkedin.com/jobs/view/4432000001', score: 91, addedAt: `${today} 08:00:00` },
  { title: 'SDE III', company: 'Google', description: 'Go', jobid: '4432000002', applyLink: '', score: '', addedAt: `${today} 08:00:00` },
  { title: 'Backend Engineer', company: 'Expedia Group', description: 'Kotlin', jobid: '4432000003', applyLink: '', score: '', addedAt: `${today} 07:00:00` },
  { title: 'Old', company: 'Google', description: '', jobid: '4400000000', applyLink: '', score: 99, addedAt: '2026-01-01 08:00:00', outreachStatus: 'LEGACY' },
];
const t0 = Date.now() - 864e5;
const msg = (id, from, subject, at, headers = []) => ({ id, threadId: 'x', internalDate: String(at), snippet: 'thanks, let us talk', labelIds: [], payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail>` }, ...headers] } });

test('daily run: Code nodes chain end to end with fake APIs', async () => {
  const wf = load('Outreach - Daily Run.json');
  const o = {};
  o['Load Outreach DB'] = [{ json: { valueRanges: [vr("'Outreach Config'!A1:C40", cfgRows), vr("'Contacts'!A1:P6", contactsRows), vr("'Outreach'!A1:V3", outreachRows), vr("'Mail Log'!A1:N1", [H['Mail Log']]),
    vr("'Outreach Templates'!A1:E7", [H['Outreach Templates'], ...L.SEED_TEMPLATES])] } }];
  o['Load Job Headers'] = [{ json: { valueRanges: [vr("'Result'!A1:M1", [resultHeader]), vr("'Companies'!A1:F3", companies)] } }];
  const jc = await run(wf, 'Job Columns', o['Load Job Headers'], o);
  assert.match(jc[0].json.url, /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/1DSZ.*values:batchGet\?ranges=/);
  o['Load Job Columns'] = [{ json: { valueRanges: jc[0].json.names.map(n => vr(`'Result'!${jc[0].json.cols[n]}1:${jc[0].json.cols[n]}5`, [[n], ...jobs.map(j => [j[n] === undefined ? '' : j[n]])])) } }];
  const pdb = await run(wf, 'Parse DB', o['Load Job Columns'], o);
  assert.equal(pdb[0].json.mode, 'SEND');
  assert.equal(pdb[0].json.aiCandidates.length, 3);
  assert.match(expr(wf, 'List Recent Inbound', 'url', o), /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\?maxResults=500&q=newer_than/);
  assert.match(expr(wf, 'Load Candidate Descriptions', 'url', o), /ranges='Result'!D2&ranges='Result'!D3/);
  o['List Recent Inbound'] = [{ json: { messages: [{ id: 'a', threadId: 'TR1' }, { id: 'b', threadId: 'UNRELATED' }] } }];
  o['List Bounces'] = [{ json: { resultSizeEstimate: 0 } }];
  const tt = await run(wf, 'Threads To Check', o['List Bounces'], o);
  assert.deepEqual(tt.map(i => i.json.threadId), ['TR1']);
  assert.match(expr(wf, 'Get Threads', 'url', o, tt[0].json), /threads\/TR1\?format=metadata/);
  o['Get Threads'] = [{ json: { id: 'TR1', messages: [msg('m1', 'me@x.com', 'Hello', t0 - 1e6), msg('m2', 'Reply Person <rp@expedia.com>', 'Re: Hello', t0)] } }];
  const sync = await run(wf, 'Sync Replies', o['Get Threads'], o);
  assert.equal(sync[0].json.events[0].type, 'REPLY');
  o['Load Candidate Descriptions'] = [{ json: { valueRanges: [vr("'Result'!D2", [['Java microservices']]), vr("'Result'!D3", [['Go']]), vr("'Result'!D4", [['Kotlin']])] } }];
  const rb = await run(wf, 'Resume Base64', [{ json: {}, binary: { data: { fileName: 'Mahir_Resume.pdf', mimeType: 'application/pdf', data: 'filesystem-v2' } } }], o,
    { getBinaryDataBuffer: async () => Buffer.from('%PDF-1.4 fake') });
  assert.equal(rb[0].json.resumeB64, Buffer.from('%PDF-1.4 fake').toString('base64'));
  o['Extract Resume Text'] = [{ json: { text: 'Java, Kotlin, distributed systems' } }];
  const pa = await run(wf, 'Prepare AI', o['Extract Resume Text'], o);
  assert.match(pa[0].json.aiPrompt, /\[id: 4432000002\] \[needs_score: yes\]/);
  assert.match(pa[0].json.aiPrompt, /Kotlin/);
  await run(wf, 'Parse AI', [{ json: { text: '[{"jobid":"4432000001","score":null,"pitch":"I build Java microservices"},{"jobid":"4432000003","score":86,"pitch":"I ship Kotlin services"}]' } }], o);
  const plan = await run(wf, 'Plan', o['Parse AI'], o);
  const P = plan[0].json;
  assert.equal(P.sending, P.digest.sendDay);
  const ranges = P.outreachData.map(d => d.range);
  assert.ok(ranges.includes("'Outreach'!J3"), 'reply sync marks OR1 REPLIED (state column)');
  if (P.digest.sendDay) {
    const st = Object.fromEntries(P.jobsData.map(d => [d.range, d.values[0][0]]));
    assert.equal(st["'Result'!K2"], 'PICKED');
    assert.equal(st["'Result'!K3"], 'SIBLING');
    assert.equal(st["'Result'!K4"], 'PICKED');   // Expedia via alias, AI score 86
    assert.equal(st["'Result'!I4"], '2751');      // resolved companyId written back
    const kinds = P.queue.map(q => q.kind).sort();
    assert.deepEqual(kinds, ['JOB_NEW', 'JOB_NEW', 'JOB_NEW', 'NEW_ROLE']);
    const nr = P.queue.find(q => q.kind === 'NEW_ROLE');
    assert.match(nr.body, /I ship Kotlin services\./);
    assert.match(P.planData[1].range, /^'Outreach Plan'!A2:O5$/);

    // send loop
    const q = await run(wf, 'Queue Items', plan, o);
    const gate = await run(wf, 'Gate', q, o);
    assert.ok(gate.every(g => !g.json.result));
    const ordered = gate; // NEW_ROLE is first
    o['Get Thread'] = [{ json: { id: 'TE1', messages: [msg('s1', 'Mahir <me@x.com>', 'Hello', t0, [{ name: 'References', value: '<r0@mail>' }])] } }];
    const composeIn = [ordered[0]];
    const comp = await run(wf, 'Compose', composeIn.map(() => o['Get Thread'][0]), { ...o, Gate: [ordered[0]] }, { httpRequest: async () => '<html>Apply now</html>' });
    assert.equal(comp[0].json.kind, 'NEW_ROLE');
    assert.equal(comp[0].json.apiUrl, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert.equal(comp[0].json.apiBody.threadId, 'TE1');
    assert.equal(comp[0].json.sentSubject, 'Re: Hello');
    const raw = Buffer.from(comp[0].json.apiBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(raw, /In-Reply-To: <s1@mail>/);
    assert.doesNotMatch(raw, /n8n/i);
    o.Compose = comp;
    o['Gmail API'] = [{ json: { id: 'sent1', threadId: 'TE1', labelIds: ['SENT'] } }];
    assert.match(expr(wf, 'Read ID Columns', 'url', o), /ranges='Outreach'!A%3AA&ranges='Mail%20Log'!A%3AA/);
    o['Read ID Columns'] = [{ json: { valueRanges: [vr("'Outreach'!A1:A3", [['outreachId'], ['OE1'], ['OR1']]), vr("'Mail Log'!A1:A1", [['logId']])] } }];
    const rec = await run(wf, 'Record', o['Read ID Columns'], o);
    const recRanges = rec[0].json.data.map(d => d.range);
    assert.ok(recRanges.includes("'Outreach'!F2") && recRanges.includes("'Outreach'!K2"), 'type + step updated on row 2');
    assert.ok(recRanges.includes("'Mail Log'!A2:N2"));
    const body = JSON.parse(expr(wf, 'Write Record', 'jsonBody', o, rec[0].json));
    assert.equal(body.valueInputOption, 'RAW');
    const sent = await run(wf, 'Sent', rec, o);
    assert.ok(sent[0].json.jitterSec >= 60 && sent[0].json.jitterSec <= 180);

    // a new-thread mail carries the resume
    const fresh = gate.find(g => g.json.kind === 'JOB_NEW');
    const c2 = await run(wf, 'Compose', [fresh], { ...o, Gate: [fresh] }, { httpRequest: async () => '<html>No longer accepting applications</html>' });
    assert.equal(c2[0].json.reason, 'JOB_CLOSED');
    const c3 = await run(wf, 'Compose', [fresh], { ...o, Gate: [fresh] }, {});
    const raw3 = Buffer.from(c3[0].json.apiBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(raw3, /filename="Mahir_Resume.pdf"/);

    const dg = await run(wf, 'Digest', [...sent, { json: { ...fresh.json, result: 'SKIPPED', reason: 'JOB_CLOSED' } }], { ...o, 'Loop Over Mails': [] });
    assert.match(dg[0].json.message, /Reply: Reply Person @ Expedia/);
    assert.match(dg[0].json.message, /1 sent of 4 planned/);
    assert.match(dg[0].json.message, /Skipped at send time: 1 JOB_CLOSED/);
  }
});

test('setup: Build Setup + Tabs Plan glue', async () => {
  const wf = load('Outreach - Setup run once.json');
  const o = {};
  o['Gmail Profile'] = [{ json: { emailAddress: 'mahir2cool@gmail.com' } }];
  o['Outreach Sheet Info'] = [{ json: { sheets: [{ properties: { title: 'Templates' } }, { properties: { title: 'Cold Mailing' } }] } }];
  o['Jobs Sheet Info'] = [{ json: { sheets: ['Config', 'Companies', 'Result', 'Low Match'].map(title => ({ properties: { title } })) } }];
  const tp = await run(wf, 'Tabs Plan', o['Jobs Sheet Info'], o);
  assert.deepEqual(tp[0].json.add, Object.keys(H));
  assert.match(tp[0].json.readUrl, /Cold%20Mailing/);
  o['Read Outreach Tabs'] = [{ json: { valueRanges: [vr("'Cold Mailing'!A1:J2", [['Recruiter Name', 'Recruiter Email', 'Job Link', 'Job Title', 'Job Company', 'ResumeLink', 'Status', 'TemplateId', 'ThreadId', 'Timestamp'], ['Asha', 'asha@expedia.com', '', '', 'Expedia Group', '', 'Sent', '', 'T1', '']])] } }];
  o['Read Job Headers'] = [{ json: { valueRanges: [vr("'Result'!A1:H1", [resultHeader.slice(0, 8)]), vr("'Companies'!A1:E3", companies.map(r => r.slice(0, 5))), vr("'Low Match'!A1:H1", [resultHeader.slice(0, 8)])] } }];
  const rc = await run(wf, 'Result Columns', o['Read Job Headers'], o);
  assert.deepEqual(rc[0].json.names, ['jobid', 'company']);
  o['Read Result Columns'] = [{ json: { valueRanges: [vr("'Result'!E1:E3", [['jobid'], ['1'], ['2']]), vr("'Result'!B1:B3", [['company'], ['Google'], ['Expedia Group']])] } }];
  const th = await run(wf, 'Threads To Inspect', o['Read Result Columns'], o);
  assert.equal(th[0].json.threadId, 'T1');
  o['Get Thread'] = [{ json: { id: 'T1', messages: [msg('m1', 'mahir2cool@gmail.com', 'Hi Asha', t0)] } }];
  const b = await run(wf, 'Build Setup', o['Get Thread'], o);
  const s = b[0].json;
  assert.ok(s.outreachData.some(d => d.values[0][0] === 'myEmail' && d.values[0][1] === 'mahir2cool@gmail.com'));
  assert.ok(s.jobsData.some(d => d.range === "'Result'!K2:K3"));
  assert.ok(s.outreachData.some(d => /^'Outreach'!A2:V2$/.test(d.range)));
  const sum = await run(wf, 'Setup Summary', b, o);
  assert.match(sum[0].json.message, /2 existing jobs marked LEGACY/);
});

test('enrichment + reply sync + commands glue', async () => {
  const en = load('Outreach - Contact Enrichment.json');
  const o = {};
  o['Load Outreach DB'] = [{ json: { valueRanges: [vr("'Outreach Config'!A1:C40", cfgRows), vr("'Contacts'!A1:P3", [H.Contacts,
    row(H.Contacts, { name: 'New Person', company: 'Expedia Group', linkedinUrl: 'https://linkedin.com/in/newp', isRelevant: 'Y' }),
    row(H.Contacts, { recruiterId: 'Rpend', name: 'Pending P', company: 'Google', companyId: '1441', isRelevant: 'Y', enrichStatus: 'PENDING', enrichmentId: 'E9' })])] } }];
  o['Load Companies'] = [{ json: { valueRanges: [vr("'Companies'!A1:F3", companies)] } }];
  const prep = await run(en, 'Prepare Enrichment', o['Load Companies'], o);
  assert.equal(prep[0].json.submit.datas.length, 1);
  assert.deepEqual(prep[0].json.pollIds, ['E9']);
  const poll = await run(en, 'Poll Items', prep, o);
  assert.equal(expr(en, 'Get Enrichment Result', 'url', o, poll[0].json), 'https://app.fullenrich.com/api/v1/contact/enrich/bulk/E9');
  o['Get Enrichment Result'] = [{ json: { id: 'E9', status: 'FINISHED', datas: [{ custom: { recruiterId: 'Rpend' }, contact: { most_probable_email: 'p@google.com', most_probable_email_status: 'HIGH_PROBABILITY' } }] } }];
  const newRid = prep[0].json.submitIds[0];
  o['Re-read Contacts'] = [{ json: { valueRanges: [vr("'Contacts'!A1:P3", [H.Contacts, row(H.Contacts, { recruiterId: newRid, name: 'New Person' }), row(H.Contacts, { recruiterId: 'Rpend', enrichStatus: 'PENDING', enrichmentId: 'E9' })])] } }];
  const ap = await run(en, 'Apply Results', o['Re-read Contacts'], o);
  assert.ok(ap[0].json.data.some(d => d.range === "'Contacts'!I3" && d.values[0][0] === 'p@google.com'));
  const sub = JSON.parse(expr(en, 'Submit To FullEnrich', 'jsonBody', o));
  assert.equal(sub.datas[0].custom.recruiterId, newRid);
  const mk = await run(en, 'Mark Submitted', [{ json: { enrichment_id: 'E10' } }], o);
  assert.ok(mk[0].json.data.some(d => d.range === "'Contacts'!K2" && d.values[0][0] === 'PENDING'));
  const es = await run(en, 'Enrichment Summary', mk, o);
  assert.match(es[0].json.message, /Sent 1 recruiters to FullEnrich/);

  const sy = load('Outreach - Reply Sync.json');
  const s = {};
  s['Load Outreach DB'] = [{ json: { valueRanges: [vr("'Outreach Config'!A1:C40", cfgRows), vr("'Contacts'!A1:P6", contactsRows), vr("'Outreach'!A1:V3", outreachRows)] } }];
  await run(sy, 'Parse DB', s['Load Outreach DB'], s);
  s['List Recent Inbound'] = [{ json: { messages: [{ id: 'a', threadId: 'TR1' }] } }];
  s['List Bounces'] = [{ json: {} }];
  await run(sy, 'Threads To Check', s['List Bounces'], s);
  s['Get Threads'] = [{ json: { id: 'TR1', messages: [msg('m1', 'me@x.com', 'Hello', t0 - 1e6), msg('m2', 'rp@expedia.com', 'Re: Hello', t0)] } }];
  await run(sy, 'Sync Replies', s['Get Threads'], s);
  const apS = await run(sy, 'Apply Sync', s['Sync Replies'], s);
  assert.ok(apS[0].json.data.some(d => d.range === "'Outreach'!J3" && d.values[0][0] === 'REPLIED'));
  const al = await run(sy, 'Sync Alerts', [{ json: {} }], s);
  assert.match(al[0].json.message, /Reply Person @ Expedia replied/);

  const cm = load('Outreach - Telegram Commands.json');
  const c = {};
  const pc = await run(cm, 'Parse Command', [{ json: { message: { text: '/p4432000003', chat: { id: 8126636123 } } } }], c);
  assert.equal(pc[0].json.parsed.cmd, 'priority');
  c['Load Config'] = [{ json: { valueRanges: [vr("'Outreach Config'!A1:C40", cfgRows)] } }];
  const rcol = await run(cm, 'Result Columns', [{ json: { valueRanges: [vr("'Result'!A1:M1", [resultHeader])] } }], c);
  c['Load Result Columns'] = [{ json: { valueRanges: rcol[0].json.names.map(n => vr('x', [[n], ...jobs.map(j => [j[n] === undefined ? '' : j[n]])])) } }];
  const ac = await run(cm, 'Apply Command', c['Load Result Columns'], c);
  assert.deepEqual(ac[0].json.data.map(d => d.range), ["'Result'!J4"]);
  assert.match(ac[0].json.message, /Priority: Backend Engineer @ Expedia Group/);
  const intruder = await run(cm, 'Apply Command', c['Load Result Columns'], { ...c, 'Parse Command': [{ json: { ...pc[0].json, chatId: '999' } }] });
  assert.equal(intruder.length, 0);
});

test('scraper patch: companyId resolver + /p commands', async () => {
  const wf = load('Linkedin Job Search v3.json');
  const o = {};
  o['Get Companies'] = companies.slice(1).map(r => ({ json: { Company: r[0], CompanyID: r[1], Aliases: r[5] } }));
  o['Get Config'] = [{ json: { Setting: 'minScore', Value: 80 } }];
  const store = { newJobs: [{ title: 'SDE', company: 'Expedia Group', jobid: '1', applyLink: 'l' }], scoredJobs: [] };
  const node = wf.nodes.find(n => n.name === 'Parse All Scores');
  const fn = new AsyncFunction('$', '$input', '$json', '$getWorkflowStaticData', node.parameters.jsCode);
  const out = await fn(dollar(o, 0), {}, { text: '[{"jobid":"1","score":90}]' }, () => store);
  assert.equal(out[0].json.companyId, '2751');
  const save = wf.nodes.find(n => n.name === 'Save All to Sheet').parameters.columns;
  assert.equal(save.value.companyId, '={{ $json.companyId }}');
  const fs = wf.nodes.find(n => n.name === 'Format Summary').parameters.jsCode;
  assert.match(fs, /Priority: \/p\$\{job\.jobid\}/);
  assert.doesNotMatch(fs, /6 hours/);
});
