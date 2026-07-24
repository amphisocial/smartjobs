# SmartJobs Agentic Job Search — installation

This patch was built against the latest `main` commit inspected on July 23, 2026:

`16a85877fbf3356cdbf4f4aa93599a46a9ff9b06` (`linkedin profile import`)

The ZIP contains only new or changed files. Extract it over the root of your local `amphisocial/smartjobs` checkout.

## What is included

- Google-authenticated candidate job-search agents.
- PostgreSQL persistence for applicant profiles, preferences, search plans, schedules, runs, results, and human review statuses.
- AI search-plan generation in this order:
  1. applicant profile and compensation
  2. title families and exclusions
  3. ordered priority cities
  4. states and regions
  5. U.S.-remote roles
- Public-web discovery with provider failover: Serper or Brave when configured, followed by Bing RSS, Bing HTML, and DuckDuckGo HTML fallbacks.
- Employer/ATS-page verification before a result is retained.
- Persisted posting-date and source policy per agent:
  - configurable maximum posting age
  - require, allow-and-flag, or ignore missing official dates
  - use earliest/original date, use latest official date, or exclude detected reposts
  - official employer/ATS source requirement
  - active application verification
  - aggregator discovery clues without accepting aggregators as proof
  - preferred source systems including Workday, ADP, Greenhouse, Lever, SmartRecruiters, SuccessFactors, Oracle, iCIMS, UKG, Dayforce, Jobvite, Ashby, Avature, Eightfold, Phenom, and direct employer pages
- AI fit scoring with mandatory versus preferred qualifications and material gaps.
- Human actions: Apply in a new tab, Approve, Save, Reject, and Mark applied.
- Five manual runs per day for free users.
- Unlimited manual runs and scheduling for active paid members.
- Paid access is linked automatically to the verified Google email through Stripe. Existing member codes remain a fallback, but normal users do not need to enter one.
- PM2-safe scheduler using a PostgreSQL advisory lock.
- Nightly SMTP summaries of new recommended matches.
- Monitoring UI showing schedules, next/last runs, counts, and email readiness.

## Local installation

From the local repository root:

```bash
# Back up any local edits first.
git status

# Extract the ZIP over this repository, preserving folders.
# Then review the changes:
git diff -- . ':!package-lock.json'

# No new npm dependency is required, but installing verifies the existing lockfile.
npm install

# Syntax verification
node --check server.js
node --check lib/job-agent-routes.js
node --check lib/job-agent-service.js
node --check lib/job-agent-store.js
node --check lib/job-search-engine.js
node --check lib/smtp-mailer.js
node --check public/job-agent.js
```

## PostgreSQL setup

### Recommended: dedicated SmartJobs database

Create a dedicated database using your existing PostgreSQL administrator account:

```bash
createdb -h localhost -U postgres smartjobs
```

Then add a URL for the application database user to `.env`:

```dotenv
SMARTJOBS_DATABASE_URL=postgresql://smartjobs_user:password@127.0.0.1:5432/smartjobs
```

The configured user needs permission to connect and create/alter tables in this database.

Initialize the schema:

```bash
npm run db:init-agent
```

### Simpler alternative: use the existing SmartJobs database

Leave `SMARTJOBS_DATABASE_URL` blank. The feature will use `DATABASE_URL` and create only tables prefixed with `job_agent_` or `job_search_`.

The application also initializes the schema safely at startup with `CREATE TABLE IF NOT EXISTS`; the explicit init command is still recommended so database errors are found before PM2 restart.

## Required `.env` settings

Merge these into the existing server `.env`. Do **not** replace existing Stripe, AI, Google, or database values.

