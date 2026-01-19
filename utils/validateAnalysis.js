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
  const warnings = [];
  const errors = [];
  if (!schema) return { valid: false, errors: ['Schema not loaded'], warnings: ['Schema not loaded'] };

  // summary should be string
  if (typeof obj.summary !== 'string') warnings.push('summary should be a string');

  // Accept either personal_info_analysis (new) or personal_info_issues (legacy/current)
  const personal = obj.personal_info_analysis || obj.personal_info_issues || null;
  if (personal) {
    if (!Array.isArray(personal.names_found) && personal.names_found !== undefined) warnings.push('personal_info.names_found should be an array');
    if (!Array.isArray(personal.addresses_found) && personal.addresses_found !== undefined) warnings.push('personal_info.addresses_found should be an array');
  }

  const inquiry = obj.inquiry_analysis || obj.inquiries || null;
  if (inquiry) {
    if (inquiry.total_hard_pulls !== undefined && typeof inquiry.total_hard_pulls !== 'number') warnings.push('inquiry.total_hard_pulls should be a number');
    if (inquiry.total_soft_pulls !== undefined && typeof inquiry.total_soft_pulls !== 'number') warnings.push('inquiry.total_soft_pulls should be a number');
  }

  const collections = obj.collection_accounts_analysis || obj.collection_accounts || null;
  if (collections) {
    if (collections.total_collections_found !== undefined && typeof collections.total_collections_found !== 'number') warnings.push('collection_accounts.total_collections_found should be a number');
    if (collections.collection_accounts !== undefined && !Array.isArray(collections.collection_accounts)) warnings.push('collection_accounts.collection_accounts should be an array');
  }

  const regular = obj.regular_accounts || obj.account_issues || null;
  if (regular !== null && regular !== undefined && !Array.isArray(regular)) warnings.push('regular_accounts/account_issues should be an array');

  if (obj.fcra_violations !== undefined && !Array.isArray(obj.fcra_violations)) warnings.push('fcra_violations should be an array');
  if (obj.dispute_letters_needed !== undefined && !Array.isArray(obj.dispute_letters_needed)) warnings.push('dispute_letters_needed should be an array');

  if (obj.overall_assessment) {
    if (obj.overall_assessment.total_accounts !== undefined && typeof obj.overall_assessment.total_accounts !== 'number') warnings.push('overall_assessment.total_accounts should be a number');
    if (obj.overall_assessment.total_collections !== undefined && typeof obj.overall_assessment.total_collections !== 'number') warnings.push('overall_assessment.total_collections should be a number');
    if (obj.overall_assessment.total_hard_inquiries !== undefined && typeof obj.overall_assessment.total_hard_inquiries !== 'number') warnings.push('overall_assessment.total_hard_inquiries should be a number');
    if (obj.overall_assessment.total_soft_inquiries !== undefined && typeof obj.overall_assessment.total_soft_inquiries !== 'number') warnings.push('overall_assessment.total_soft_inquiries should be a number');
    if (obj.overall_assessment.total_violations_found !== undefined && typeof obj.overall_assessment.total_violations_found !== 'number') warnings.push('overall_assessment.total_violations_found should be a number');
    if (obj.overall_assessment.priority_actions !== undefined && !Array.isArray(obj.overall_assessment.priority_actions)) warnings.push('overall_assessment.priority_actions should be an array');
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { simpleValidate };
