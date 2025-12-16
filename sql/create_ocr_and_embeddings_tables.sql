-- Enable pgvector extension if available (Supabase supports pgvector)
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store full OCR artifacts for documents (page layout, text, coords)
CREATE TABLE IF NOT EXISTS ocr_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_path text NOT NULL,
  file_name text,
  ocr_pages jsonb,
  created_at timestamptz DEFAULT now()
);

-- Table to store labeled samples and embeddings for a simple K-NN classifier
-- Using jsonb for embeddings keeps compatibility with different providers and fallback vectors
CREATE TABLE IF NOT EXISTS document_embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  file_path text,
  label text NOT NULL,
  embedding jsonb,
  created_at timestamptz DEFAULT now()
);

-- NOTE: If you want to use pgvector/ivfflat for production nearest-neighbor, add a separate
-- pgvector column (e.g., embedding_vector vector(1536)) and populate it when embeddings match
-- the expected dimension. The current jsonb column avoids schema mismatch during prototyping.

-- Small convenience: table for storing human-labeled examples (text snippet)
CREATE TABLE IF NOT EXISTS document_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  label text NOT NULL,
  snippet text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- Grant limited privileges (adjust roles as needed)
-- GRANT SELECT, INSERT ON ocr_artifacts TO anon, authenticated;
-- GRANT SELECT, INSERT ON document_embeddings TO authenticated;
