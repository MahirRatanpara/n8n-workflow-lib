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

// Returns { updates: [{_row, fields}], submit: body|null, submitIds, pollIds, alerts }
function prepareEnrichment({ contacts, companyIndex, cfg, nowTs }) {
  const updates = [], alerts = [], pollIds = new Set(), toSubmit = [];
  const seenUrl = new Map(), seenEmail = new Map(), seenId = new Set();
  const batch = Math.max(1, Math.min(100, cfgNum(cfg, 'fullEnrichBatchSize', 25)));
  for (const c of contacts) {
    if (!str(c.name) && !str(c.linkedinUrl) && !str(c.email)) continue;
    const f = {};
    let rid = str(c.recruiterId);
    if (!rid || seenId.has(rid)) { rid = recruiterIdFor(c); if (seenId.has(rid)) rid = hashId('R', `${rid}|${c._row}`); f.recruiterId = rid; }
    seenId.add(rid);
    if (!str(c.addedAt)) f.addedAt = nowTs;
    if (!str(c.source)) f.source = 'Cowork';
    const cid = str(c.companyId) || resolveCompany(companyIndex, c.company);
    if (!str(c.companyId) && cid) f.companyId = cid;
    if (!cid && isYes(c.isRelevant) && str(c.company)) alerts.push(`Unknown company "${str(c.company)}" for ${str(c.name)} (add it to Companies or its Aliases)`);

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
    const canEnrich = !!u || (first && last && (str(c.company) || cid));
    if (isYes(c.isRelevant) && !e && !status && toSubmit.length < batch) {
      if (canEnrich) {
        toSubmit.push({
          rid,
          data: {
            ...(first ? { firstname: first } : {}), ...(last ? { lastname: last } : {}),
            company_name: (companyIndex && companyIndex.names.get(cid)) || str(c.company),
            ...(u ? { linkedin_url: str(c.linkedinUrl) } : {}),
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
  return { updates, submit, submitIds: toSubmit.map(t => t.rid), pollIds: [...pollIds], alerts };
}

// results: FullEnrich GET responses (errors for in-progress ones are ignored).
function applyEnrichmentResults({ results, contacts, nowTs }) {
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
        if (email) {
          found++;
          updates.push({ _row: c._row, fields: { email, emailStatus: FULLENRICH_STATUS[raw.toUpperCase()] || 'PROBABLE', enrichStatus: 'DONE', enrichedAt: nowTs } });
        } else {
          notFound++;
          updates.push({ _row: c._row, fields: { emailStatus: 'NOT_FOUND', enrichStatus: 'NOT_FOUND', enrichedAt: nowTs } });
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
  if (!id) return { updates: [], alerts: [`FullEnrich did not accept the batch: ${JSON.stringify(response && (response.error || response)).slice(0, 200)}`] };
  const byRid = new Map(contacts.map(c => [str(c.recruiterId), c]));
  const updates = [];
  for (const rid of submitIds) {
    const c = byRid.get(rid);
    if (c) updates.push({ _row: c._row, fields: { enrichStatus: 'PENDING', enrichmentId: id, notes: `Submitted ${nowTs}` } });
  }
  return { updates, alerts: [], enrichmentId: id };
}
