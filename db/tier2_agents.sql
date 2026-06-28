-- Tier 2 agents INSERT — run in Supabase SQL editor to make them appear in AgentBuilder
-- Safe to re-run (ON CONFLICT DO NOTHING)

INSERT INTO agent_registry (name, slug, description, category, status, config)
VALUES
  (
    'Appointment Confirmation',
    'appt-confirmation',
    'Sends SMS confirmation to leads 24 hours before their appointment. Reduces no-show rates by 40%.',
    'automation',
    'active',
    '{"sms_hours_before": 24, "reminder_message_template": "Hi {owner_name}! Confirming your appointment with {rep_name} tomorrow at {time}. Reply YES to confirm or RESCHEDULE to pick a new time."}'
  ),
  (
    'SMS Follow-Up',
    'sms-followup',
    'Sends follow-up SMS to leads that were called but did not answer or went to voicemail. Re-engages cold leads.',
    'outreach',
    'active',
    '{"days_after_voicemail": 1, "max_followups": 3, "message_template": "Hi {owner_name}, I tried reaching you earlier about {service}. Would love to connect when you have a moment!"}'
  ),
  (
    'Review Request',
    'review-request',
    'After an appointment is marked Confirmed + completed, sends a Google review request to the business owner via SMS.',
    'automation',
    'active',
    '{"days_after_appt": 2, "review_url": "", "message_template": "Hi {owner_name}! Thank you for meeting with us. If you had a great experience, we''d appreciate a review: {review_url}"}'
  )
ON CONFLICT (slug) DO NOTHING;
