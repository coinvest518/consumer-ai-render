-- Grant service_role access to new tables for AI agent
GRANT ALL ON disputes TO service_role;
GRANT ALL ON certified_mail TO service_role;
GRANT ALL ON complaints TO service_role;
GRANT ALL ON calendar_events TO service_role;

-- Grant access to new automation tables
GRANT ALL ON user_preferences TO service_role;
GRANT ALL ON email_logs TO service_role;
GRANT ALL ON automation_queue TO service_role;

-- Grant usage on sequences and functions
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION get_pending_reminders TO service_role;
GRANT EXECUTE ON FUNCTION mark_reminder_sent TO service_role;
GRANT EXECUTE ON FUNCTION log_email_sent TO service_role;