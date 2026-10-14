// ── ai.js ───────────────────────────────────────────────────────────────────
// One Gemini call per run: scores jobs that have no score yet and writes a
// one-sentence fit line ({{PitchLine}}) for every candidate job.

function aiCandidates({ jobs, cfg, today, companyIndex }) {
  const sendDays = cfgSendDays(cfg), holidays = cfgHolidays(cfg);
  const maxAge = cfgNum(cfg, 'maxJobAgeDays', 3);
  const wantPitch = isYes(cfgStr(cfg, 'pitchLine', 'Y'));
  const wantScore = isYes(cfgStr(cfg, 'rescoreNullScores', 'Y'));
  const out = [];
  for (const j of jobs) {
    if (str(j.outreachStatus) || !str(j.jobid)) continue;
    const prio = isYes(j.isPriority);
    if (!(str(j.companyId) || resolveCompany(companyIndex, j.company))) continue;
    const added = toIstDate(j.addedAt);
    if (!prio && (!added || businessDaysBetween(added, today, sendDays, holidays) > maxAge)) continue;
    const needsScore = wantScore && numOrNull(j.score) === null;
    if (!needsScore && !wantPitch) continue;
    out.push({ job: j, needsScore, prio });
  }
  out.sort((a, b) => (b.prio - a.prio) || ((numOrNull(b.job.score) || 0) - (numOrNull(a.job.score) || 0)));
  return out.slice(0, 40);
}

function buildAiPrompt({ candidates, resumeText, descriptions }) {
  const sections = candidates.map(c => {
    const d = String(descriptions[str(c.job.jobid)] || '').replace(/\s+/g, ' ').slice(0, 1400);
    return `---JOB [id: ${c.job.jobid}] [needs_score: ${c.needsScore ? 'yes' : 'no'}]---\nTitle: ${c.job.title}\nCompany: ${c.job.company}\nDescription:\n${d}\n---END JOB---`;
  }).join('\n\n');
  return `You are helping a software engineer write short, specific outreach emails to recruiters.

## CANDIDATE RESUME
${String(resumeText || '').slice(0, 9000)}

## JOBS (${candidates.length})
${sections}

## TASK
For EVERY job above return:
- "jobid": the exact id
- "score": only when needs_score is yes, an honest 0-100 match score (50 = coin flip, 85+ = near-perfect); otherwise null
- "pitch": ONE sentence, first person, at most 28 words, naming the most relevant concrete overlap between the resume and this job (a technology, domain or scale). No greetings, no hype words, no em dashes, no quotes. If nothing concrete overlaps, use an empty string.

## RESPONSE FORMAT
Only a JSON array, no markdown fences:
[{"jobid":"<id>","score":<number or null>,"pitch":"<sentence>"}]`;
}

function parseAiResponse(json) {
  const text = typeof json?.text === 'string' ? json.text
    : typeof json?.response?.text === 'string' ? json.response.text
    : typeof json?.output === 'string' ? json.output : '';
  const scores = {}, pitches = {};
  try {
    const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
    const arr = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
    for (const r of Array.isArray(arr) ? arr : []) {
      const id = str(r.jobid);
      if (!id) continue;
      const s = numOrNull(r.score);
      if (s !== null && s >= 0 && s <= 100) scores[id] = Math.round(s);
      const p = str(r.pitch).replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ');
      if (p) pitches[id] = /[.!?]$/.test(p) ? p : p + '.';
    }
  } catch (e) { /* AI unavailable: planner treats null scores as 0 and pitch lines as empty */ }
  return { scores, pitches };
}
