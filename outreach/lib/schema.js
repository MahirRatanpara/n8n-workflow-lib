// ── schema.js ───────────────────────────────────────────────────────────────
// Single source of truth for tab names, headers, config defaults and seed
// templates. Setup creates exactly this; every workflow reads by header name.

const SHEETS = {
  outreachDb: '1NkiDm46ftPj1cYYR1tP0FQjo8BXoniWTH-m1bYLr0mY', // "Switch Contacts"
  jobsDb: '1DSZ4JZuiYYdzgbxSpd9Omm9jjyEGqx1uiosETxUSvJo',     // "n8n - Switch"
};

const TABS = {
  contacts: 'Contacts',
  outreach: 'Outreach',
  mailLog: 'Mail Log',
  templates: 'Outreach Templates',
  config: 'Outreach Config',
  plan: 'Outreach Plan',
  legacyCold: 'Cold Mailing',
  jobs: 'Result',
  lowMatch: 'Low Match',
  companies: 'Companies',
};

const HEADERS = {
  Contacts: ['recruiterId', 'name', 'title', 'company', 'companyId', 'linkedinUrl', 'isRelevant', 'hold',
    'email', 'emailStatus', 'enrichStatus', 'enrichmentId', 'enrichedAt', 'addedAt', 'source', 'notes'],
  Outreach: ['outreachId', 'recruiterId', 'recruiterName', 'company', 'companyId', 'type', 'originType', 'jobId',
    'role', 'state', 'step', 'nextTemplate', 'templateOverride', 'nextSendDate', 'threadId', 'lastMessageId', 'subject',
    'lastSentAt', 'createdAt', 'endedAt', 'endReason', 'note'],
  'Mail Log': ['logId', 'sentAt', 'outreachId', 'recruiterId', 'jobId', 'templateCode', 'kind', 'mode', 'step',
    'email', 'threadId', 'messageId', 'result', 'note'],
  'Outreach Templates': ['templateCode', 'subject', 'body', 'attachResume', 'notes'],
  'Outreach Config': ['Setting', 'Value', 'Notes'],
  'Outreach Plan': ['plannedFor', 'order', 'kind', 'templateCode', 'company', 'recruiterName', 'email', 'jobId',
    'role', 'score', 'outreachId', 'stepAfter', 'subject', 'bodyPreview', 'note'],
};
const JOB_COLUMNS_ADDED = ['companyId', 'isPriority', 'outreachStatus', 'outreachAt', 'applied'];

const CONFIG_DEFAULTS = [
  ['mode', 'DRY_RUN', 'DRY_RUN = plan only (writes Outreach Plan tab). DRAFT = Gmail drafts. SEND = real email. Deactivate the old Cold Mailing Pipeline before leaving DRY_RUN.'],
  ['dailySendCap', 15, 'Max emails per day across everything. Raise ~5/week while bounces stay under 3% (target 40).'],
  ['newPerJob', 4, 'Fresh recruiters per picked job (new threads).'],
  ['maxPerJob', 7, 'Total recruiters per job; due follow-ups fill the rest as NEW_ROLE mails at no extra cost.'],
  ['maxMailsPerRecruiter', 4, 'Hard cap of mails in one thread / engagement.'],
  ['followupGapDays', '3,4,7', 'Business days before follow-up 1, 2, 3.'],
  ['exhaustAfterDays', 7, 'Business days to wait for a reply after the last mail before marking EXHAUSTED.'],
  ['sendDays', '1,2,3,4,5', 'Days of week that count as business days (0=Sun … 6=Sat).'],
  ['holidays', '', 'Comma separated YYYY-MM-DD dates with no sending.'],
  ['sendWindowStart', '09:00', 'IST. Mails are only sent inside this window.'],
  ['sendWindowEnd', '12:30', 'IST. Anything not sent by then waits for the next business day.'],
  ['jitterMinSec', 60, 'Random pause between mails (seconds).'],
  ['jitterMaxSec', 180, ''],
  ['companyCooldownDays', 7, 'Calendar days between job outreach waves to the same company (priority jobs ignore it).'],
  ['maxJobAgeDays', 3, 'Unprocessed jobs older than this become EXPIRED (priority jobs ignore it).'],
  ['minOutreachScore', 80, 'Jobs below this (null = 0) become LOW_SCORE unless isPriority = Y.'],
  ['rescoreNullScores', 'Y', 'Ask Gemini to score candidate jobs whose score is empty.'],
  ['pitchLine', 'Y', 'Ask Gemini for a one-sentence fit line per job ({{PitchLine}} in templates).'],
  ['checkJobClosed', 'Y', 'Skip job mails if the LinkedIn posting says it no longer accepts applications.'],
  ['coldPerDay', 0, 'Cold intros per day. 0 = off. Suggested 5 once job outreach is stable.'],
  ['reserveFreshPerCompany', 4, 'Cold outreach never touches a company\'s last N fresh contacts.'],
  ['coldCompanyQuietDays', 14, 'Cold outreach only to companies with no job outreach in this many days.'],
  ['reengageAfterDays', 90, 'An EXHAUSTED recruiter can get one new thread after this many days (0 = never).'],
  ['reengageMinScore', 90, 'Re-engagement only for priority jobs or jobs scoring at least this.'],
  ['sendableEmailStatuses', 'VALID,PROBABLE', 'Which Contacts.emailStatus values may be mailed (CATCH_ALL is riskier).'],
  ['replyLookbackDays', 3, 'How far back reply/bounce sync searches Gmail.'],
  ['oooPauseDays', 5, 'Business days to pause a thread after an out-of-office reply.'],
  ['myEmail', '', 'Filled by setup from your Gmail account.'],
  ['senderName', 'Mahir Ratanpara', 'Display name on outgoing mail and {{SenderName}}.'],
  ['resumeFileId', '1Dw_hTBr9n_Ieca_P7OMngCFnGgotu9Uf', 'Google Drive file id of the resume PDF.'],
  ['resumeLink', 'https://drive.google.com/file/d/1Dw_hTBr9n_Ieca_P7OMngCFnGgotu9Uf/view', '{{ResumeURL}}. Set the Drive file to "Anyone with the link can view".'],
  ['telegramChatId', '8126636123', 'Where alerts and digests go.'],
  ['fullEnrichBatchSize', 25, 'Contacts per FullEnrich request (max 100).'],
  ['setupCompletedAt', '', 'Written by the setup workflow. Clear it only if you want the one-time migration to run again.'],
  ['lastPlanAt', '', 'Written by the daily outreach run.'],
  ['lastSyncAt', '', 'Written by reply sync.'],
  ['lastEnrichAt', '', 'Written by contact enrichment.'],
];

