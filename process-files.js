#!/usr/bin/env node

require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');
const { processCreditReport } = require('./reportProcessor');
const readline = require('readline');

// Debug: Check environment variables
console.log('🔧 Environment check:');
console.log('- SUPABASE_URL:', process.env.SUPABASE_URL ? 'Set' : 'NOT SET');
console.log('- SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'NOT SET');

// Initialize Supabase
let supabase;
try {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  console.log('✅ Supabase client initialized');
} catch (error) {
  console.error('❌ Failed to initialize Supabase:', error.message);
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function listUserFiles(userId) {
  console.log(`\n🔍 Listing files for user: ${userId}`);

  try {
    const { data: files, error } = await supabase.storage
      .from('users-file-storage')
      .list(`credit-reports/${userId}`, { limit: 50 });

    if (error) {
      console.error('❌ Error listing files:', error.message);
      return [];
    }

    if (!files || files.length === 0) {
      console.log('📂 No files found for this user');
      return [];
    }

    console.log(`📄 Found ${files.length} files:`);
    files.forEach((file, index) => {
      const sizeKB = Math.round((file.metadata?.size || 0) / 1024);
      const date = new Date(file.created_at).toLocaleDateString();
      console.log(`  ${index + 1}. ${file.name} (${sizeKB}KB, ${date})`);
    });

    return files;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return [];
  }
}

async function processFile(userId, fileName) {
  const filePath = `credit-reports/${userId}/${fileName}`;

  console.log(`\n🚀 Processing: ${filePath}`);

  try {
    console.log('1. Extracting text (OCR if needed)...');
    const result = await require('./reportProcessor').processDocument(filePath, userId);

    console.log('✅ Text extracted successfully!');
    console.log(`📏 Text length: ${result.extractedText?.length || 0} characters`);
    console.log(`📄 Detected document type: ${result.docType || 'unknown'}`);

    if (result.extractedText && result.extractedText.length > 100) {
      console.log('\n📄 Extracted text preview:');
      console.log(result.extractedText.substring(0, 300) + '...');
    }

    console.log('\n2. AI Analysis Results:');
    console.log('📊 Summary:', result.analysis?.summary || 'No summary');

    if (result.analysis?.violations?.length > 0) {
      console.log('🚨 Violations found:', result.analysis.violations.length);
      result.analysis.violations.forEach((v, i) => {
        console.log(`   ${i + 1}. ${v.type}: ${v.description}`);
      });
    } else {
      console.log('✅ No violations detected');
    }

    if (result.analysis?.errors?.length > 0) {
      console.log('⚠️ Errors found:', result.analysis.errors.length);
      result.analysis.errors.forEach((e, i) => {
        console.log(`   ${i + 1}. ${e.type}: ${e.description}`);
      });
    } else {
      console.log('✅ No errors detected');
    }

    console.log('🎯 Overall Score:', result.analysis?.overall_score || 'unknown');

    // Store in database
    console.log('\n3. Saving to database...');
    const { error: dbError } = await supabase.from('report_analyses').insert({
      user_id: userId,
      file_path: filePath,
      file_name: fileName,
      doc_type: result.docType || 'unknown',
      extracted_text: result.extractedText?.substring(0, 5000), // Limit text storage
      ocr_artifact_id: result.ocr_artifact_id || null,
      ocr_layout: result.ocrPages ? JSON.stringify(result.ocrPages).substring(0, 20000) : null,
      analysis: result.analysis,
      violations_found: result.analysis?.violations?.length > 0,
      errors_found: result.analysis?.errors?.length > 0,
      processed_at: result.processedAt || new Date().toISOString()
    });

    if (dbError) {
      console.error('❌ Database save failed:', dbError.message);
      console.error('Tip: Ensure the DB migrations in sql/ were applied (add_doc_type_to_report_analyses.sql, add_ocr_artifact_id_to_report_analyses.sql) and that your SUPABASE_SERVICE_ROLE_KEY has permission to insert rows. You can run the admin DB check at /api/admin/db-check to get hints.');
    } else {
      console.log('✅ Analysis saved to database!');
    }

    return result;

  } catch (error) {
    console.error('❌ Processing failed:', error.message);
    return null;
  }
}

async function listAllUsers() {
  console.log('\n👥 Finding all users with files...');

  try {
    const { data: folders, error } = await supabase.storage
      .from('users-file-storage')
      .list('credit-reports', { limit: 100 });

    if (error) {
      console.error('❌ Error:', error.message);
      return [];
    }

    const userFolders = folders.filter(item => item.id === null); // Folders don't have ID

    if (userFolders.length === 0) {
      console.log('📂 No user folders found');
      return [];
    }

    console.log(`👤 Found ${userFolders.length} users with files:`);
    userFolders.forEach((folder, index) => {
      console.log(`  ${index + 1}. ${folder.name}`);
    });

    return userFolders.map(f => f.name);

  } catch (error) {
    console.error('❌ Error:', error.message);
    return [];
  }
}

async function main() {
  console.log('🤖 ConsumerAI Document Processor');
  console.log('================================');

  try {
    // Check if user provided arguments
    const args = process.argv.slice(2);

    if (args.length >= 2 && args[0] === 'process') {
      // Direct processing: node process-files.js process <userId> <fileName>
      const [, userId, fileName] = args;
      await processFile(userId, fileName);
      rl.close();
      return;
    }

    // Interactive mode
    console.log('\nChoose an option:');
    console.log('1. List all users with files');
    console.log('2. Process a specific file');
    console.log('3. List files for a user');

    const choice = await ask('Enter choice (1-3): ');

    if (choice === '1') {
      await listAllUsers();

    } else if (choice === '2') {
      const userId = await ask('Enter user ID: ');
      const files = await listUserFiles(userId);

      if (files.length > 0) {
        const fileIndex = await ask(`Enter file number (1-${files.length}): `);
        const fileNum = parseInt(fileIndex) - 1;

        if (fileNum >= 0 && fileNum < files.length) {
          await processFile(userId, files[fileNum].name);
        } else {
          console.log('❌ Invalid file number');
        }
      }

    } else if (choice === '3') {
      const userId = await ask('Enter user ID: ');
      await listUserFiles(userId);

    } else {
      console.log('❌ Invalid choice');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }

  rl.close();
}

main();