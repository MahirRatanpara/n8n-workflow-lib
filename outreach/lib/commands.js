// ── commands.js ─────────────────────────────────────────────────────────────
// Telegram commands. Job digests print tappable commands like /p4432092573.
//   /p<jobid>  mark priority (and make the job eligible again)
//   /x<jobid>  remove priority
//   /a<jobid>  mark as applied (templates then say "I've applied")
//   /help

function parseCommand(text) {
  const t = str(text).split('@')[0];
  let m = t.match(/^\/(p|x|a)_?(\d{6,})$/i);
  if (m) return { cmd: { p: 'priority', x: 'unpriority', a: 'applied' }[m[1].toLowerCase()], jobId: m[2] };
  if (/^\/(help|start)$/i.test(t)) return { cmd: 'help' };
  return null;
}

// job: Result row object (with _row) or undefined. Returns { fields, reply }.
function applyCommand(parsed, job) {
  if (parsed.cmd === 'help') {
    return { fields: null, reply: 'Commands:\n/p<jobid> mark a job as priority (outreach on the next run)\n/x<jobid> remove priority\n/a<jobid> mark a job as applied\nThe job digest prints these for every job.' };
  }
  if (!job) return { fields: null, reply: `Job ${parsed.jobId} is not in the Result sheet.` };
  const label = `${str(job.title)} @ ${str(job.company)}`;
  const status = str(job.outreachStatus).toUpperCase();
  if (parsed.cmd === 'priority') {
    const fields = { isPriority: 'Y' };
    let reply = `⭐ Priority: ${label}.`;
    if (status === 'PICKED') reply += ` Outreach already went out (${str(job.outreachAt)}); priority recorded.`;
    else { if (status) fields.outreachStatus = ''; reply += ' It goes out on the next weekday run (09:30 IST), ignoring cooldown, score and age limits.'; }
    return { fields, reply };
  }
  if (parsed.cmd === 'unpriority') return { fields: { isPriority: '' }, reply: `Priority removed: ${label}.` };
  if (parsed.cmd === 'applied') return { fields: { applied: 'Y' }, reply: `✅ Marked as applied: ${label}. Mails will say "I've applied".` };
  return { fields: null, reply: 'Unknown command. Send /help.' };
}
