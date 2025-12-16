const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

// Support validating against multiple named schemas stored under /schemas
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = {}; // cache compiled validators by filename

function loadSchemaByName(name) {
  const fileName = name || 'analysis.schema.json';
  if (validators[fileName]) return validators[fileName];
  try {
    const schemaPath = path.join(__dirname, '..', 'schemas', fileName);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const validateFn = ajv.compile(schema);
    validators[fileName] = validateFn;
    return validateFn;
  } catch (err) {
    console.error('Failed to load schema for AJV:', name, err.message);
    return null;
  }
}

function validate(schemaNameOrObj, maybeObj) {
  // backward-compatible: validate(obj) -> uses analysis.schema.json
  if (typeof schemaNameOrObj === 'object' && maybeObj === undefined) {
    const validateFn = loadSchemaByName('analysis.schema.json');
    if (!validateFn) return { valid: false, errors: ['Schema not loaded'] };
    const valid = validateFn(schemaNameOrObj);
    if (valid) return { valid: true, errors: [] };
    const errors = (validateFn.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
    return { valid: false, errors };
  }

  // validate(schemaFileName, obj)
  const fileName = schemaNameOrObj || 'analysis.schema.json';
  const obj = maybeObj;
  const validateFn = loadSchemaByName(fileName);
  if (!validateFn) return { valid: false, errors: ['Schema not loaded'] };
  const valid = validateFn(obj);
  if (valid) return { valid: true, errors: [] };
  const errors = (validateFn.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
  return { valid: false, errors };
}

module.exports = { validate };
