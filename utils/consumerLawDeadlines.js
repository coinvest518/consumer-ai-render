// Consumer Law Deadline Calculator
const moment = require('moment');

class ConsumerLawDeadlines {
  
  // FDCPA Validation Request Deadlines
  static calculateFDCPADeadlines(initialContactDate, certifiedMailSent = false) {
    const contact = moment(initialContactDate);
    
    return {
      // Debt collector must provide validation notice within 5 days
      validationNoticeDeadline: contact.clone().add(5, 'days').format('YYYY-MM-DD'),
      
      // Consumer has 30 days to request validation
      consumerValidationDeadline: contact.clone().add(30, 'days').format('YYYY-MM-DD'),
      
      // If certified mail sent, add delivery confirmation time
      effectiveDeadline: certifiedMailSent 
        ? contact.clone().add(33, 'days').format('YYYY-MM-DD') // 30 days + 3 for delivery
        : contact.clone().add(30, 'days').format('YYYY-MM-DD'),
        
      // Collection must cease during validation period
      collectionCeaseDate: contact.clone().add(30, 'days').format('YYYY-MM-DD'),
      
      advice: certifiedMailSent 
        ? "✅ Good! Certified mail provides proof of delivery. Keep your receipt."
        : "⚠️ Consider sending via certified mail for proof of delivery."
    };
  }

  // FCRA Dispute Deadlines
  static calculateFCRADeadlines(disputeDate, method = 'mail') {
    const dispute = moment(disputeDate);
    
    const deadlines = {
      // Credit bureau has 30 days to investigate (45 if additional info provided)
      investigationDeadline: dispute.clone().add(30, 'days').format('YYYY-MM-DD'),
      extendedDeadline: dispute.clone().add(45, 'days').format('YYYY-MM-DD'),
      
      // Must provide results within 5 days of completion
      resultsDeadline: dispute.clone().add(35, 'days').format('YYYY-MM-DD'),
      
      // If dispute is frivolous, they have 5 days to notify
      frivolousNoticeDeadline: dispute.clone().add(5, 'days').format('YYYY-MM-DD')
    };

    if (method === 'certified') {
      deadlines.advice = "✅ Certified mail sent! This starts your 30-day clock with proof.";
    } else if (method === 'online') {
      deadlines.advice = "📧 Online dispute filed. Save confirmation number and screenshots.";
    } else {
      deadlines.advice = "⚠️ Regular mail sent. Consider certified mail for important disputes.";
    }

    return deadlines;
  }

  // Calculate when to follow up if no response
  static calculateFollowUpDates(originalDate, type = 'FDCPA') {
    const original = moment(originalDate);
    
    if (type === 'FDCPA') {
      return {
        firstFollowUp: original.clone().add(35, 'days').format('YYYY-MM-DD'),
        secondFollowUp: original.clone().add(45, 'days').format('YYYY-MM-DD'),
        legalAction: original.clone().add(60, 'days').format('YYYY-MM-DD'),
        advice: "If no response after 30 days, they may be in violation. Document everything!"
      };
    } else { // FCRA
      return {
        firstFollowUp: original.clone().add(35, 'days').format('YYYY-MM-DD'),
        secondFollowUp: original.clone().add(50, 'days').format('YYYY-MM-DD'),
        legalAction: original.clone().add(65, 'days').format('YYYY-MM-DD'),
        advice: "No response after 30 days? File a complaint with CFPB and consider legal action."
      };
    }
  }

  // Statute of Limitations Calculator
  static calculateSOL(debtDate, state = 'general') {
    const debt = moment(debtDate);
    
    // Common SOL periods by type (simplified)
    const solPeriods = {
      'credit_card': { years: 6, type: 'written contract' },
      'medical': { years: 6, type: 'written contract' },
      'auto_loan': { years: 4, type: 'written contract' },
      'personal_loan': { years: 6, type: 'written contract' }
    };

    const generalSOL = 6; // Most common for written contracts
    const expirationDate = debt.clone().add(generalSOL, 'years');
    const daysRemaining = expirationDate.diff(moment(), 'days');

    return {
      originalDebtDate: debt.format('YYYY-MM-DD'),
      solExpirationDate: expirationDate.format('YYYY-MM-DD'),
      daysRemaining: Math.max(0, daysRemaining),
      isExpired: daysRemaining <= 0,
      advice: daysRemaining <= 0 
        ? "🚨 SOL may be expired! This is a strong defense against collection."
        : `⏰ SOL expires in ${daysRemaining} days. Don't restart the clock by making payments!`
    };
  }
}

module.exports = ConsumerLawDeadlines;