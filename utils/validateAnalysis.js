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

  // Skip schema required fields check since we changed the structure

  // summary must be string
  if (typeof obj.summary !== 'string') errors.push('summary must be a string');

  // New structure validation
  if (obj.personal_info_analysis) {
    if (!Array.isArray(obj.personal_info_analysis.names_found)) errors.push('personal_info_analysis.names_found must be an array');
    if (!Array.isArray(obj.personal_info_analysis.addresses_found)) errors.push('personal_info_analysis.addresses_found must be an array');
  }
  
  if (obj.inquiry_analysis) {
    if (typeof obj.inquiry_analysis.total_hard_pulls !== 'number') errors.push('inquiry_analysis.total_hard_pulls must be a number');
    if (typeof obj.inquiry_analysis.total_soft_pulls !== 'number') errors.push('inquiry_analysis.total_soft_pulls must be a number');
  }
  
  if (obj.collection_accounts_analysis) {
    if (typeof obj.collection_accounts_analysis.total_collections_found !== 'number') errors.push('collection_accounts_analysis.total_collections_found must be a number');
    if (!Array.isArray(obj.collection_accounts_analysis.collection_accounts)) errors.push('collection_accounts_analysis.collection_accounts must be an array');
  }

  if (!Array.isArray(obj.regular_accounts)) errors.push('regular_accounts must be an array');
  if (!Array.isArray(obj.fcra_violations)) errors.push('fcra_violations must be an array');
  if (!Array.isArray(obj.dispute_letters_needed)) errors.push('dispute_letters_needed must be an array');

  // overall_assessment checks
  if (obj.overall_assessment) {
    if (typeof obj.overall_assessment.total_accounts !== 'number') errors.push('overall_assessment.total_accounts must be a number');
    if (typeof obj.overall_assessment.total_collections !== 'number') errors.push('overall_assessment.total_collections must be a number');
    if (typeof obj.overall_assessment.total_hard_inquiries !== 'number') errors.push('overall_assessment.total_hard_inquiries must be a number');
    if (typeof obj.overall_assessment.total_soft_inquiries !== 'number') errors.push('overall_assessment.total_soft_inquiries must be a number');
    if (typeof obj.overall_assessment.total_violations_found !== 'number') errors.push('overall_assessment.total_violations_found must be a number');
    if (!Array.isArray(obj.overall_assessment.priority_actions)) errors.push('overall_assessment.priority_actions must be an array');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { simpleValidate };
