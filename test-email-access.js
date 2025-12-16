const nodemailer = require('nodemailer');

async function testEmailAccess() {
  console.log('📧 Testing AI Agent Email Access...\n');
  
  const emailConfig = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM
  };

  console.log('Email Configuration:');
  console.log('='.repeat(30));
  Object.entries(emailConfig).forEach(([key, value]) => {
    const display = key === 'pass' ? (value ? '***HIDDEN***' : 'NOT SET') : value || 'NOT SET';
    console.log(`${key.padEnd(15)} | ${display}`);
  });

  const results = {
    configComplete: true,
    connectionTest: false,
    sendTest: false,
    errors: []
  };

  // Check required config
  const required = ['host', 'port', 'user', 'pass', 'from'];
  for (const field of required) {
    if (!emailConfig[field.replace('from', 'from')]) {
      results.configComplete = false;
      results.errors.push(`Missing ${field}`);
    }
  }

  if (!results.configComplete) {
    console.log('\n❌ Email configuration incomplete');
    return results;
  }

  // Test SMTP connection
  try {
    console.log('\n🔗 Testing SMTP connection...');
    const transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: parseInt(emailConfig.port, 10),
      secure: emailConfig.secure,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass
      }
    });

    await transporter.verify();
    results.connectionTest = true;
    console.log('✅ SMTP connection successful');

    // Test sending email (to sender's own email)
    console.log('\n📤 Testing email send...');
    const testResult = await transporter.sendMail({
      from: emailConfig.from,
      to: emailConfig.user, // Send to self
      subject: 'AI Agent Email Test',
      html: '<h3>✅ AI Agent Email Test Successful</h3><p>This confirms the AI agent can send emails.</p>'
    });

    results.sendTest = true;
    results.messageId = testResult.messageId;
    console.log(`✅ Test email sent successfully (ID: ${testResult.messageId})`);

  } catch (error) {
    results.errors.push(error.message);
    console.log(`❌ Email test failed: ${error.message}`);
  }

  console.log('\n📊 Email Access Summary:');
  console.log('='.repeat(40));
  console.log(`✅ Configuration: ${results.configComplete ? 'Complete' : 'Incomplete'}`);
  console.log(`✅ SMTP Connection: ${results.connectionTest ? 'Working' : 'Failed'}`);
  console.log(`✅ Send Capability: ${results.sendTest ? 'Working' : 'Failed'}`);

  return results;
}

module.exports = { testEmailAccess };

if (require.main === module) {
  testEmailAccess().catch(console.error);
}