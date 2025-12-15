const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const schemaPath = path.join(__dirname, '..', 'schemas', 'analysis.schema.json');
let schema = null;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
} catch (err) {
  console.error('Failed to load analysis schema for AJV:', err.message);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let validateFn = null;
if (schema) validateFn = ajv.compile(schema);

function validate(analysis) {
  if (!validateFn) return { valid: false, errors: ['Schema not loaded'] };
  const valid = validateFn(analysis);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
  return { valid: false, errors };
}

module.exports = { validate };