```dotenv
# Existing Google sign-in values are reused
GOOGLE_CLIENT_ID=...
AUTH_SESSION_SECRET=...

# Dedicated agent DB, or leave blank to reuse DATABASE_URL
SMARTJOBS_DATABASE_URL=postgresql://...
PGSSL=false

# Agent controls
APP_BASE_URL=https://your-smartjobs-domain.example
JOB_AGENT_FREE_RUNS_DAILY=5
JOB_AGENT_SCHEDULER_ENABLED=true
JOB_AGENT_SCHEDULER_INTERVAL_MINUTES=15
JOB_AGENT_SCHEDULER_BATCH_SIZE=4
JOB_AGENT_MAX_QUERIES=24
JOB_AGENT_MAX_DISCOVERED=100
JOB_AGENT_QUERY_CONCURRENCY=3
JOB_AGENT_VERIFY_CONCURRENCY=5
JOB_AGENT_SEARCH_TIMEOUT_MS=10000

# Search discovery
# auto prefers Serper, then Brave, then Bing RSS/HTML and DuckDuckGo HTML fallbacks.
JOB_AGENT_SEARCH_PROVIDER=auto
SERPER_API_KEY=
BRAVE_SEARCH_API_KEY=
JOB_AGENT_SEARCH_RSS_URL=https://www.bing.com/search

# Nightly email
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_REJECT_UNAUTHORIZED=true
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM=SmartJobs <jobs@yourdomain.com>
SMTP_FROM_ADDRESS=jobs@yourdomain.com
SMTP_HELO_NAME=smartjobs.yourdomain.com
```

The no-key providers are best-effort and may be blocked or changed by the search engines. For production, configure Serper or Brave. The UI now has **Test search connection** and refuses to consume a run when every provider is unavailable or returns zero results.


## Search connection diagnostics

Before running an agent, click **Test search connection**. It runs a broad Boston technology query and reports which provider returned results. The server caches the check for five minutes and performs the same preflight before consuming a free run. You can run the same diagnostic from EC2 with:

```bash
npm run search:test
```

If the check fails, inspect the displayed provider attempts and PM2 logs. Typical causes are:

- no `SERPER_API_KEY` or `BRAVE_SEARCH_API_KEY`, combined with public search providers blocking server traffic
- outbound DNS or HTTPS blocked from the EC2 instance
- a corporate proxy returning HTML instead of RSS/JSON
- an invalid explicit `JOB_AGENT_SEARCH_PROVIDER` setting

Recommended production configuration:

```dotenv
JOB_AGENT_SEARCH_PROVIDER=auto
SERPER_API_KEY=your_serper_key
# or BRAVE_SEARCH_API_KEY=your_brave_key
JOB_AGENT_MAX_QUERIES=24
JOB_AGENT_QUERY_CONCURRENCY=3
JOB_AGENT_SEARCH_TIMEOUT_MS=10000
```

A run now records discovered, verified, skipped, and recommended counts, along with provider attempts and rejection summaries. A true discovery failure is marked **failed** rather than being shown as a successful zero-result run.

## Posting-date and source-policy behavior

These settings are stored in PostgreSQL for each agent and are editable from the **Posting recency and source verification** card.

### Posting date

SmartJobs reads dates only from the official employer/ATS page, including JobPosting JSON-LD, date metadata, and recognized embedded posting fields. Search-engine and aggregator timestamps are retained only as diagnostic discovery data and never become the official posting date.

- **Maximum posting age:** 7, 14, 30, 60, 90 days, or any age.
- **Missing posting date:** require an official date, allow the role but flag the missing date, or ignore posting dates.
- **Reposted roles:** use the earliest detected official date, use the latest official date, or exclude a role when materially different official dates indicate a repost.

The results table stores both the effective `date_posted` and `original_date_posted`, plus the metadata source and a repost flag.

### Official sources and active status

The default source policy requires a direct employer career page or recognized official ATS page. Supported ATS detection includes:

- Workday
- ADP Workforce Now and ADP Recruiting
- Greenhouse
- Lever
- SmartRecruiters
- SAP SuccessFactors
- Oracle Recruiting
- iCIMS
- UKG/UltiPro
- Dayforce
- Jobvite
- Ashby
- Avature
- Eightfold
- Phenom

The verifier follows redirects, rejects known aggregator hosts as proof, rejects closed/expired pages, checks `validThrough` when available, and requires JobPosting/apply evidence when **Verify the page still shows an open application** is enabled.

When **Allow aggregators only as discovery clues** is enabled, SmartJobs may use an aggregator result to formulate an exact title/company search, but it retains a role only after resolving it back to an official employer or ATS page.

## Google OAuth

The feature reuses the existing Google Identity Services setup and `/api/recruiter/auth/google` endpoint. Add the deployed SmartJobs origin to the Google OAuth client's authorized JavaScript origins if it is not already there.

Example:

```text
https://smartjobs.yourdomain.com
```

No Google client secret is required for the current ID-token sign-in flow.

## Stripe access

