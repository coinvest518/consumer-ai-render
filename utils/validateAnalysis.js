const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'schemas', 'analysis.schema.json');
let schema = null;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
} catch (err) {
  console.error('Failed to load analysis schema:', err.message);
}

function simpleValidate(obj) {
  const errors = [];
  if (!schema) return { valid: false, errors: ['Schema not loaded'] };

  // Basic required top-level fields check
  for (const key of (schema.required || [])) {
    if (!(key in obj)) errors.push(`Missing top-level field: ${key}`);
  }

  // summary checks
  if (obj.summary) {
    if (!obj.summary.headline) errors.push('summary.headline is required');
    if (!obj.summary.score) errors.push('summary.score is required');
  }

  // violations must be array
  if (!Array.isArray(obj.violations)) errors.push('violations must be an array');
  if (!Array.isArray(obj.errors)) errors.push('errors must be an array');
  if (!Array.isArray(obj.actions)) errors.push('actions must be an array');

  return { valid: errors.length === 0, errors };
}

module.exports = { simpleValidate };
