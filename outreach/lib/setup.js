// ── setup.js ────────────────────────────────────────────────────────────────
// Phase 0: create/extend tabs, seed config + templates, add job columns,
// mark existing jobs LEGACY and import the Cold Mailing tab. Headers,
// config and templates are idempotent; the backfill + migration run once
// (guarded by Outreach Config.setupCompletedAt).

const ALIAS_SEEDS = {
  JPMC: ['JPMorganChase', 'JPMorgan Chase & Co.', 'J.P. Morgan'],
  DeShaw: ['D. E. Shaw', 'D. E. Shaw India Private Limited'],
  'Hotstar (Disney+)': ['Disney+ Hotstar'],
};

function missingTabs(existingTitles) {
  const have = new Set(existingTitles);
  return Object.keys(HEADERS).filter(t => !have.has(t));
}

function headerWrite(tab, existing, wanted) {
  const cur = (existing || []).map(str);
  const missing = wanted.filter(h => !cur.includes(h));
  const full = cur.filter(Boolean).length ? cur.concat(missing) : wanted.slice();
  return { full, changed: missing.length > 0 || !cur.filter(Boolean).length, write: { range: `${quoteTab(tab)}!A1:${colLetter(full.length - 1)}1`, values: [full] } };
}

// tabs: { tabName: values } for the outreach spreadsheet.
// jobs: { resultHeader, lowMatchHeader, companies (values), jobIdCol, companyCol, statusCol }
// threads: Gmail thread objects for Cold Mailing ThreadIds.
function planSetup({ tabs, jobs, threads, myEmail, now }) {
  const nowTs = istTsStr(now), today = istDateStr(now);
  const out = { outreachData: [], jobsData: [], summary: [] };
  const headers = {};

  for (const tab of Object.keys(HEADERS)) {
    const h = headerWrite(tab, (tabs[tab] || [])[0], HEADERS[tab]);
    headers[tab] = h.full;
    if (h.changed || tab === 'Outreach Config') out.outreachData.push(h.write);
  }

  // Config: append missing settings, fill myEmail if blank.
  const cfgValues = tabs['Outreach Config'] || [];
  const cfg = parseConfig(cfgValues);
  const firstRun = !str(cfg.setupCompletedAt);
  let cfgNext = Math.max(cfgValues.length, 1) + 1;
  const cfgRowOf = k => cfgValues.findIndex((r, i) => i > 0 && str(r[0]) === k);
  for (const [k, v, note] of CONFIG_DEFAULTS) {
    let value = v;
    if (k === 'myEmail') value = myEmail || '';
    if (k === 'setupCompletedAt') value = firstRun ? nowTs : cfg.setupCompletedAt;
    const at = cfgRowOf(k);
    if (at < 0) {
      out.outreachData.push({ range: `${quoteTab('Outreach Config')}!A${cfgNext}:C${cfgNext}`, values: [[k, value, note]] });
      cfgNext++;
    } else if ((k === 'myEmail' && !str(cfg.myEmail) && myEmail) || (k === 'setupCompletedAt' && firstRun)) {
      out.outreachData.push({ range: `${quoteTab('Outreach Config')}!B${at + 1}`, values: [[value]] });
    }
  }

  // Templates: seed codes that are not there yet (never overwrite your edits).
  const tplValues = tabs['Outreach Templates'] || [];
  const haveCodes = new Set(tplValues.slice(1).map(r => str(r[0]).toUpperCase()));
  let tplNext = Math.max(tplValues.length, 1) + 1;
  for (const t of SEED_TEMPLATES) {
    if (haveCodes.has(t[0])) continue;
    out.outreachData.push({ range: `${quoteTab('Outreach Templates')}!A${tplNext}:E${tplNext}`, values: [t] });
    tplNext++;
  }

  // Jobs spreadsheet: new columns on Result / Low Match, Aliases on Companies.
  const rh = headerWrite('Result', jobs.resultHeader, (jobs.resultHeader || []).map(str).filter(Boolean).concat(JOB_COLUMNS_ADDED));
  if (rh.changed) out.jobsData.push(rh.write);
  else out.jobsData.push(rh.write); // harmless rewrite keeps the batch non-empty
  if (jobs.lowMatchHeader && jobs.lowMatchHeader.length) {
    const lh = headerWrite('Low Match', jobs.lowMatchHeader, jobs.lowMatchHeader.map(str).filter(Boolean).concat(['companyId']));
    if (lh.changed) out.jobsData.push(lh.write);
  }
  const compValues = jobs.companies || [];
  const ch = headerWrite('Companies', compValues[0], (compValues[0] || []).map(str).filter(Boolean).concat(['Aliases']));
  if (ch.changed) out.jobsData.push(ch.write);
  const compT = parseTable([ch.full].concat(compValues.slice(1)));
  const index = buildCompanyIndex(compT.rows);
  const aliasCol = ch.full.indexOf('Aliases');
  const aliasAdds = new Map();
  const addAlias = (row, name) => {
    const cur = str(row.Aliases).split(/[;,|]/).map(s => s.trim()).filter(Boolean);
    const pending = aliasAdds.get(row._row) || cur.slice();
    if (!pending.some(a => companyKeyExact(a) === companyKeyExact(name)) && companyKeyExact(row.Company) !== companyKeyExact(name)) pending.push(name);
    aliasAdds.set(row._row, pending);
  };
  for (const row of compT.rows) for (const a of ALIAS_SEEDS[str(row.Company)] || []) addAlias(row, a);
  const jobCompanies = new Set((jobs.companyCol || []).slice(1).map(r => str(Array.isArray(r) ? r[0] : r)).filter(Boolean));
  const unresolved = [];
  for (const name of jobCompanies) {
    const id = resolveCompany(index, name);
    if (!id) {
      const seeded = compT.rows.find(r => (ALIAS_SEEDS[str(r.Company)] || []).some(a => companyKeyExact(a) === companyKeyExact(name)));
      if (!seeded) unresolved.push(name);
      continue;
    }
    if (index.exact.get(companyKeyExact(name))) continue;
    const row = compT.rows.find(r => str(r.CompanyID) === id);
    if (row) addAlias(row, name);
  }
  for (const [row, list] of aliasAdds) {
    const before = str((compT.rows.find(r => r._row === row) || {}).Aliases);
    const after = list.join('; ');
    if (after !== before) out.jobsData.push({ range: `${quoteTab('Companies')}!${colLetter(aliasCol)}${row}`, values: [[after]] });
  }
  if (unresolved.length) out.summary.push(`Companies in Result with no match in the Companies tab: ${unresolved.join(', ')}`);

  if (!firstRun) {
    out.summary.push('Setup already completed earlier: headers/config/templates checked, backfill and migration skipped.');
    return out;
  }

  // LEGACY backfill: every existing job with a blank status.
  const statusIdx = rh.full.indexOf('outreachStatus');
  const ids = (jobs.jobIdCol || []).map(r => str(Array.isArray(r) ? r[0] : r));
  const statuses = (jobs.statusCol || []).map(r => str(Array.isArray(r) ? r[0] : r));
  if (ids.length > 1) {
    const col = [];
    let legacy = 0;
    for (let i = 1; i < ids.length; i++) {
      const cur = statuses[i] || '';
      if (!cur && ids[i]) { col.push(['LEGACY']); legacy++; } else col.push([cur]);
    }
    out.jobsData.push({ range: `${quoteTab('Result')}!${colLetter(statusIdx)}2:${colLetter(statusIdx)}${ids.length}`, values: col });
    out.summary.push(`${legacy} existing jobs marked LEGACY (never mailed automatically).`);
  }

  // Cold Mailing → Contacts / Outreach / Mail Log.
  const cold = parseTable(tabs['Cold Mailing'] || []);
  const contactsT = parseTable(tabs.Contacts || []);
  const outreachT = parseTable(tabs.Outreach || []);
  const logT = parseTable(tabs['Mail Log'] || []);
  const haveEmails = new Set(contactsT.rows.map(c => normEmail(c.email)).filter(Boolean));
  const haveThreads = new Set(outreachT.rows.map(o => str(o.threadId)).filter(Boolean));
  const threadById = new Map((threads || []).filter(t => t && t.id).map(t => [str(t.id), t]));
  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const gaps = cfgList(cfg, 'followupGapDays', '3,4,7').map(Number);
  const maxMails = cfgNum(cfg, 'maxMailsPerRecruiter', 4);
  const exhaustAfter = cfgNum(cfg, 'exhaustAfterDays', 7);
  let cNext = Math.max(contactsT.lastRow, 1) + 1, oNext = Math.max(outreachT.lastRow, 1) + 1, lNext = Math.max(logT.lastRow, 1) + 1;
  let nContacts = 0, nThreads = 0, nReplied = 0;
  const unsent = [];
  for (const r of cold.rows) {
    const email = normEmail(r['Recruiter Email']);
    if (!email || haveEmails.has(email)) continue;
    haveEmails.add(email);
    const rid = hashId('R', email);
    const company = str(r['Job Company']);
    const cid = resolveCompany(index, company);
    const threadId = str(r.ThreadId);
    const status = str(r.Status);
    const notes = [`Imported from Cold Mailing row ${r._row} (${status || 'no status'})`];
    let outreachRow = null, logRows = [];
    const t = threadById.get(threadId);
    if (threadId && !haveThreads.has(threadId)) {
      if (!t) notes.push('thread not found in Gmail');
      else {
        const me = normEmail(myEmail);
        const msgs = (t.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
        const mine = msgs.filter(m => emailFromHeader(headerOf(m, 'From')) === me);
        const verdicts = msgs.map(m => classifyMessage(m, myEmail)).filter(Boolean);
        if (!mine.length) { notes.push('only an unsent draft in Gmail'); unsent.push(`${str(r['Recruiter Name']) || email} @ ${company}`); }
        else {
          const step = Math.min(mine.length, maxMails);
          const first = parseTs(mine[0].internalDate), last = parseTs(mine[mine.length - 1].internalDate);
          const replied = verdicts.some(v => v.kind === 'REPLY');
          const bounced = verdicts.some(v => v.kind === 'BOUNCE');
          const state = replied ? 'REPLIED' : bounced ? 'BOUNCED' : 'ACTIVE';
          const gap = step >= maxMails ? exhaustAfter : (gaps[step - 1] || gaps[gaps.length - 1] || 3);
          const jobLink = str(r['Job Link']);
          const jobId = (jobLink.match(/(\d{8,})/) || [])[1] || '';
          const type = jobLink ? 'JOB' : 'COLD';
          const outreachId = hashId('O', `${rid}|migrated|${threadId}`);
          const nextSendDate = state === 'ACTIVE' ? addBusinessDays(istDateStr(last), gap, sendDays, holidays) : '';
          outreachRow = {
            outreachId, recruiterId: rid, recruiterName: str(r['Recruiter Name']), company, companyId: cid, type, originType: type,
            jobId, role: str(r['Job Title']), state, step, nextTemplate: step >= maxMails ? '' : `${type}_FU${step}`, templateOverride: '',
            nextSendDate, threadId, lastMessageId: mine[mine.length - 1].id, subject: headerOf(msgs[0], 'Subject'),
            lastSentAt: istTsStr(last), createdAt: istTsStr(first), endedAt: state === 'ACTIVE' ? '' : nowTs,
            endReason: state === 'ACTIVE' ? '' : state, note: 'Migrated from Cold Mailing',
          };
          logRows = mine.slice(0, maxMails).map((m, i) => ({
            logId: hashId('L', `${outreachId}#${i + 1}`), sentAt: istTsStr(parseTs(m.internalDate)), outreachId, recruiterId: rid,
            jobId, templateCode: 'LEGACY', kind: i === 0 ? 'NEW' : 'FOLLOWUP', mode: 'MIGRATED', step: i + 1, email, threadId,
            messageId: m.id, result: 'OK', note: 'Imported from Cold Mailing',
          }));
          if (replied) nReplied++;
        }
      }
    }
    out.outreachData.push(rowWrite('Contacts', headers.Contacts, cNext++, {
      recruiterId: rid, name: str(r['Recruiter Name']), title: '', company, companyId: cid, linkedinUrl: '', isRelevant: 'Y',
      hold: '', email, emailStatus: outreachRow && outreachRow.state === 'BOUNCED' ? 'BOUNCED' : 'VALID', enrichStatus: '',
      enrichmentId: '', enrichedAt: '', addedAt: toIstDate(r.Timestamp) ? istTsStr(parseTs(r.Timestamp)) : nowTs,
      source: 'ColdMailing', notes: notes.join('; '),
    }));
    nContacts++;
    if (outreachRow) {
      out.outreachData.push(rowWrite('Outreach', headers.Outreach, oNext++, outreachRow));
      for (const l of logRows) out.outreachData.push(rowWrite('Mail Log', headers['Mail Log'], lNext++, l));
      nThreads++;
    }
  }
  out.summary.push(`Imported ${nContacts} recruiters from Cold Mailing (${nThreads} live threads, ${nReplied} already replied).`);
  if (unsent.length) out.summary.push(`Unsent Gmail drafts left by the old pipeline (send or delete them, they are treated as fresh contacts): ${unsent.join(', ')}`);
  out.summary.push(`Setup completed ${today}. Mode is DRY_RUN: the daily run only writes the Outreach Plan tab until you change Outreach Config.mode.`);
  return out;
}

function coldMailingThreadIds(tabs) {
  const cfg = parseConfig(tabs['Outreach Config'] || []);
  if (str(cfg.setupCompletedAt)) return [];
  const cold = parseTable(tabs['Cold Mailing'] || []);
  return [...new Set(cold.rows.map(r => str(r.ThreadId)).filter(Boolean))];
}