The agent page has its own Google-aware checkout endpoint. It sends the verified Google email to Stripe and, after checkout, SmartJobs looks up an active/trialing Stripe subscription for that email and binds it to `job_agent_accounts`. Users therefore do not need to copy or re-enter a member code. The current member-code mechanism remains available as a fallback for legacy subscriptions.

No Stripe key changes are required. The customer email entered in Stripe must match the verified Google account email for automatic linking. Free users can save agents and run them five times per day, but automatic scheduling is rejected server-side until the membership is active.

## Deploy through Git

From the local checkout:

```bash
git add .env.example config.js package.json server.js public/index.html \
  public/job-agent.html public/job-agent.css public/job-agent.js \
  db/job_agent_schema.sql scripts/init-job-agent-db.js scripts/test-job-search.js \
  lib/billing.js lib/job-agent-prompts.js lib/job-search-engine.js lib/job-agent-store.js \
  lib/smtp-mailer.js lib/job-agent-service.js lib/job-agent-routes.js \
  SMARTJOBS_AGENT_SETUP.md CHANGED_FILES_AGENT.txt

git commit -m "Add agentic job search monitoring workflow"
git push
```

On the EC2 server:

```bash
cd /opt/apps/smartjobs
git pull
npm install --omit=dev
npm run db:init-agent
pm2 restart smartjobs --update-env
pm2 logs smartjobs --lines 100
```

Use `pm2 list` first if the service name differs.

No Nginx location change is normally required because the new page and `/api/job-agent/*` endpoints use the same Node service and origin.

## Verification

Open:

```text
https://your-smartjobs-domain.example/job-agent.html
```

Then verify:

1. Google sign-in succeeds.
2. Save a test agent without scheduling.
3. Generate the search-plan preview.
4. Run the agent once and watch **Monitoring** until the run completes.
5. Review **Results** and test Apply, Save, Reject, and Mark applied.
6. Confirm free-run usage persists after refresh.
7. With an active paid token, enable a schedule and verify `next_run_at` appears.
8. Check `/healthz` for:
   - `jobAgentDatabaseReady: true`
   - `jobAgentSchedulerEnabled: true`
   - `smtpConfigured: true` when SMTP is present
9. For email testing, temporarily set the agent's digest hour to the current local hour and wait for the next scheduler tick.

## Operational notes

- The process never submits a job application automatically.
- Discovery results are discarded unless they satisfy the saved agent source policy.
- Known aggregators are never accepted as proof that a posting is open; when enabled, they are used only to locate an official page.
- Search-engine timestamps are not treated as official posting dates.
- The selected original/repost policy and maximum age are enforced before fit scoring.
- The scheduler uses a PostgreSQL advisory lock, so multiple PM2 workers do not run the same scheduling batch concurrently.
- Interrupted runs older than two hours are marked failed during startup.
- Search and verification errors are stored in `job_agent_runs.error_messages` and shown through run status; detailed errors also appear in PM2 logs.


## Serper is configured but runs show Bing

The runtime now accepts `SERPER_API_KEY` plus the common aliases `SERPER_KEY`, `SERPER_APIKEY`, `SERPERDEV_API_KEY`, and `JOB_AGENT_SERPER_API_KEY`. It also handles a blank PM2 environment variable that would otherwise shadow a non-empty value in `.env`.

Use strict Serper mode while diagnosing so a 401, 403, or 429 is shown instead of silently falling back:

```dotenv
JOB_AGENT_SEARCH_PROVIDER=serper
JOB_AGENT_SEARCH_ALLOW_FALLBACK=false
SERPER_API_KEY=your_key
```

Restart and inspect the non-secret runtime status:

```bash
pm2 restart smartjobs --update-env
pm2 logs smartjobs --lines 80
node --input-type=module -e "import('./config.js').then(({config}) => console.log({provider:config.jobAgentSearchProvider,serperConfigured:Boolean(config.serperApiKey),serperKeySource:config.serperKeySource,keyLength:config.serperApiKey.length,allowFallback:config.jobAgentSearchAllowFallback}))"
npm run search:test
```

Do not print the key itself. A healthy test reports `serperConfigured: true`, a key source such as `.env:SERPER_API_KEY`, and `provider: "serper"`. A `serper_http_401` or `serper_http_403` means the key is invalid; `serper_http_429` means the Serper account is out of credits or rate limited.
