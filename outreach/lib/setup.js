// ── setup.js ────────────────────────────────────────────────────────────────
// Phase 0, all inside "n8n - Switch": create/extend the outreach tabs, seed
// config + templates, add job columns and company aliases. First run only
// (guarded by Outreach Config.setupCompletedAt): mark every existing job
// LEGACY and copy the old Cold Mailing recruiters into Contacts as LEGACY
// (hold = Y), so the engine never mails them and never treats them as fresh.
// Nothing is read from Gmail.

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

// tabs: { tabName: values } read from "n8n - Switch".
// jobs: { resultHeader, lowMatchHeader, companies (values), jobIdCol, companyCol, statusCol }
// coldMailing: values of the old Cold Mailing tab ([] if unavailable).
function planSetup({ tabs, jobs, coldMailing, myEmail, now }) {
  const nowTs = istTsStr(now), today = istDateStr(now);
  const out = { data: [], summary: [] };
  const headers = {};

  for (const tab of Object.keys(HEADERS)) {
    const h = headerWrite(tab, (tabs[tab] || [])[0], HEADERS[tab]);
    headers[tab] = h.full;
    if (h.changed || tab === 'Outreach Config') out.data.push(h.write); // config header keeps the batch non-empty
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
      out.data.push({ range: `${quoteTab('Outreach Config')}!A${cfgNext}:C${cfgNext}`, values: [[k, value, note]] });
      cfgNext++;
    } else if ((k === 'myEmail' && !str(cfg.myEmail) && myEmail) || (k === 'setupCompletedAt' && firstRun)) {
      out.data.push({ range: `${quoteTab('Outreach Config')}!B${at + 1}`, values: [[value]] });
    }
  }

  // Templates: seed codes that are not there yet (never overwrite your edits).
  const tplValues = tabs['Outreach Templates'] || [];
  const haveCodes = new Set(tplValues.slice(1).map(r => str(r[0]).toUpperCase()));
  let tplNext = Math.max(tplValues.length, 1) + 1;
  for (const t of SEED_TEMPLATES) {
    if (haveCodes.has(t[0])) continue;
    out.data.push({ range: `${quoteTab('Outreach Templates')}!A${tplNext}:E${tplNext}`, values: [t] });
    tplNext++;
  }

  // Job tabs: new columns on Result / Low Match, Aliases on Companies.
  const rh = headerWrite('Result', jobs.resultHeader, (jobs.resultHeader || []).map(str).filter(Boolean).concat(JOB_COLUMNS_ADDED));
  if (rh.changed) out.data.push(rh.write);
  if (jobs.lowMatchHeader && jobs.lowMatchHeader.length) {
    const lh = headerWrite('Low Match', jobs.lowMatchHeader, jobs.lowMatchHeader.map(str).filter(Boolean).concat(['companyId']));
    if (lh.changed) out.data.push(lh.write);
  }
  const compValues = jobs.companies || [];
  const ch = headerWrite('Companies', compValues[0], (compValues[0] || []).map(str).filter(Boolean).concat(['Aliases']));
  if (ch.changed) out.data.push(ch.write);
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
    if (after !== before) out.data.push({ range: `${quoteTab('Companies')}!${colLetter(aliasCol)}${row}`, values: [[after]] });
  }
  if (unresolved.length) out.summary.push(`Companies in Result with no match in the Companies tab: ${unresolved.join(', ')}`);

  if (!firstRun) {
    out.summary.push('Setup already completed earlier: tabs, columns, config and templates checked; the one-time legacy marking was skipped.');
    return out;
  }

  // LEGACY jobs: every existing job with a blank status.
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
    out.data.push({ range: `${quoteTab('Result')}!${colLetter(statusIdx)}2:${colLetter(statusIdx)}${ids.length}`, values: col });
    out.summary.push(`${legacy} existing jobs marked LEGACY (never mailed automatically).`);
  }

  // LEGACY recruiters: everyone in the old Cold Mailing tab goes into Contacts
  // with hold = Y. No Outreach or Mail Log rows, no Gmail lookups.
  const cold = parseTable(coldMailing || []);
  const contactsT = parseTable(tabs.Contacts || []);
  const haveEmails = new Set(contactsT.rows.map(c => normEmail(c.email)).filter(Boolean));
  let cNext = Math.max(contactsT.lastRow, 1) + 1, n = 0;
  for (const r of cold.rows) {
    const email = normEmail(r['Recruiter Email']);
    if (!email || haveEmails.has(email)) continue;
    haveEmails.add(email);
    const company = str(r['Job Company']);
    out.data.push(rowWrite('Contacts', headers.Contacts, cNext++, {
      recruiterId: hashId('R', email), name: str(r['Recruiter Name']), title: '', company, companyId: resolveCompany(index, company),
      linkedinUrl: '', isRelevant: 'Y', hold: 'Y', email, emailStatus: 'VALID', enrichStatus: '', enrichmentId: '', enrichedAt: '',
      addedAt: toIstDate(r.Timestamp) ? istTsStr(parseTs(r.Timestamp)) : nowTs, source: 'LEGACY',
      notes: `Legacy: contacted by the old Cold Mailing pipeline (status ${str(r.Status) || 'none'}). Clear "hold" to let the engine contact them.`,
    }));
    n++;
  }
  if (cold.rows.length) out.summary.push(`${n} recruiters from Cold Mailing added to Contacts as LEGACY (hold = Y, never mailed automatically).`);
  out.summary.push(`Setup completed ${today}. Mode is DRY_RUN: the daily run only writes the Outreach Plan tab until you change Outreach Config.mode.`);
  return out;
}
