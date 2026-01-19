#!/usr/bin/env node

// Simple script to ensure temp/aiUtils.js is available during deployment
const fs = require('fs');
const path = require('path');

const tempDir = path.join(__dirname, 'temp');
const srcDir = path.join(__dirname, 'src', 'temp');
const aiUtilsFile = path.join(tempDir, 'aiUtils.js');
const srcAiUtilsFile = path.join(srcDir, 'aiUtils.js');

console.log('Checking temp directory structure...');

// Ensure temp directory exists
if (!fs.existsSync(tempDir)) {
  console.log('Creating temp directory...');
  fs.mkdirSync(tempDir, { recursive: true });
}

// Check if aiUtils.js exists in temp
if (!fs.existsSync(aiUtilsFile)) {
  console.log('temp/aiUtils.js not found, checking src/temp/...');
  
  // Try to copy from src/temp if it exists
  if (fs.existsSync(srcAiUtilsFile)) {
    console.log('Copying from src/temp/aiUtils.js...');
    fs.copyFileSync(srcAiUtilsFile, aiUtilsFile);
    console.log('✅ Copied aiUtils.js to temp directory');
  } else {
    console.log('❌ aiUtils.js not found in either location');
    process.exit(1);
  }
} else {
  console.log('✅ temp/aiUtils.js already exists');
}

console.log('Temp directory setup complete');