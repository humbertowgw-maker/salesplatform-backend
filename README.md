# White Glove Wireless — Backend API
## Step-by-Step Deployment Guide

---

## STEP 1 — Set Up Supabase (Your Database)

1. Go to **supabase.com** → Create a free account
2. Click **"New Project"**
   - Name: `white-glove-wireless`
   - Database password: save this somewhere safe
   - Region: `US West (Oregon)` — closest to Seattle
3. Wait ~2 minutes for it to spin up
4. Go to **SQL Editor** (left sidebar) → **New Query**
5. Copy the entire contents of `db/schema.sql` → Paste → Click **Run**
6. You should see: "Success. No rows returned"
7. Go to **Settings → API**:
   - Copy **Project URL** → this is your `SUPABASE_URL`
   - Copy **service_role (secret)** key → this is your `SUPABASE_SERVICE_KEY`

---

## STEP 2 — Get Your API Keys

### Bland.ai (AI Voice Calls)
1. Go to **app.bland.ai** → Sign up
2. Settings → API Keys → Create key
3. Copy key → this is `BLAND_API_KEY`
4. Pricing: ~$0.09/min per call

### Google Places (Business Search)
1. Go to **console.cloud.google.com**
2. Create new project → Name: "White Glove Wireless"
3. APIs & Services → Enable APIs → Search "Places API" → Enable
4. Credentials → Create Credentials → API Key
5. Copy key → this is `GOOGLE_PLACES_API_KEY`
6. Pricing: ~$17 per 1,000 searches (free $200 credit monthly)

### Apollo.io (Lead Enrichment)
1. Go to **app.apollo.io** → Sign up (free tier: 50 contacts/mo)
2. Settings → Integrations → API → Create API Key
3. Copy key → this is `APOLLO_API_KEY`
4. Paid plan: $49/mo for real volume

### Twilio (SMS)
1. Go to **console.twilio.com** → Sign up
2. Get a phone number (WA area code: 425 or 206) → ~$1/mo
3. From the dashboard copy:
   - **Account SID** → `TWILIO_ACCOUNT_SID`
   - **Auth Token** → `TWILIO_AUTH_TOKEN`
   - Your phone number → `TWILIO_PHONE_NUMBER`

### Anthropic (AI Intel)
1. Go to **console.anthropic.com** → API Keys → Create
2. Copy key → `ANTHROPIC_API_KEY`

---

## STEP 3 — Deploy to Railway (Recommended)

Railway is the easiest way to deploy — takes about 10 minutes.

1. Go to **railway.app** → Sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Push this backend folder to a GitHub repo first:
   ```bash
   cd white-glove-backend
   git init
   git add .
   git commit -m "Initial backend"
   gh repo create white-glove-backend --private --push --source=.
   ```
4. In Railway: select your `white-glove-backend` repo → Deploy
5. Go to your Railway project → **Variables** tab
6. Add all your environment variables (copy from `.env.example`):
   ```
   SUPABASE_URL          = https://xxxxx.supabase.co
   SUPABASE_SERVICE_KEY  = eyJh...
   BLAND_API_KEY         = sk-...
   GOOGLE_PLACES_API_KEY = AIza...
   APOLLO_API_KEY        = ...
   TWILIO_ACCOUNT_SID    = AC...
   TWILIO_AUTH_TOKEN     = ...
   TWILIO_PHONE_NUMBER   = +14255550000
   ANTHROPIC_API_KEY     = sk-ant-...
   NODE_ENV              = production
   FRONTEND_URL          = https://your-app.vercel.app
   ```
7. Railway auto-detects Node.js and deploys. Your URL will be something like:
   `https://white-glove-backend-production.railway.app`
8. Copy this URL → set it as `WEBHOOK_BASE_URL` in Railway variables
9. Test: visit `https://your-url.railway.app/health` — should return `{"status":"ok"}`

---

## STEP 4 — Wire Up Twilio Webhook

So inbound texts route to your AI:
1. Twilio Console → Phone Numbers → your number → Messaging
2. Set **"A message comes in"** → Webhook → **POST**
3. URL: `https://your-backend.railway.app/api/texts/inbound`
4. Save

---

## STEP 5 — Connect Frontend to Backend

In your React dashboard, replace mock data with real API calls:

```javascript
const API = "https://your-backend.railway.app";

// Search businesses
const results = await fetch(`${API}/api/businesses/search`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keyword: "restaurant", city: "Everett" }),
}).then(r => r.json());

// Trigger AI call
await fetch(`${API}/api/calls/trigger`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lead_id: "uuid-here" }),
});

// FCC lookup
const fcc = await fetch(`${API}/api/fcc/lookup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ street: "1402 Colby Ave", city: "Everett", zip: "98201" }),
}).then(r => r.json());
```

---

## STEP 6 — Deploy Frontend to Vercel

```bash
cd white-glove-dashboard
npm install
npm run build
npx vercel --prod
```

Or drag your build folder to **vercel.com/new** → instant deploy.

---

## API REFERENCE

| Method | Endpoint                    | What it does                          |
|--------|-----------------------------|---------------------------------------|
| GET    | /health                     | Server health check                   |
| POST   | /api/businesses/search      | Google Places search + Apollo enrich  |
| POST   | /api/fcc/lookup             | FCC broadband lookup + AI intel       |
| GET    | /api/leads                  | Get all leads                         |
| POST   | /api/leads                  | Create a lead                         |
| POST   | /api/leads/bulk             | Import multiple leads                 |
| PATCH  | /api/leads/:id              | Update lead status/rep/notes          |
| GET    | /api/appointments           | Get all appointments                  |
| POST   | /api/appointments           | Book appointment (checks conflicts)   |
| PATCH  | /api/appointments/:id       | Update appointment                    |
| GET    | /api/reps                   | Get reps with stats                   |
| GET    | /api/reps/:id/calendar      | Rep's appointment calendar            |
| POST   | /api/calls/trigger          | Fire AI call via Bland.ai             |
| POST   | /api/calls/bulk-trigger     | Queue up to 25 calls                  |
| GET    | /api/calls/logs             | Call history                          |
| POST   | /api/texts/send             | Send outbound SMS                     |
| GET    | /api/texts/logs             | Text history                          |
| POST   | /api/webhooks/bland         | Bland.ai call result receiver         |
| POST   | /api/texts/inbound          | Twilio inbound SMS receiver           |
| POST   | /api/intel/prioritize       | AI-score a list of leads              |
| POST   | /api/intel/script           | Generate custom call script           |

---

## ESTIMATED COSTS (at launch scale)

| Service        | Cost                           |
|----------------|--------------------------------|
| Railway        | Free → $5/mo (Hobby)          |
| Supabase       | Free up to 500MB               |
| Bland.ai       | ~$0.09/min · 100 calls = ~$18 |
| Google Places  | Free ($200 credit/mo)          |
| Apollo.io      | $49/mo (paid) or free (50/mo) |
| Twilio         | ~$1/mo number + $0.0079/text  |
| Anthropic      | ~$3 per million tokens         |
| **Total**      | **~$70–100/mo at real volume** |
