-- Add doc_type column to report_analyses for storing detected document type
ALTER TABLE IF EXISTS report_analyses
  ADD COLUMN IF NOT EXISTS doc_type text;

CREATE INDEX IF NOT EXISTS idx_report_analyses_doc_type ON report_analyses(doc_type);
