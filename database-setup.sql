-- ConsumerAI Database Schema
-- Full SQL dump for recreating all tables, indexes, and policies
-- Run this in Supabase SQL Editor to restore the database

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- AUTH TABLES (created by Supabase Auth - included for reference)
-- ============================================================================

-- Note: These are created automatically by Supabase Auth
-- profiles table (extends auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  is_pro BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- CHAT SYSTEM TABLES
-- ============================================================================

-- Chat history table
CREATE TABLE IF NOT EXISTS chat_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for chat_history
CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_session_id ON chat_history(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at);

-- ============================================================================
-- USER METRICS TABLES
-- ============================================================================

-- User metrics table for tracking usage
CREATE TABLE IF NOT EXISTS user_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chats_used INTEGER DEFAULT 0,
  daily_limit INTEGER DEFAULT 50,
  last_reset TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_metrics UNIQUE (user_id)
);

-- ============================================================================
-- STORAGE SYSTEM TABLES
-- ============================================================================

-- Storage limits table
CREATE TABLE IF NOT EXISTS storage_limits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  max_storage_bytes BIGINT NOT NULL DEFAULT 104857600, -- 100MB default
  max_files INTEGER NOT NULL DEFAULT 50,
  is_premium BOOLEAN NOT NULL DEFAULT false,
  tier_name VARCHAR(50) DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_storage_limits UNIQUE (user_id)
);

-- Storage usage table
CREATE TABLE IF NOT EXISTS storage_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_type TEXT NOT NULL,
  storage_bucket TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT unique_file_path UNIQUE (user_id, file_path)
);

-- Storage transactions table
CREATE TABLE IF NOT EXISTS storage_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  storage_added_bytes BIGINT NOT NULL,
  files_added INTEGER NOT NULL,
  stripe_session_id TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================================================
-- PAYMENT AND CREDITS TABLES
-- ============================================================================

-- Purchases table
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User credits table
CREATE TABLE IF NOT EXISTS user_credits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_credits UNIQUE (user_id)
);

-- ============================================================================
-- DOCUMENT ANALYSIS TABLES
-- ============================================================================

-- Report analyses table
CREATE TABLE IF NOT EXISTS report_analyses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_name TEXT,
    extracted_text TEXT,
    analysis JSONB,
    violations_found BOOLEAN DEFAULT false,
    errors_found BOOLEAN DEFAULT false,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Storage indexes
CREATE INDEX IF NOT EXISTS idx_storage_limits_user_id ON storage_limits(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_usage_user_id ON storage_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_usage_created_at ON storage_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_storage_transactions_user_id ON storage_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_transactions_status ON storage_transactions(status);

-- Payment indexes
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_created_at ON purchases(created_at);
CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id);

-- Report analysis indexes
CREATE INDEX IF NOT EXISTS idx_report_analyses_user_id ON report_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_report_analyses_processed_at ON report_analyses(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_analyses_file_path ON report_analyses(file_path);

-- ============================================================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_analyses ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- Chat history policies (server-side operations)
CREATE POLICY "Service role can insert chat messages" ON chat_history
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role' OR auth.uid() = user_id);

CREATE POLICY "Service role can view all chat history, users can view their own" ON chat_history
  FOR SELECT
  USING (auth.role() = 'service_role' OR auth.uid() = user_id);

CREATE POLICY "Service role can update chat messages" ON chat_history
  FOR UPDATE
  USING (auth.role() = 'service_role' OR auth.uid() = user_id);

CREATE POLICY "Service role can delete chat messages" ON chat_history
  FOR DELETE
  USING (auth.role() = 'service_role' OR auth.uid() = user_id);

-- User metrics policies
CREATE POLICY "Users can view their own metrics" ON user_metrics
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own metrics" ON user_metrics
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own metrics" ON user_metrics
  FOR UPDATE USING (auth.uid() = user_id);

-- Storage policies
CREATE POLICY "Users can view their own storage limits" ON storage_limits
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own storage usage" ON storage_usage
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own storage usage" ON storage_usage
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own storage transactions" ON storage_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Payment policies
CREATE POLICY "Users can view their own purchases" ON purchases
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own purchases" ON purchases
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own credits" ON user_credits
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own credits" ON user_credits
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own credits" ON user_credits
  FOR UPDATE USING (auth.uid() = user_id);

-- Report analyses policies
CREATE POLICY "Users can view their own report analyses" ON report_analyses
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own report analyses" ON report_analyses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can manage all report analyses" ON report_analyses
  FOR ALL USING (auth.role() = 'service_role');

-- ============================================================================
-- STORAGE OBJECT POLICIES
-- ============================================================================

-- Enable RLS on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS users_select_own_files ON storage.objects;
DROP POLICY IF EXISTS users_manage_own_files ON storage.objects;

-- Storage policies for user files
CREATE POLICY users_select_own_files
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id IN ('credit-reports','users-file-storage','uploads','documents') AND split_part(name, '/', 1) = auth.uid()::text);

CREATE POLICY users_manage_own_files
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (bucket_id IN ('credit-reports','users-file-storage','uploads','documents') AND split_part(name, '/', 1) = auth.uid()::text)
  WITH CHECK (bucket_id IN ('credit-reports','users-file-storage','uploads','documents') AND split_part(name, '/', 1) = auth.uid()::text);

-- Service role can access all files
CREATE POLICY service_role_access_all_files
  ON storage.objects
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Add triggers for updated_at
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_storage_limits_updated_at BEFORE UPDATE ON storage_limits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_purchases_updated_at BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_metrics_updated_at BEFORE UPDATE ON user_metrics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- INITIAL DATA (Optional)
-- ============================================================================

-- Insert default storage limits for existing users (run after users exist)
-- This can be done via a migration or manually

-- Example: Insert default user_metrics for existing users
-- INSERT INTO user_metrics (user_id, chats_used, daily_limit)
-- SELECT id, 0, 50 FROM auth.users
-- ON CONFLICT (user_id) DO NOTHING;

-- Example: Insert default storage_limits for existing users
-- INSERT INTO storage_limits (user_id, max_storage_bytes, max_files, tier_name)
-- SELECT id, 104857600, 50, 'free' FROM auth.users
-- ON CONFLICT (user_id) DO NOTHING;