// Letter templates for dispute generation
const FDCPA_TEMPLATE = `
[Date]

[Debt Collector Name]
[Address]

Re: Account Number: [Account Number]

Dear Sir/Madam,

This letter is sent in response to a notice I received from you on [Date]. Be advised that this is not a refusal to pay, but a notice sent pursuant to the Fair Debt Collection Practices Act, 15 USC 1692g Sec. 809 (b) that your claim is disputed and validation is requested.

This is NOT a request for "verification" or proof of my mailing address, but a request for VALIDATION made pursuant to the above named Title and Section. I respectfully request that your offices provide me with competent evidence that I have any legal obligation to pay you.

Please provide me with the following:
• What the money you say I owe is for;
• Explain and show me how you calculated what you say I owe;
• Provide me with copies of any papers that show I agreed to pay what you say I owe;
• Provide a verification or copy of any judgment if applicable;
• Identify the original creditor;
• Prove the Statute of Limitations has not expired on this account;
• Show me that you are licensed to collect in my state;
• Provide me with your license numbers and Registered Agent.

If your offices have reported invalidated information to any of the three major Credit Bureau's (Equifax, Experian or TransUnion), said action might constitute fraud under both Federal and State Laws. Due to this fact, if any negative mark is found on any of my credit reports by your company or the company that you represent I will not hesitate in bringing legal action against you for the following:

Violation of the Fair Credit Reporting Act and the Fair Debt Collection Practices Act.

If your offices are able to provide the proper documentation as requested in the following Declaration, I will require at least 30 days to investigate this information and during such time all collection activity must cease and desist.

Also during this validation period, if any action is taken which could be considered detrimental to any of my credit reports, I will consult with my legal counsel for suit.

I require compliance with this request within 30 days or remove this debt from your records and notify the credit reporting agencies to delete any reference to this collection action from my credit file.

Sincerely,
[Your Name]
`;

const FCRA_TEMPLATE = `
[Date]

[Credit Bureau Name]
[Address]

Re: Request for Investigation of Credit Report Information

Dear Sir/Madam,

I am writing to dispute the following information in my file. I have circled the items I dispute on the attached copy of the report I received.

This item is (inaccurate or incomplete) because [describe what is inaccurate or incomplete and why]. I am requesting that the item be removed (or request another specific change) to correct the information.

Enclosed are copies of [use this sentence if applicable and describe any enclosed documentation, such as payment records and court documents] supporting my position. Please reinvestigate this (these) matter(s) and (delete or correct) the disputed item(s) as soon as possible.

Disputed Items:
• [Item 1]: [Reason for dispute]
• [Item 2]: [Reason for dispute]
• [Item 3]: [Reason for dispute]

I understand that you must complete your reinvestigation within 30 days of receiving this letter. Please send me a written notice of the results of your investigation and a free copy of my credit report if any changes are made.

Sincerely,
[Your Name]
[Your Address]
[City, State, ZIP Code]
[Phone Number]

Enclosures: [List what you are enclosing]
`;

module.exports = { FDCPA_TEMPLATE, FCRA_TEMPLATE };