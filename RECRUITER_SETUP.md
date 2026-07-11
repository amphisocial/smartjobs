# SmartJobs Recruiter Workspace — EC2 Setup

This release is designed for the existing installation:

- Application directory: `/opt/apps/smartjobs`
- PM2 process name: `smartjobs`
- Existing Node/Express application and member-code authentication remain in place.
- Existing OpenAI/Gemini provider configuration is reused.
- The existing `pg` dependency in `package.json` is sufficient; no new npm package is required.

## What this release changes

Replace/add these files in the SmartJobs application root:

```text
server.js
lib/recruiter-routes.js
lib/recruiter-store.js
lib/recruiter-prompts.js
public/hr.html
public/recruiter.js
public/recruiter.css
db/recruiter_schema.sql
skills/job-designer.md
skills/recruiter-interviewer.md
```

The recruiter workspace uses the current active SmartJobs member code as its login identity. The raw token is not stored in recruiter tables; a one-way SHA-256-derived recruiter key isolates each recruiter's records.

## 1. Back up the current application

```bash
cd /opt/apps
sudo cp -a smartjobs "smartjobs.backup.$(date +%Y%m%d-%H%M%S)"
```

## 2. Copy the release files

Upload and unzip `smartjobs-recruiter-workspace.zip`, then copy its contents over the current application:

```bash
cd /opt/apps/smartjobs
sudo cp -a /path/to/unzipped/smartjobs_recruiter_release/. /opt/apps/smartjobs/
sudo chown -R $(stat -c '%U:%G' /opt/apps/smartjobs) /opt/apps/smartjobs
```

Do not delete the existing files that are not included in this release. This ZIP contains complete replacement versions of every changed file, not a Python patch script.

## 3. Configure PostgreSQL

Use an existing PostgreSQL database or create one. Set these variables in the same environment source currently used by the PM2 `smartjobs` process:

```bash
DATABASE_URL=postgresql://smartjobs:STRONG_PASSWORD@127.0.0.1:5432/smartjobs
PGSSL=false
```

For a managed PostgreSQL service that requires TLS, set:

```bash
PGSSL=true
```

### Optional local PostgreSQL creation example

Run only if PostgreSQL is installed locally and you need a new database/user:

```bash
sudo -u postgres psql
```

Then execute, using your own strong password:

```sql
CREATE USER smartjobs WITH PASSWORD 'STRONG_PASSWORD';
CREATE DATABASE smartjobs OWNER smartjobs;
GRANT ALL PRIVILEGES ON DATABASE smartjobs TO smartjobs;
\q
```

## 4. Install the schema

The application automatically runs `db/recruiter_schema.sql` on startup using `CREATE TABLE IF NOT EXISTS`, so it is safe to restart repeatedly.

For an explicit installation/validation before restart:

```bash
cd /opt/apps/smartjobs
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/recruiter_schema.sql
```

Expected tables:

```text
recruiter_jobs
recruiter_candidates
recruiter_job_candidates
recruiter_candidate_rankings
recruiter_job_builder_sessions
recruiter_job_builder_messages
recruiter_interview_sessions
recruiter_interview_turns
```

## 5. Restart the existing PM2 service

If your variables are loaded from `/opt/apps/smartjobs/.env`, export them before the restart because this project does not currently use the `dotenv` package:

```bash
cd /opt/apps/smartjobs
set -a
source .env
set +a
pm2 restart smartjobs --update-env
pm2 save
```

If PM2 uses an ecosystem file, add `DATABASE_URL` and `PGSSL` to that file's `env` section and restart with the ecosystem file instead.

## 6. Validate

```bash
pm2 logs smartjobs --lines 100
curl -s https://smartjobs.athenabot.ai/healthz
```

The log should include:

```text
[store] Postgres ready.
[recruiter-store] Postgres schema ready.
```

Open:

```text
https://smartjobs.athenabot.ai/hr.html
```

Use an active member code, then test:

1. **New Job** — paste a JD, import a public link, paste LinkedIn content, or use AI Help.
2. **Manage Jobs** — open the saved job, edit status/details, add candidates, and rank unranked candidates.
3. Refresh the browser and confirm jobs, candidates, rankings, and reasoning remain available without another AI ranking call.
4. **Interview** — filter by job/candidate, start a role-play, ask recruiter questions, and finish for a stored coaching assessment.

## LinkedIn behavior

The importer first attempts server-side retrieval with SSRF protection. LinkedIn frequently returns a login wall or JavaScript-only page to server requests. The UI therefore includes a LinkedIn content field; pasting the visible job/profile text provides a reliable supported path and still runs the same AI structuring workflow.

## Ranking cache behavior

A ranking remains current while both are unchanged:

- the job's `row_version`
- the candidate resume's SHA-256 hash

Editing a job marks prior rankings **stale**. Candidates with no ranking are **unranked**. “Rank unranked candidates” calls AI only for unranked or stale records; current rankings and full reasoning are read from PostgreSQL.

## Rollback

```bash
pm2 stop smartjobs
sudo mv /opt/apps/smartjobs /opt/apps/smartjobs.failed
sudo mv /opt/apps/smartjobs.backup.YYYYMMDD-HHMMSS /opt/apps/smartjobs
cd /opt/apps/smartjobs
set -a; source .env; set +a
pm2 restart smartjobs --update-env
```

The new recruiter tables are isolated and do not alter the existing `members` or `applications` tables.
