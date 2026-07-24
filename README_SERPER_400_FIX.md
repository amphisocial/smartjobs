# SmartJobs Serper HTTP 400 hotfix

This hotfix:

- strips one accidental matching quote pair around API keys loaded from PM2 or `.env`;
- sends Serper's minimal request payload (`{"q":"..."}`);
- captures Serper's response body and shows a safe, redacted error message in the existing Search Connection UI;
- does not change the database schema.

## Apply

Copy the ZIP contents over the SmartJobs repository root, then:

```bash
npm test --if-present
node --check config.js
node --check lib/job-search-engine.js
pm2 restart smartjobs --update-env
npm run search:test
```

The result should now either use Serper successfully or show the actual reason, such as `Not enough credits` or `Invalid API key`.
