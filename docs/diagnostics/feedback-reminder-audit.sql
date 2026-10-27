-- Read-only. Run against the published application's production database.
-- Change 'Reena' in BOTH queries when inspecting a different POC.
-- Times below are shown in India time. No phone numbers, email addresses or
-- webhook URLs/secrets are selected.

SELECT
  fs.id AS session_id,
  cp.name AS poc,
  p.name AS project,
  fc.id AS cycle_id,
  fc.cycle_type,
  fc.started_at AT TIME ZONE 'Asia/Kolkata' AS cycle_started_ist,
  fc.status AS cycle_status,
  p.automatic_feedback_enabled,
  fs.status AS session_status,
  fs.completion_status,
  fs.reminder_count,
  fs.reminder_due_at AT TIME ZONE 'Asia/Kolkata' AS next_reminder_ist,
  fs.last_client_response_at AT TIME ZONE 'Asia/Kolkata' AS last_reply_ist,
  fs.conversation_state->>'state' AS conversation_state,
  fs.conversation_state->>'pendingQuestionType' AS pending_question,
  fs.conversation_state->>'overallRating' AS stated_csat,
  fs.conversation_state->>'npsScore' AS stated_nps,
  fs.conversation_state->>'idleRatingPromptAttemptedAt' AS idle_rating_attempt,
  fs.conversation_state->'ratingFeedbackPause' AS rating_feedback_pause,
  fs.conversation_state->>'reminderExhausted' AS reminders_exhausted,
  fs.conversation_state->>'closureReason' AS closure_reason,
  fs.conversation_state->>'closingGraceExpiresAt' AS closing_window_deadline
FROM feedback_sessions fs
JOIN client_pocs cp ON cp.id = fs.client_poc_id
JOIN projects p ON p.id = fs.project_id
JOIN feedback_cycles fc ON fc.id = fs.cycle_id
WHERE cp.name ILIKE '%Reena%'
  AND fc.cycle_type = 'project_end'
ORDER BY fs.started_at DESC
LIMIT 10;

SELECT
  fs.id AS session_id,
  cp.name AS poc,
  p.name AS project,
  ae.event_type,
  ae.status,
  ae.status_code,
  ae.webhook_url_configured,
  ae.error,
  ae.payload->>'reminderCount' AS reminder_number,
  ae.created_at AT TIME ZONE 'Asia/Kolkata' AS event_time_ist
FROM feedback_sessions fs
JOIN client_pocs cp ON cp.id = fs.client_poc_id
JOIN projects p ON p.id = fs.project_id
JOIN feedback_cycles fc ON fc.id = fs.cycle_id
JOIN automation_events ae ON (
  ae.payload->>'sessionId' = fs.id::text
  OR ae.payload->'session'->>'id' = fs.id::text
)
WHERE cp.name ILIKE '%Reena%'
  AND fc.cycle_type = 'project_end'
  AND ae.event_type IN ('no_response', 'one_hour_rating_prompt', 'feedback_session_closed', 'six_hour_final_response_completion')
ORDER BY ae.created_at DESC
LIMIT 40;
