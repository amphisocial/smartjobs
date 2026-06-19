# RoleFit

AI job-fit toolkit. Same Railway + provider-switch architecture as Roastrobe.

## Two sides
**Candidate** (`/candidate.html`): fit score + keyword gaps, ATS-optimized resume PDF, prep plan, text mock interview with feedback.
**Recruiter** (`/hr.html`): rank a stack of resumes against a JD (call/maybe/pass + reasons), and per-candidate screening talking points.

Inputs: paste text, or upload a screenshot (image is OCR'd by the model).

## Provider switch
`AI_PROVIDER=openai` (set `OPENAI_API_KEY`, `OPENAI_MODEL`) or `AI_PROVIDER=gemini` (set `GEMINI_API_KEY`, `GEMINI_MODEL`). One variable, redeploy to switch — identical to Roastrobe.

## Deploy on Railway
1. Push to GitHub.
2. New Project → Deploy from GitHub repo.
3. Variables: `AI_PROVIDER`, the matching key + model.
4. Settings → Networking → Generate Domain.

Runs `npm install` (express + pdfkit) then `npm start`. No database needed.

## Guardrails (built in)
- The resume tool NEVER fabricates experience, skills, or credentials — it only rephrases, reorganizes, and surfaces what's genuinely there; JD keywords the candidate lacks go in a "consider adding if true" list, not the resume.
- HR ranking judges only job-relevant qualifications and is instructed to ignore demographic signals; it's decision-support for a human, not an auto-reject. Every judgement is explained.
- No tool can guarantee passing every ATS; the PDF follows ATS best practices (single column, standard headings, selectable text, JD-aligned keywords).

## Endpoints
Candidate: `/api/fit`, `/api/ats`, `/api/ats-pdf`, `/api/training`, `/api/interview/start|feedback|summary`, `/api/extract` (OCR).
HR: `/api/hr/rank`, `/api/hr/talking-points`.

## Billing (Stripe, test/live switch)
Same model as Roastrobe. Members get unlimited use; everyone else gets `FREE_DAILY_LIMIT` AI runs/day, then a paywall.

- `STRIPE_MODE=test|live` selects which key set is active. Store both `STRIPE_TEST_*` and `STRIPE_LIVE_*` (SECRET_KEY, PRICE_ID, WEBHOOK_SECRET) and flip the mode to switch.
- Add Railway Postgres (sets `DATABASE_URL`) before charging real money — the member store persists there. Without it, an in-memory fallback is used (dev only).
- Register a webhook in Stripe pointing to `https://<your-domain>/webhook/stripe` for events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Do this in BOTH test and live mode (two different signing secrets).
- Multi-device: subscribers get a member code on the success page; "Member code" on either tool page redeems it on another device.
- Default price shown is $4.99/mo (text in index.html + app-billing.js). The real charge is whatever Stripe price you point `STRIPE_*_PRICE_ID` at. Stripe prices are immutable — to change price, create a new price and update the variable.

Which AI runs cost a credit: `/api/fit`, `/api/ats`, `/api/training`, `/api/interview/start`, `/api/hr/rank`. Free follow-ons: OCR, the ATS PDF, interview feedback/summary, HR talking points.

## Inputs: paste / link / file / screenshot
- **Job description:** paste, **🔗 from a link** (`POST /api/fetch-jd` fetches the page server-side, with SSRF guards blocking private/metadata IPs, and the AI extracts the posting), or 📷 screenshot (OCR). Link works for most company/ATS career pages; LinkedIn/Indeed often need a login so paste those.
- **Resume:** paste, **📄 PDF/Word upload** (`POST /api/extract-file` parses .docx via mammoth and .pdf via unpdf to text), or 📷 screenshot. The ATS optimizer treats the uploaded resume as the source of truth and frames its output as additions/updates — it never fabricates experience.
