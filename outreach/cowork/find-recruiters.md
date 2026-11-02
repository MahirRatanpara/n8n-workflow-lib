# Find new recruiters (Claude Cowork playbook)

Run this in Claude Cowork: open this file and say **"Run this playbook"**.
You can override the defaults in the same message, for example
*"Run this playbook for Google and Expedia, 5 recruiters each"*.

| Setting | Default | Meaning |
|---|---|---|
| `companies` | picked automatically (Step 2) | Only these companies, by the name in the Companies tab |
| `maxCompanies` | 10 | Companies to cover in one run |
| `perCompany` | 6 | New recruiters to add per company at most |
| `maxProfileViews` | 80 | Hard stop on LinkedIn profile views per run |

---

## What you are doing

You add **technical recruiters at my target companies** to the `Contacts` tab
of my Google Sheet. You only fill in who they ar e. An n8n workflow then finds
their email, completes the profile and decides when to write to them. **You
never contact anyone.**

Spreadsheet **"n8n - Switch"**:
<https://docs.google.com/spreadsheets/d/1DSZ4JZuiYYdzgbxSpd9Omm9jjyEGqx1uiosETxUSvJo/edit>

Tabs you use:
- `Companies`: the target list (`Company`, `CompanyID`, `Active`, `Aliases`). Read only.
- `Result`: scraped jobs (`company`, `companyId`, `outreachStatus`, `outreachAt`). Read only.
- `Contacts`: where you append new rows. Never edit or reorder existing rows.

## Step 1: Read the sheet

1. From `Companies`, take every row where `Active` is `True`. Keep `Company`
   and `CompanyID` exactly as written.
2. From `Contacts`, collect every existing `linkedinUrl` (normalized as in
   Step 4) and count the **usable** contacts per `companyId`. A contact is
   usable when `isRelevant` is `Y`, `hold` is empty, and `emailStatus` is not
   `BOUNCED`, `NOT_FOUND` or `INVALID`.
3. From `Result`, collect the `companyId`s of jobs whose `outreachStatus` is
   `NO_CONTACTS` and whose `outreachAt` is in the last 14 days. These are jobs
   the outreach engine wanted to act on but had nobody to write to.

## Step 2: Choose companies

Unless I named companies, cover up to `maxCompanies`, in this order:
1. Companies with a recent `NO_CONTACTS` job (Step 1.3).
2. Other active companies with **fewer than 8 usable contacts**, fewest first.

Skip companies that already have 8 or more usable contacts.

## Step 3: Search LinkedIn for each company

Use LinkedIn people search, filtered to **current company = that company**
and **location = India**. Try these keywords in order until you have enough
candidates:
1. `technical recruiter`
2. `talent acquisition` engineering
3. `recruiter` software
4. `talent acquisition partner`

Open a profile only when the search card isn't enough to decide.

**Add someone only if all of these are true:**
- They **currently** work at that company (current position, not a past one).
  A subsidiary counts if the Companies tab names it that way, e.g. "Walmart
  Global Tech India".
- Their current title is a recruiting role: Recruiter, Technical Recruiter,
  Talent Acquisition (Partner / Specialist / Lead / Manager), Sourcer, or
  Recruiting Manager.
- They hire for **technology/engineering**. Signs: "Tech", "Technical",
  "Engineering", "Software", "Product & Tech" in the title or headline, or
  their recent posts are about engineering roles. If there's no sign either
  way, include them.
- They're based in India, preferably Bengaluru. Hyderabad, Pune, Chennai,
  Gurugram, Noida and Mumbai are fine.

**Never add:**
- Staffing or consulting agencies and third-party recruiters, even if they
  list the company as a client.
- Campus or university-only recruiters.
- Recruiters for sales, operations, finance, support or other non-tech
  functions.
- HR generalists, HR business partners, payroll, or people-operations admins.
- Executives (CHRO, VP / Head of HR or Talent) or C-level.
- Anyone whose current role is at a different company.

Prefer, in order: titles that say technical/engineering, then senior TA
partners and leads, then everyone else. Stop at `perCompany` per company.

## Step 4: Skip people already in the sheet

Normalize every LinkedIn URL to `https://www.linkedin.com/in/<handle>/`:
lowercase, no query string (`?…`), no `/details/…`, exactly one trailing
slash. If the normalized URL is already in `Contacts`, skip the person. Also
don't add the same person twice in one run.

## Step 5: Append rows to Contacts

Add each new recruiter as a **new row under the last filled row** of
`Contacts`. Fill only these columns, matched by header name, and leave every
other cell empty:

| Column | Value |
|---|---|
| `name` | Full name as shown on LinkedIn |
| `title` | Current job title |
| `company` | `Company` from the Companies tab, written exactly as there |
| `companyId` | `CompanyID` from the Companies tab |
| `linkedinUrl` | The normalized URL from Step 4 |
| `isRelevant` | `Y` |
| `source` | `Cowork` |
| `notes` | `Found <today's date> via "<keyword>" · <city>` |

Do **not** fill `recruiterId`, `email`, `emailStatus`, `enrichStatus`,
`enrichmentId`, `enrichedAt`, `addedAt` or `hold`. The enrichment workflow
fills these, and never guess an email. Don't sort, filter-and-save, delete or
rewrite existing rows.

## Step 6: Report back

End with a short summary:

| Company | Added | Already in sheet | Notes |
|---|---|---|---|

Also list companies where you found nobody suitable, and anything odd (for
example, a company whose LinkedIn page didn't match the Companies tab name).

---

## Ground rules

- **Read-only on LinkedIn:** no connection requests, messages, InMails,
  follows, likes, comments or endorsements.
- Browse at a human pace, and stop at `maxProfileViews` profile views.
- If LinkedIn shows a CAPTCHA, a security check, a "you've reached the limit"
  notice or a sign-in prompt, **stop and ask me**. Don't try to get around it.
- If the sheet's columns don't match the names above, stop and tell me
  instead of guessing.

## What happens after you finish

Within 15 minutes the **Outreach - Contact Enrichment** workflow gives each
new row a `recruiterId`, looks up their email with FullEnrich, and fills in
the details. From then on the daily outreach run can include them when their
company has a matching job.
