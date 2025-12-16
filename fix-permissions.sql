-- Grant service_role access to new tables for AI agent
GRANT ALL ON disputes TO service_role;
GRANT ALL ON certified_mail TO service_role;
GRANT ALL ON complaints TO service_role;
GRANT ALL ON calendar_events TO service_role;

-- Grant usage on sequences if they exist
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;