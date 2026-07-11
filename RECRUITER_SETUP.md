# SmartJobs Recruiter Workspace — Google Sign-In and Configurable Free Limits

Target deployment:

- Application directory: `/opt/apps/smartjobs`
- PM2 process: `smartjobs`
- Site: `https://smartjobs.athenabot.ai`
- Database: PostgreSQL through `DATABASE_URL`

## Behavior in this release

Every recruiter signs in with Google. Google identity owns the recruiter's jobs, candidates, rankings, and interview history.

An active SmartJobs member code is now an **upgrade**, not the recruiter login:

- Google signed-in recruiter without an active member code: free daily limits apply.
- Google signed-in recruiter with an active member code: unlimited recruiter usage.
- A member code without Google sign-in does not open the recruiter workspace.

Default free limits:

- 5 successfully requested new-job creations per day.
- 5 candidate-ranking runs per day.
- 5 new interview-practice sessions per day.

A ranking run means one click on **Rank unranked candidates** or **Re-rank all**. The batch may rank multiple candidates, but it consumes one ranking run. Opening, filtering, viewing, editing, adding candidates, and changing pipeline status do not consume ranking runs. Interview turns and the final assessment do not consume another interview; only starting a new session does.

All three limits are configurable in `.env`.

## 1. Back up the existing application

```bash
cd /opt/apps
sudo cp -a smartjobs "smartjobs.backup.$(date +%Y%m%d-%H%M%S)"
sudo cp /opt/apps/smartjobs/.env "/opt/apps/smartjobs.env.backup.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
```

## 2. Copy the release

Unzip the release and copy all files, including hidden files:

```bash
cd /path/to/unzipped
sudo cp -a smartjobs_recruiter_release_v4/. /opt/apps/smartjobs/
cd /opt/apps/smartjobs
sudo chown -R "$(stat -c '%U:%G' /opt/apps/smartjobs)" /opt/apps/smartjobs
npm install --omit=dev
```

`npm install` installs the added `google-auth-library` and `dotenv` dependencies.

## 3. Configure Google authentication

In Google Cloud Console:

1. Select the Google Cloud project used by SmartJobs.
2. Open **APIs & Services → Credentials**.
3. Create or reuse an **OAuth 2.0 Client ID** of type **Web application**.
4. Add this Authorized JavaScript origin:

```text
https://smartjobs.athenabot.ai
```

No redirect URI is required for this Google Identity Services ID-token callback flow.

If the job-hunter side already uses a Web OAuth client for this same origin, reuse that client ID.

Generate the SmartJobs session-signing secret:

```bash
openssl rand -hex 32
```

Add these values to `/opt/apps/smartjobs/.env`:

```dotenv
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
AUTH_SESSION_SECRET=PASTE_THE_OPENSSL_VALUE
RECRUITER_AUTH_SESSION_DAYS=30
```

`GOOGLE_CLIENT_SECRET` is not needed and should not be added for this implementation.

## 4. Configure recruiter limits

Add or change:

```dotenv
RECRUITER_FREE_JOBS_DAILY=5
RECRUITER_FREE_RANK_RUNS_DAILY=5
RECRUITER_FREE_INTERVIEWS_DAILY=5
```

Changing these values and restarting PM2 changes the limits without a code rebuild.

The existing job-hunter controls remain separate:

```dotenv
FREE_DAILY_LIMIT=3
LIVE_DAILY_LIMIT=2
```

## 5. Confirm PostgreSQL configuration

The recruiter workspace requires:

```dotenv
DATABASE_URL=postgresql://smartjobs:YOUR_PASSWORD@127.0.0.1:5432/smartjobs
PGSSL=false
```

For a managed PostgreSQL service that requires TLS, use its supplied URL and set:

```dotenv
PGSSL=true
```

Protect the environment file:

```bash
sudo chmod 600 /opt/apps/smartjobs/.env
```

## 6. Install or update the schema

The schema is idempotent and now adds:

```text
recruiter_accounts
recruiter_daily_usage
```

along with the existing recruiter job, candidate, ranking, job-builder, and interview tables.

Run:

```bash
cd /opt/apps/smartjobs
npm run db:init
```

Verify the usage table:

```bash
psql "$DATABASE_URL" -c "\d recruiter_daily_usage"
```

## 7. Restart SmartJobs

```bash
cd /opt/apps/smartjobs
pm2 restart smartjobs --update-env
pm2 save
pm2 logs smartjobs --lines 100
```

## 8. Validate configuration

```bash
curl -s https://smartjobs.athenabot.ai/healthz | jq
```

Expected fields include:

```json
{
  "databaseConfigured": true,
  "recruiterDatabaseReady": true,
  "googleAuthConfigured": true,
  "recruiterLimits": {
    "jobs": 5,
    "ranks": 5,
    "interviews": 5
  }
}
```

The public recruiter authentication configuration can also be checked:

```bash
curl -s https://smartjobs.athenabot.ai/api/recruiter/auth/config | jq
```

Only the public OAuth client ID is returned. The session secret is never returned to the browser.

## 9. Functional test

Open:

```text
https://smartjobs.athenabot.ai/hr.html
```

Test this sequence:

1. Sign in with Google without entering a member code.
2. Confirm the page shows three free usage counters.
3. Create a job and confirm the New Jobs counter changes from `0 / 5` to `1 / 5`.
4. Add candidates and click Rank Unranked; confirm the Ranking Runs counter changes once for the entire batch.
5. Start an interview; confirm the Interviews counter changes once.
6. Refresh the browser and confirm Google session, recruiter data, and counters remain.
7. Enter an active member code and perform another recruiter action; the counters should display `Unlimited`.
8. Sign out and sign in again with the same Google account; the same recruiter records should load.

## Existing recruiter-data migration

The earlier recruiter release stored ownership using a hash of the member code. When a Google-signed-in recruiter supplies that same active member code, this release automatically migrates the older recruiter-owned jobs, candidates, job-builder sessions, and interview sessions to the Google identity. The raw member code and Google subject identifier are never stored in recruiter tables.

## Daily usage storage

Usage is stored in PostgreSQL by recruiter identity, date, and action. Restarting PM2 or changing browsers does not reset usage. Paid members bypass the counters but still use Google sign-in to identify their private recruiter workspace.

## Files added or replaced

```text
package.json
config.js
server.js
.env.example
.env.recruiter.example
db/recruiter_schema.sql
lib/google-auth.js
lib/recruiter-routes.js
lib/recruiter-store.js
public/hr.html
public/recruiter-auth.js
public/recruiter.js
public/recruiter.css
scripts/init-recruiter-db.js
```

## Rollback

```bash
pm2 stop smartjobs
sudo mv /opt/apps/smartjobs /opt/apps/smartjobs.failed
sudo mv /opt/apps/smartjobs.backup.YYYYMMDD-HHMMSS /opt/apps/smartjobs
pm2 restart smartjobs --update-env
```
