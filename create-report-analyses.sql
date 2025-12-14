-- Create the missing report_analyses table
-- Run this first, then run the permissions fix

CREATE TABLE IF NOT EXISTS public.report_analyses (
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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_report_analyses_user_id ON report_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_report_analyses_processed_at ON report_analyses(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_analyses_file_path ON report_analyses(file_path);

-- Enable RLS
ALTER TABLE public.report_analyses ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own report analyses" ON report_analyses
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own report analyses" ON report_analyses
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can manage all report analyses" ON report_analyses
  FOR ALL USING (auth.role() = 'service_role');