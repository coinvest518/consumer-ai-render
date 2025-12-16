-- Add ocr_artifact_id to report_analyses and index
ALTER TABLE IF EXISTS report_analyses
  ADD COLUMN IF NOT EXISTS ocr_artifact_id uuid REFERENCES ocr_artifacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_report_analyses_ocr_artifact_id ON report_analyses(ocr_artifact_id);
