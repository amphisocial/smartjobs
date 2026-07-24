# SmartJobs unified Candidate / Recruiter UI

Built for `amphisocial/smartjobs` main after commit `f638b63c9ec40d71f9b24463c8aceeb17c90c07f`.

## What changes

- Adds `/app.html` as the only Google login entry point.
- Uses the existing `/api/recruiter/auth/google` endpoint and the existing SmartJobs Google session.
- Adds a Candidate / Recruiter switch in the top-right.
- Candidate navigation: Overview, Job Toolkit, Search Agents, Applications, Interview Prep.
- Recruiter navigation: Overview, Hiring Workspace, Jobs, Candidates, Interviews.
- Redirects unauthenticated visits to `candidate.html`, `hr.html`, and `job-agent.html` to `/app.html`.
- Redirects authenticated visits to the public homepage back into the role-aware application dashboard.
- Replaces role-tool page navigation with one shared application shell.
- Keeps all existing candidate, recruiter, search-agent, billing, Stripe, PostgreSQL, and AI logic unchanged.

## Apply

```bash
unzip smartjobs-unified-role-ui.zip -d /tmp/smartjobs-unified-role-ui
cd /path/to/smartjobs
bash /tmp/smartjobs-unified-role-ui/apply.sh .

node --check public/smartjobs-auth-guard.js
node --check public/smartjobs-entry-redirect.js
node --check public/smartjobs-shell.js
node --check public/smartjobs-app.js

git add public
# apply.sh only modifies files under public/
git commit -m "Unify candidate and recruiter navigation"
git push
```

## Deploy

```bash
cd /opt/apps/smartjobs
git pull
pm2 restart smartjobs --update-env
```

No database migration and no npm package installation are required.

## Google OAuth

The feature reuses the existing `GOOGLE_CLIENT_ID` and `AUTH_SESSION_SECRET`. Ensure the deployed domain is included in the Google OAuth client's Authorized JavaScript origins.

## Rollback

Revert the commit. The new files are isolated under `public/`, and the apply script only injects asset references into the three tool pages and the public index.
