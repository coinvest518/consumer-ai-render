-- Fix Supabase permissions for service role
-- Run this in Supabase SQL Editor after the main schema

-- Grant permissions to all tables for service_role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Also grant to authenticated and anon roles for completeness
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO service_role;

-- Specific grants for our tables (in case the above doesn't work)
GRANT ALL ON TABLE public.profiles TO service_role;
GRANT ALL ON TABLE public.chat_history TO service_role;
GRANT ALL ON TABLE public.user_metrics TO service_role;
GRANT ALL ON TABLE public.storage_limits TO service_role;
GRANT ALL ON TABLE public.storage_usage TO service_role;
GRANT ALL ON TABLE public.storage_transactions TO service_role;
GRANT ALL ON TABLE public.purchases TO service_role;
GRANT ALL ON TABLE public.user_credits TO service_role;
GRANT ALL ON TABLE public.report_analyses TO service_role;

-- Grant to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chat_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_metrics TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_limits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_usage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.purchases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_credits TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.report_analyses TO authenticated;