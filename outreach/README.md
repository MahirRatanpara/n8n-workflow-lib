# Outreach Engine v2

Recruiter outreach on top of the LinkedIn job scraper: job-specific mails to
fresh recruiters, "new role" upgrades of follow-ups that are due anyway,
business-day follow-ups, reply/bounce detection, and an optional cold-intro
lane. Design spec: <https://claude.ai/artifact/UNRAPUHbiG2er1qVWhoPFL>.

## Workflows (repo root, imported by `deploy/n8n-bootstrap.sh`)

| File | Trigger | Does |
|---|---|---|
| `Linkedin Job Search v3.json` | every 3h | Existing scraper. Now also writes `companyId` and prints `/p<jobid>` priority commands in the Telegram digest |
| `Outreach - Setup run once.json` | manual | Creates tabs and columns, seeds config and templates, marks existing jobs `LEGACY`, copies old Cold Mailing recruiters into Contacts as `LEGACY` (on hold) |
| `Outreach - Contact Enrichment.json` | every 15 min | Paste a LinkedIn URL into Contacts and one run fills recruiterId, isRelevant, name, title, company, companyId and email (FullEnrich: submit → PENDING → poll → write) |
| `Outreach - Reply Sync.json` | hourly :15 | Replies → `REPLIED` + Telegram alert, bounces → `BOUNCED`, out-of-office → pause. Also reconciles drafts: a pipeline draft you deleted without sending → `DISCARDED` and rolled back to retry (first email: recruiter fresh again; follow-up: due again next business day); one found sent in Gmail → logged as `SENT` |
| `Outreach - Daily Run.json` | Mon–Fri 09:30 IST | Sync, then plan, then send (or draft, or dry run), then log, then digest |
| `Outreach - Send Drafts Now.json` | manual | Sends every Gmail draft whose subject contains `sendNowSubjectContains` ("Serving Notice Period") plus every draft the daily run logged in Mail Log, starting now, one every `sendNowGapMin` (2) minutes |
| `Outreach - Telegram Commands.json` | Telegram bot | `/p<jobid>` priority, `/x<jobid>` unpriority, `/a<jobid>` applied |
| `Outreach - Error Alert.json` | on error | Telegram alert when any outreach workflow fails |

The old `Cold Mailing Pipeline.json` is untouched. **Deactivate it before
switching `mode` away from `DRY_RUN`**, or both will mail the same people.

## Finding new recruiters

[`cowork/find-recruiters.md`](cowork/find-recruiters.md) is a Claude Cowork
playbook. Open it in Cowork and say "Run this playbook". It picks the companies
that need recruiters (recent `NO_CONTACTS` jobs first, then companies with
fewer than 8 usable contacts), finds technical recruiters at them on LinkedIn
(read-only, no messages), skips anyone already in `Contacts`, and appends
`name · title · company · companyId · linkedinUrl · isRelevant=Y ·
source=Cowork`. The enrichment workflow does the rest within 15 minutes.

## Sheets

Everything lives in the **n8n - Switch** spreadsheet:

- New tabs: `Contacts` (you + Cowork + enrichment), `Outreach` (one row per
  thread, machine-owned), `Mail Log` (append-only), `Outreach Templates`,
  `Outreach Config`, `Outreach Plan` (rewritten every run).
- Existing tabs: `Result` gains `companyId · isPriority · outreachStatus ·
  outreachAt · applied`. `Low Match` gains `companyId`. `Companies` gains
  `Aliases`. The scraper's own `Config` tab is untouched.

*Switch Contacts* is no longer used by the engine. Setup reads its
`Cold Mailing` tab once (read-only) and copies those recruiters into
`Contacts` as `LEGACY`: `hold = Y`, `source = LEGACY`, no Outreach or Mail Log
rows, and Gmail is never read. They are never mailed automatically, and a
later Cowork row with the same email is treated as a duplicate. To let the
engine contact one of them, clear `hold` on their row.

**Adding a recruiter by hand:** put their LinkedIn URL in `Contacts.linkedinUrl`
(a name is optional) and leave the other cells empty. One enrichment run
(every 15 minutes, or click *Execute workflow*) does everything:
1. Gives the row a `recruiterId` (anything you typed there, like `1`, is
   replaced) and sets `isRelevant = Y` (from `defaultRelevant` in Outreach
   Config).
2. Sends the row to FullEnrich and marks it `PENDING` with its `enrichmentId`.
3. Waits 20 seconds and checks FullEnrich again every 20 seconds while it's
   still working (up to `enrichPollRounds`, 6 by default).
4. Fills in the full name, title, company, `companyId` (LinkedIn's company id,
   the same number as `Companies.CompanyID`) and email.

If FullEnrich takes longer than that, the row stays `PENDING` and the next run
picks it up. If they work somewhere that's not in the Companies tab, Telegram
tells you. Set `isRelevant = N` to stop a row from being enriched or
contacted.

Columns you edit: `Contacts.linkedinUrl`, `Contacts.isRelevant`, `Contacts.hold`, `Result.isPriority`,
`Result.applied`, `Outreach.templateOverride` (one-shot), `Companies.Aliases`,
everything in `Outreach Templates` and `Outreach Config`. Don't sort or
delete rows in `Outreach` or `Mail Log`.

