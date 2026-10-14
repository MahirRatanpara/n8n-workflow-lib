// ── digest.js ───────────────────────────────────────────────────────────────
// Plain-text Telegram messages (no parse mode, so names never break markup).

const KIND_LABEL = { NEW_ROLE: 'new-role follow-ups', JOB_NEW: 'new job threads', FOLLOWUP: 'follow-ups', COLD_NEW: 'cold intros' };

function chunkMessage(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if ((cur + line + '\n').length > max && cur) { out.push(cur.trimEnd()); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

function formatDigest({ digest, results, mode }) {
  const L = [];
  const sent = results.filter(r => r.result === 'SENT');
  const skipped = results.filter(r => r.result === 'SKIPPED');
  const verb = mode === 'SEND' ? 'sent' : mode === 'DRAFT' ? 'drafted' : 'planned (dry run)';
  L.push(`📬 Outreach ${digest.today} · mode ${mode}`);
  if (!digest.sendDay) L.push('Not a send day (weekend/holiday): reply sync only.');
  const done = mode === 'DRY_RUN' ? digest.total : sent.length;
  L.push(`${done} ${verb} of ${digest.total} planned · cap ${digest.cap}`);
  const parts = Object.entries(digest.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_LABEL[k]}`);
  if (parts.length) L.push(parts.join(' · '));
  if (digest.events.length) {
    L.push('');
    for (const e of digest.events) {
      if (e.type === 'REPLY') L.push(`🎉 Reply: ${e.name || e.email} @ ${e.company}${e.snippet ? ` — "${String(e.snippet).slice(0, 120)}"` : ''}`);
      if (e.type === 'BOUNCE') L.push(`↩️ Bounced: ${e.name || e.email} @ ${e.company}`);
      if (e.type === 'OOO') L.push(`🏖 Out of office: ${e.name} @ ${e.company}, paused until ${e.until}`);
    }
  }
  if (digest.picked.length) {
    L.push('', 'Jobs picked:');
    for (const p of digest.picked) {
      L.push(`• ${p.prio ? '⭐ ' : ''}${p.company}: ${p.title} (${p.score === null || p.score === undefined ? 'no score' : p.score}${p.scoreSource === 'ai' ? ' AI' : ''}) → ${p.fresh} new, ${p.merges} new-role${p.siblings ? ` · ${p.siblings} sibling jobs skipped` : ''}`);
    }
  }
  const jc = Object.entries(digest.jobCounts).filter(([k]) => k !== 'PICKED').map(([k, n]) => `${n} ${k}`);
  if (jc.length) L.push(`Other jobs: ${jc.join(', ')}`);
  if (digest.deferredJobs.length) L.push(`Deferred to next run (budget): ${digest.deferredJobs.join('; ')}`);
  if (digest.deferredCommitments) L.push(`${digest.deferredCommitments} due follow-ups wait a day (cap reached).`);
  if (digest.noContacts.length) L.push(`🔎 Find recruiters for: ${digest.noContacts.join(', ')}`);
  if (digest.lowPools.length) L.push(`⚠️ Low recruiter pool: ${digest.lowPools.join(', ')}`);
  if (digest.unresolved.length) L.push(`❓ Unknown company names (add to Companies.Aliases): ${digest.unresolved.join(', ')}`);
  if (skipped.length) {
    const why = {};
    skipped.forEach(s => { why[s.reason] = (why[s.reason] || 0) + 1; });
    L.push(`Skipped at send time: ${Object.entries(why).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  for (const a of digest.alerts) L.push(`⚠️ ${a}`);
  const st = digest.stats;
  const pct = x => (x.threads ? `${Math.round(100 * x.replied / x.threads)}%` : '–');
  L.push('', `Last 30 days: ${st.sent30} mails · reply rate job ${pct(st.job)} (${st.job.replied}/${st.job.threads}), cold ${pct(st.cold)} (${st.cold.replied}/${st.cold.threads})`);
  return chunkMessage(L.join('\n'));
}

function formatSyncAlert(events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'REPLY') lines.push(`🎉 ${e.name || e.email} @ ${e.company} replied${e.subject ? ` (“${e.subject}”)` : ''}${e.snippet ? `:\n"${String(e.snippet).slice(0, 200)}"` : ''}\nFollow-ups to them are stopped.`);
    if (e.type === 'BOUNCE') lines.push(`↩️ Bounce: ${e.name || e.email} @ ${e.company}. Email marked BOUNCED.`);
  }
  return lines.length ? chunkMessage(lines.join('\n\n')) : [];
}