const SEED_TEMPLATES = [
  ['JOB_NEW', '{{Role}} at {{Company}} (Job ID {{JobId}})',
    'Hi {{FirstName}},\n\nI came across the {{Role}} opening at {{Company}} ({{JobURL}}) and wanted to reach out directly. {{ApplyPhrase}}, and I think my background is a strong fit.\n\n{{PitchLine}}\n\nI\'ve attached my resume. Would you be open to a short chat, or could you point me to the recruiter handling this role?\n\nThanks,\n{{SenderName}}',
    'Y', 'First mail of a job thread. Review before leaving DRY_RUN.'],
  ['JOB_FU', '',
    'Hi {{FirstName}},\n\nFollowing up on my note about the {{Role}} role. I\'d really appreciate a few minutes of your time, or a pointer to the right person.\n\nThanks,\n{{SenderName}}',
    'N', 'Generic job follow-up (used for FU1 and FU2). Subject blank = reply on the thread.'],
  ['JOB_FU3', '',
    'Hi {{FirstName}},\n\nOne last follow-up on the {{Role}} role ({{JobURL}}). If the timing or fit isn\'t right, no worries at all. Thanks for your time either way.\n\nBest,\n{{SenderName}}',
    'N', 'Final job follow-up.'],
  ['NEW_ROLE', '',
    'Hi {{FirstName}},\n\nFollowing up on my earlier note: a {{Role}} role just opened at {{Company}} ({{JobURL}}) that matches my background even more closely. {{ApplyPhrase}}.\n\n{{PitchLine}}\n\nMy resume is here: {{ResumeURL}}\n\nWould you be open to a quick conversation?\n\nThanks,\n{{SenderName}}',
    'N', 'Replaces a due follow-up when the recruiter\'s company posts a new matching job (job-to-job and cold-to-job).'],
  ['COLD_NEW', 'Software engineer interested in {{Company}}',
    'Hi {{FirstName}},\n\nI\'m a software engineer and {{Company}} is high on my list of places I\'d love to work. I don\'t see an open role that fits right now, but I wanted to introduce myself in case something comes up on your side. My resume is attached.\n\nWould you keep me in mind, or let me know if there\'s a better person to talk to?\n\nThanks,\n{{SenderName}}',
    'Y', 'Cold intro (only used when coldPerDay > 0).'],
  ['COLD_FU', '',
    'Hi {{FirstName}},\n\nJust bumping this up in case it got buried. Happy to share more about my background if useful.\n\nThanks,\n{{SenderName}}',
    'N', 'Cold follow-up.'],
];

const JOB_STATUS = {
  PICKED: 'PICKED', SIBLING: 'SIBLING', COOLDOWN: 'COOLDOWN', LOW_SCORE: 'LOW_SCORE', NO_CONTACTS: 'NO_CONTACTS',
  EXPIRED: 'EXPIRED', LEGACY: 'LEGACY', UNRESOLVED: 'UNRESOLVED',
};
