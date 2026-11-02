// ── enrich.js ───────────────────────────────────────────────────────────────
// Contacts hygiene + FullEnrich (v1 bulk API: submit, then poll by id).

const FULLENRICH_STATUS = { DELIVERABLE: 'VALID', HIGH_PROBABILITY: 'PROBABLE', CATCH_ALL: 'CATCH_ALL', INVALID: 'INVALID' };

function recruiterIdFor(c) {
  const key = normUrl(c.linkedinUrl) || normEmail(c.email) || `${str(c.name).toLowerCase()}|${str(c.company).toLowerCase()}`;
  return hashId('R', key);
}

function splitName(name) {
  const parts = str(name).replace(/\(.*?\)/g, ' ').split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

// Generated ids look like R + 9 base-36 chars. Anything else typed into the
// column (e.g. "1") is replaced, unless an Outreach row already points at it.
const RECRUITER_ID_RE = /^R[0-9a-z]{9}$/;

// A row only needs a LinkedIn URL: the id, relevance, source and date are
// filled here; name, title, company, companyId and email come from FullEnrich.
// Returns { updates: [{_row, fields}], submit: body|null, submitIds, pollIds, alerts }
function prepareEnrichment({ contacts, companyIndex, cfg, nowTs, referencedIds }) {
  const updates = [], alerts = [], pollIds = new Set(), toSubmit = [];
  const seenUrl = new Map(), seenEmail = new Map(), seenId = new Set();
  const referenced = referencedIds instanceof Set ? referencedIds : new Set(referencedIds || []);
  const batch = Math.max(1, Math.min(100, cfgNum(cfg, 'fullEnrichBatchSize', 25)));
  const defaultRelevant = cfgStr(cfg, 'defaultRelevant', 'Y').toUpperCase() === 'N' ? '' : 'Y';
  for (const c of contacts) {
    if (!str(c.name) && !str(c.linkedinUrl) && !str(c.email)) continue;
    const f = {};
    let rid = str(c.recruiterId);
    const keep = rid && !seenId.has(rid) && (RECRUITER_ID_RE.test(rid) || referenced.has(rid));
    if (!keep) { rid = recruiterIdFor(c); if (seenId.has(rid)) rid = hashId('R', `${rid}|${c._row}`); f.recruiterId = rid; }
    seenId.add(rid);
    if (!str(c.addedAt)) f.addedAt = nowTs;
    if (!str(c.source)) f.source = str(c.linkedinUrl) && !str(c.company) ? 'Manual' : 'Cowork';
    if (!str(c.isRelevant) && defaultRelevant) f.isRelevant = defaultRelevant;
    const relevant = isYes(f.isRelevant || c.isRelevant);
    const cid = str(c.companyId) || resolveCompany(companyIndex, c.company);
    if (!str(c.companyId) && cid) f.companyId = cid;
    if (!cid && relevant && !isYes(c.hold) && str(c.company)) alerts.push(`Unknown company "${str(c.company)}" for ${str(c.name)} (add it to Companies or its Aliases)`);

    const u = normUrl(c.linkedinUrl), e = normEmail(c.email);
    const dupOf = (u && seenUrl.get(u)) || (e && seenEmail.get(e));
    if (dupOf) {
      if (str(c.enrichStatus).toUpperCase() !== 'DUPLICATE') { f.enrichStatus = 'DUPLICATE'; f.notes = `Duplicate of ${dupOf}`; }
      if (Object.keys(f).length) updates.push({ _row: c._row, fields: f });
      continue;
    }
    if (u) seenUrl.set(u, rid);
    if (e) seenEmail.set(e, rid);

    const status = str(c.enrichStatus).toUpperCase();
    if (e && !str(c.emailStatus)) f.emailStatus = 'PROBABLE'; // supplied by hand / Cowork, unverified
    if (status === 'PENDING' && str(c.enrichmentId)) pollIds.add(str(c.enrichmentId));
    const { first, last } = splitName(c.name);
    const companyName = (companyIndex && companyIndex.names.get(cid)) || str(c.company);
    if (relevant && !e && !status && toSubmit.length < batch) {
      if (u || (first && last && companyName)) {
        toSubmit.push({
          rid, row: c._row,
          data: {
            // FullEnrich wants a LinkedIn URL, or first + last name + company.
            ...(u ? { linkedin_url: str(c.linkedinUrl) } : {}),
            ...(first && last ? { firstname: first, lastname: last } : {}),
            ...(companyName ? { company_name: companyName } : {}),
            enrich_fields: ['contact.emails'],
            custom: { recruiterId: rid },
          },
        });
      } else {
        alerts.push(`${str(c.name) || 'Row ' + c._row}: needs a LinkedIn URL or a full name + company to find an email`);
      }
    }
    if (Object.keys(f).length) updates.push({ _row: c._row, fields: f });
  }
  const submit = toSubmit.length ? { name: `Outreach ${nowTs.slice(0, 16)} (${toSubmit.length})`, datas: toSubmit.map(t => t.data) } : null;
  return { updates, submit, submitIds: toSubmit.map(t => t.rid), submitRows: toSubmit.map(t => ({ recruiterId: t.rid, _row: t.row })), pollIds: [...pollIds], alerts };
}

// A GET result that is not ready yet: FullEnrich answers 400
// error.enrichment.in_progress, or 200 with a CREATED / IN_PROGRESS status.
function enrichmentInProgress(r) {
  if (!r) return false;
  if (r.error) return /in_progress|not ready/i.test(JSON.stringify(r.error));
  return ['CREATED', 'IN_PROGRESS'].includes(str(r.status).toUpperCase());
}

// Profile fields from a FullEnrich record, written only into empty cells
// (a single-word name is completed to the full name).
function profileFields(c, ct, companyIndex, alerts) {
  const p = ct.profile || {};
  const pos = p.position || {};
  const co = pos.company || {};
  const f = {};
  const full = [str(p.firstname || ct.firstname), str(p.lastname || ct.lastname)].filter(Boolean).join(' ');
  const cur = str(c.name);
  if (full && (!cur || (full.toLowerCase().startsWith(cur.toLowerCase()) && full.length > cur.length))) f.name = full;
  const title = str(pos.title) || str(p.headline);
  if (title && !str(c.title)) f.title = title;
  if (str(co.name) && !str(c.company)) f.company = str(co.name);
  if (!str(c.linkedinUrl) && str(p.linkedin_url)) f.linkedinUrl = str(p.linkedin_url);
  if (!str(c.companyId)) {
    const lid = str(co.linkedin_id);
    // LinkedIn's company id is the same number as Companies.CompanyID.
    const cid = (lid && companyIndex && companyIndex.names.has(lid)) ? lid : resolveCompany(companyIndex, co.name || c.company);
    if (cid) f.companyId = cid;
    else if (lid || str(co.name)) {
      f.companyId = lid;
      alerts.push(`${full || cur}: works at ${str(co.name) || 'company ' + lid}${lid ? ` (LinkedIn id ${lid})` : ''}, which is not in the Companies tab`);
    }
  }
  return f;
}

// results: FullEnrich GET responses (errors for in-progress ones are ignored).
function applyEnrichmentResults({ results, contacts, nowTs, companyIndex }) {
  const byRid = new Map(contacts.map(c => [str(c.recruiterId), c]));
  const updates = [], alerts = [];
  let found = 0, notFound = 0;
  for (const r of results || []) {
    if (!r || r.error || !r.id) continue;
    const st = str(r.status).toUpperCase();
    const waiting = contacts.filter(c => str(c.enrichmentId) === str(r.id) && str(c.enrichStatus).toUpperCase() === 'PENDING');
    if (st === 'FINISHED') {
      const seen = new Set();
      for (const d of r.datas || []) {
        const rid = str(d.custom && d.custom.recruiterId);
        const c = byRid.get(rid);
        if (!c || str(c.enrichmentId) !== str(r.id)) continue;
        seen.add(rid);
        const ct = d.contact || {};
        const emails = Array.isArray(ct.emails) ? ct.emails : [];
        const email = str(ct.most_probable_email) || str((emails.find(x => str(x.status).toUpperCase() !== 'INVALID') || {}).email);
        const raw = str(ct.most_probable_email_status) || str((emails.find(x => normEmail(x.email) === normEmail(email)) || {}).status);
        const profile = profileFields(c, ct, companyIndex, alerts);
        if (email) {
          found++;
          updates.push({ _row: c._row, fields: { ...profile, email, emailStatus: FULLENRICH_STATUS[raw.toUpperCase()] || 'PROBABLE', enrichStatus: 'DONE', enrichedAt: nowTs } });
        } else {
          notFound++;
          updates.push({ _row: c._row, fields: { ...profile, emailStatus: 'NOT_FOUND', enrichStatus: 'NOT_FOUND', enrichedAt: nowTs } });
        }
      }
      for (const c of waiting) if (!seen.has(str(c.recruiterId))) { notFound++; updates.push({ _row: c._row, fields: { emailStatus: 'NOT_FOUND', enrichStatus: 'NOT_FOUND', enrichedAt: nowTs } }); }
    } else if (st === 'CREDITS_INSUFFICIENT' || st === 'CANCELED' || st === 'UNKNOWN') {
      for (const c of waiting) updates.push({ _row: c._row, fields: { enrichStatus: 'FAILED', notes: `FullEnrich ${st} ${nowTs}` } });
      alerts.push(`FullEnrich ${st}: ${waiting.length} contacts marked FAILED (clear enrichStatus to retry)`);
    } else if (st === 'RATE_LIMIT') {
      for (const c of waiting) updates.push({ _row: c._row, fields: { enrichStatus: '', enrichmentId: '' } });
    }
  }
  return { updates, alerts, found, notFound };
}

function markSubmitted({ response, submitIds, contacts, nowTs }) {
  const id = str(response && response.enrichment_id);
  if (!id) {
    const raw = String((response && response.error && response.error.message) || JSON.stringify(response || {}));
    const msg = (raw.match(/\\*"message\\*"\s*:\s*\\*"([^"\\]+)/) || [])[1] || raw.slice(0, 160);
    const code = (raw.match(/^(\d{3})/) || [])[1];
    const hint = code === '401' ? ' Check the FullEnrich credential: a Bearer Auth credential holding just the API key.' : code === '402' ? ' Out of FullEnrich credits.' : '';
    return { updates: [], alerts: [`FullEnrich rejected the batch${code ? ` (${code})` : ''}: ${msg}.${hint}`] };
  }
  const byRid = new Map(contacts.map(c => [str(c.recruiterId), c]));
  const updates = [];
  for (const rid of submitIds) {
    const c = byRid.get(rid);
    if (c) updates.push({ _row: c._row, fields: { enrichStatus: 'PENDING', enrichmentId: id, notes: `Submitted ${nowTs}` } });
  }
  return { updates, alerts: [], enrichmentId: id };
}
