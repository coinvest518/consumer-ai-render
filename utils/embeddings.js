const crypto = require('crypto');

// Try to compute a high-quality embedding using Mistral embeddings if available; otherwise fall back to a simple hashed vector
async function getEmbedding(text) {
  text = String(text || '').trim();
  if (!text) return null;

  // Prefer Mistral embeddings if key present
  if (process.env.MISTRAL_API_KEY) {
    try {
      const { Mistral } = require('@mistralai/mistralai');
      const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
      const res = await client.embeddings.create({ model: 'mistral-embed', inputs: [text] });
      const emb = res?.data?.[0]?.embedding || res?.data?.embedding;
      if (emb && emb.length) return emb;
    } catch (err) {
      console.warn('Mistral embedding failed:', err.message);
    }
  }

  // Fallback: deterministic hashed n-gram vector (not semantically great but works offline)
  const dims = 256;
  const vec = new Array(dims).fill(0);
  const words = text.split(/\s+/).slice(0, 200);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z0-9]/g, '') || words[i];
    const h = crypto.createHash('sha256').update(w).digest();
    const idx = h.readUInt16BE(0) % dims;
    vec[idx] = vec[idx] + (1 / Math.log(i + 2));
  }
  // normalize
  const norm = Math.sqrt(vec.reduce((s,x)=>s+x*x,0));
  if (norm > 0) for (let i=0;i<vec.length;i++) vec[i]=vec[i]/norm;
  return vec;
}

module.exports = { getEmbedding };
