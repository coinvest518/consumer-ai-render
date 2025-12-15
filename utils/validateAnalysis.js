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

  // summary must be string
  if (typeof obj.summary !== 'string') errors.push('summary must be a string');

  // Array checks for all the new fields
  if (!Array.isArray(obj.personal_info_issues)) errors.push('personal_info_issues must be an array');
  if (!Array.isArray(obj.account_issues)) errors.push('account_issues must be an array');
  if (!Array.isArray(obj.collection_accounts)) errors.push('collection_accounts must be an array');
  if (!Array.isArray(obj.inquiries)) errors.push('inquiries must be an array');
  if (!Array.isArray(obj.fcra_violations)) errors.push('fcra_violations must be an array');
  if (!Array.isArray(obj.dispute_letters_needed)) errors.push('dispute_letters_needed must be an array');

  // overall_assessment checks
  if (obj.overall_assessment) {
    if (typeof obj.overall_assessment.total_accounts_affected !== 'number') errors.push('overall_assessment.total_accounts_affected must be a number');
    if (typeof obj.overall_assessment.total_violations_found !== 'number') errors.push('overall_assessment.total_violations_found must be a number');
    if (!Array.isArray(obj.overall_assessment.priority_actions)) errors.push('overall_assessment.priority_actions must be an array');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { simpleValidate };
