const nodemailer = require('nodemailer');
const { DynamicTool } = require('@langchain/core/tools');

// SMTP transporter using Render env vars
const createTransporter = () => {
  return nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

// Send email tool
const sendEmailTool = new DynamicTool({
  name: "send_email",
  description: "Send email with subject and body to specified recipient",
  func: async (input) => {
    try {
      const { to, subject, body } = JSON.parse(input);
      const transporter = createTransporter();
      
      const result = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        html: body
      });
      
      return `Email sent successfully to ${to}. Message ID: ${result.messageId}`;
    } catch (error) {
      return `Failed to send email: ${error.message}`;
    }
  }
});

// Send dispute letter email tool
const sendDisputeLetterTool = new DynamicTool({
  name: "send_dispute_letter",
  description: "Send formatted dispute letter via email",
  func: async (input) => {
    try {
      const { to, letterType, letterContent } = JSON.parse(input);
      const transporter = createTransporter();
      
      const subject = letterType === 'FDCPA' ? 
        'FDCPA Debt Validation Request' : 
        'FCRA Credit Report Dispute';
      
      const result = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        html: `<pre>${letterContent}</pre>`
      });
      
      return `Dispute letter sent to ${to}. Type: ${letterType}`;
    } catch (error) {
      return `Failed to send dispute letter: ${error.message}`;
    }
  }
});

module.exports = { sendEmailTool, sendDisputeLetterTool };