## Go-live checklist

1. Import the workflows (re-run the bootstrap, or import the files in the UI)
   and select your existing Google Sheets / Drive / Gmail / Telegram
   credentials on any node that shows a warning.
2. FullEnrich: use a **Bearer Auth** credential whose token is just the API
   key (n8n adds the `Bearer ` prefix). The workflows point at the instance's
   "Bearer Auth account". Don't use a Header Auth credential: one with the
   header name `Bearer` sends no `Authorization` header and FullEnrich
   answers 401.
3. Run **Outreach - Setup (run once)**. The Telegram summary says how many
   jobs and Cold Mailing recruiters were marked `LEGACY`.
4. Read every row of **Outreach Templates** and rewrite it in your own voice.
   Placeholders: `{{FirstName}} {{Company}} {{Role}} {{JobURL}} {{JobId}}
   {{ApplyPhrase}} {{ResumeURL}} {{SenderName}}`. Set the resume
   Drive file to "Anyone with the link can view" (used in NEW_ROLE mails).
5. Activate Reply Sync, Contact Enrichment, Telegram Commands and Daily Run.
   `mode` starts at `DRY_RUN`: each weekday the plan lands in the
   **Outreach Plan** tab and in Telegram, and nothing is sent.
6. After about a week of plans that look right: deactivate *Cold Mailing
   Pipeline* and set `mode = DRAFT`. That's the normal way to run it: each
   weekday the daily run leaves Gmail drafts, you review them (edit or delete
   any), then run **Outreach - Send Drafts Now**. It sends every draft whose
   subject contains `sendNowSubjectContains` ("Serving Notice Period"), plus
   every draft the daily run logged in Mail Log (so job threads started before
   the phrase was in their subject still go), starting immediately, one every
   `sendNowGapMin` (2) minutes. Drafts the daily run made also get their Mail
   Log row marked sent and their follow-up clock restarted from the send day.
   Keep that phrase in every template subject, and out of drafts you don't
   want sent. (`mode = SEND` still works if you ever want the daily run to
   send without review.)
7. Later: set `coldPerDay = 5` to turn on cold intros (see step 5 below).

## How a day works

The daily run uses no AI. Every mail is one of your fixed templates in
`Outreach Templates`, picked by the step the thread is at.

1. **Sync.** Gmail is searched for replies, bounces and out-of-office mail on tracked threads.
2. **Jobs.** Unprocessed jobs are grouped by `companyId` and one is picked per
   company: `isPriority` first, then score (a missing score counts as 0),
   then the newest job ID. The rest of each group become `SIBLING`, and a job
   can also end up `COOLDOWN` (company had job outreach in the last 7 days),
   `LOW_SCORE` (< 80), `EXPIRED` (> 3 business days old), `NO_CONTACTS` or
   `UNRESOLVED`. Priority jobs skip the cooldown, score and age checks.
3. **Merges.** Recruiters at a picked company whose follow-up is due get a
   `NEW_ROLE` mail on their existing thread instead of a generic nudge (job
   threads first). The thread becomes a JOB thread for the new job.
4. **Follow-ups.** Every other due recruiter gets `JOB_FU`/`COLD_FU`
   (`*_FU3` for the last one). The gaps are 3, 4 and 7 business days, and a
   thread is `EXHAUSTED` 7 business days after its 4th mail.
5. **Budget.** Commitments (merges and follow-ups) come first. What's left of
   `dailySendCap` goes to fresh recruiters (up to `newPerJob` per job, in job
   rank order). Jobs that don't fit stay unprocessed and are retried the next
   day. Cold intros get whatever remains (`coldPerDay`). They go only to
   companies with **no tracked opening** (no Result job added in the last
   `coldNoOpeningDays`, 5), and to the recruiters we already have there and
   have never written to, at most `coldPerCompanyPerDay` (2) per company per
   day. A company with an opening gets opening mails (new + due recruiters)
   instead of cold ones.
6. **Send.** Each mail is checked against the 09:00–12:30 IST window. Before a
   follow-up goes out its thread is re-read, and a reply that just arrived
   cancels it. A closed LinkedIn posting cancels job mails. The mail is sent
   or drafted through the Gmail API (no n8n footer) as text plus HTML, so it
   keeps your template's line breaks and nothing else, with no hard wrapping, then the Mail Log and
   Outreach rows are written, then there's a 60–180 s pause.
7. **Digest** to Telegram: sends, replies, picked jobs, companies needing
   recruiters, low pools, unknown company names, and 30-day reply rates.

Re-running on the same day is safe: outreach IDs are deterministic, the Mail
Log blocks a second send of the same step, and a follow-up is skipped if its
thread shows a mail from you in the last 20 hours that the sheet never
recorded (covers a crash between Gmail and the sheet write).

## Changing the logic

All Code-node logic lives in `outreach/lib/*.js` and is inlined into the
workflow JSON by the generator:

```bash
cd outreach && npm test && npm run build
```

`npm run build` regenerates the six `Outreach - *.json` files and re-applies
the scraper patch, which is idempotent. Re-import the changed files into
n8n afterwards.
