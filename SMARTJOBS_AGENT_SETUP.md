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
- Public-web discovery with optional Serper or Brave Search support and a no-key Bing RSS fallback.
- Employer/ATS-page verification before a result is retained.
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
JOB_AGENT_MAX_QUERIES=36
JOB_AGENT_MAX_DISCOVERED=100
JOB_AGENT_VERIFY_CONCURRENCY=5
JOB_AGENT_SEARCH_TIMEOUT_MS=15000

# Search discovery
# auto prefers Serper, then Brave, then the no-key Bing RSS fallback.
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

Bing RSS enables a working no-key setup. For heavier production use, Serper or Brave is recommended because public search HTML/RSS availability can change independently of SmartJobs.

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
  db/job_agent_schema.sql scripts/init-job-agent-db.js \
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
- Discovery results are discarded unless the final page is an official ATS host or a plausible employer careers/jobs URL.
- Known aggregators are not accepted as proof that a posting is open.
- The scheduler uses a PostgreSQL advisory lock, so multiple PM2 workers do not run the same scheduling batch concurrently.
- Interrupted runs older than two hours are marked failed during startup.
- Search and verification errors are stored in `job_agent_runs.error_messages` and shown through run status; detailed errors also appear in PM2 logs.
