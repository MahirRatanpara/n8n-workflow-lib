# Outreach Engine v2

Recruiter outreach on top of the LinkedIn job scraper: job-specific mails to
fresh recruiters, "new role" upgrades of follow-ups that are due anyway,
business-day follow-ups, reply/bounce detection, and an optional cold-intro
lane. Design spec: <https://claude.ai/artifact/UNRAPUHbiG2er1qVWhoPFL>.

## Workflows (repo root, imported by `deploy/n8n-bootstrap.sh`)

| File | Trigger | Does |
|---|---|---|
| `Linkedin Job Search v3.json` | every 3h | Existing scraper. Now also writes `companyId` and prints `/p<jobid>` priority commands in the Telegram digest |
| `Outreach - Setup run once.json` | manual | Creates tabs and columns, seeds config and templates, marks existing jobs `LEGACY`, imports the Cold Mailing tab |
| `Outreach - Contact Enrichment.json` | hourly :45 | Contacts hygiene (recruiterId, companyId, duplicates) and FullEnrich email lookup |
| `Outreach - Reply Sync.json` | hourly :15 | Replies → `REPLIED` + Telegram alert, bounces → `BOUNCED`, out-of-office → pause |
| `Outreach - Daily Run.json` | Mon–Fri 09:30 IST | Sync, then plan, then send (or draft, or dry run), then log, then digest |
| `Outreach - Telegram Commands.json` | Telegram bot | `/p<jobid>` priority, `/x<jobid>` unpriority, `/a<jobid>` applied |
| `Outreach - Error Alert.json` | on error | Telegram alert when any outreach workflow fails |

The old `Cold Mailing Pipeline.json` is untouched. **Deactivate it before
switching `mode` away from `DRY_RUN`**, or both will mail the same people.

## Sheets

*Switch Contacts* (outreach state): `Contacts` (you + Cowork + enrichment),
`Outreach` (one row per thread, machine-owned), `Mail Log` (append-only),
`Outreach Templates`, `Outreach Config`, `Outreach Plan` (rewritten every run).

*n8n - Switch* (jobs): `Result` gains `companyId · isPriority · outreachStatus ·
outreachAt · applied`. `Low Match` gains `companyId`. `Companies` gains `Aliases`.

Columns you edit: `Contacts.isRelevant`, `Contacts.hold`, `Result.isPriority`,
`Result.applied`, `Outreach.templateOverride` (one-shot), `Companies.Aliases`,
everything in `Outreach Templates` and `Outreach Config`. Don't sort or
delete rows in `Outreach` or `Mail Log`.

## Go-live checklist

1. Import the workflows (re-run the bootstrap, or import the files in the UI)
   and select your existing Google Sheets / Drive / Gmail / Telegram / Gemini
   credentials on any node that shows a warning.
2. Create a **Header Auth** credential named `FullEnrich API`
   (`Authorization` = `Bearer <api key>`) and select it on *Get Enrichment
   Result* and *Submit To FullEnrich*.
3. Run **Outreach - Setup (run once)**. The Telegram summary lists what was
   imported and any unsent drafts the old pipeline left in Gmail.
4. Read every row of **Outreach Templates** and rewrite it in your own voice.
   Placeholders: `{{FirstName}} {{Company}} {{Role}} {{JobURL}} {{JobId}}
   {{PitchLine}} {{ApplyPhrase}} {{ResumeURL}} {{SenderName}}`. Set the resume
   Drive file to "Anyone with the link can view" (used in NEW_ROLE mails).
5. Activate Reply Sync, Contact Enrichment, Telegram Commands and Daily Run.
   `mode` starts at `DRY_RUN`: each weekday the plan lands in the
   **Outreach Plan** tab and in Telegram, and nothing is sent.
6. After about a week of plans that look right: deactivate *Cold Mailing
   Pipeline*, set `mode = DRAFT` for 2–3 days (you send the drafts), then
   `mode = SEND` with `dailySendCap = 15`. Raise the cap by about 5 a week
   while bounces stay under 3%, up to about 40.
7. Later: set `coldPerDay = 5` to turn on cold intros.

## How a day works

1. **Sync.** Gmail is searched for replies, bounces and out-of-office mail on tracked threads.
2. **Jobs.** Unprocessed jobs are grouped by `companyId` and one is picked per
   company: `isPriority` first, then score (null = 0, or a Gemini re-score),
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
   day. Cold intros get whatever remains, never touching a company's last 4
   fresh contacts.
6. **Send.** Each mail is checked against the 09:00–12:30 IST window. Before a
   follow-up goes out its thread is re-read, and a reply that just arrived
   cancels it. A closed LinkedIn posting cancels job mails. The mail is sent
   or drafted through the Gmail API (no n8n footer), then the Mail Log and
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
