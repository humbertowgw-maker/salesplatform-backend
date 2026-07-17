# White-Label AI Sales Platform — Backend

Multi-tenant Node.js API for a configurable sales, workforce, calling, hiring, and business-operations platform.

**Live frontend:** [salesplatform-frontend.vercel.app](https://salesplatform-frontend.vercel.app)

## What it demonstrates

- Organization-scoped data access and tenant configuration
- Industry presets, branding, feature flags, and modular application setup
- Lead management, prioritization, scoring, appointments, and field routes
- AI-assisted call scripts, call queues, voice-provider pathways, and outcome tracking
- SMS workflows with inbound signature validation
- Hiring pipelines, screening, offer letters, onboarding, and employee goals
- Stripe billing, usage metering, and trial controls
- Google Calendar integration
- AI agents, suggestions, audit records, and approval-oriented director workflows
- Document and image analysis

## Architecture

- **Runtime:** Node.js 20+
- **API:** Express
- **Database and auth:** Supabase/PostgreSQL
- **Billing:** Stripe
- **Communications:** Twilio and configurable voice-provider integrations
- **Calendar:** Google APIs
- **Realtime:** WebSockets

Tenant context is resolved through shared authentication and organization middleware before protected API routes execute. Public signup and provider webhooks use deliberately separate routes.

## Main API areas

```text
/api/organizations   Tenant configuration, branding and presets
/api/leads           Lead workflows
/api/calls           Voice-call execution and logs
/api/texts           Outbound and inbound SMS
/api/agents          Agent configuration, queues and suggestions
/api/director        Briefings, goals, tasks and approvals
/api/hiring          Applicant screening, offers and hiring
/api/billing         Checkout, portal, usage and webhooks
/api/automation      Scheduled operational workflows
/api/system          Health and system reporting
```

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

The application requires project-specific Supabase credentials and only the integrations being exercised locally. Never commit live credentials.

## Database

The `db/` directory contains the base schema and additive migrations for tenant configuration, agents, hiring, language profiles, feature phases, and timezone-aware calling.

## Related project

The React frontend is maintained in the separate `salesplatform-frontend` repository.
