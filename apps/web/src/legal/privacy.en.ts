import type { LegalDocument } from './types.js';
import { SITE_NAME, SUPPORT_EMAIL, OPERATOR_NAME, LAST_UPDATED } from '../config/site.js';

export const privacyEn: LegalDocument = {
  title: 'Privacy Policy',
  subtitle: `This Privacy Policy outlines how ${SITE_NAME} handles your data and our strict commitment to safeguarding your code and privacy.`,
  lastUpdated: LAST_UPDATED,
  sections: [
    {
      id: 'overview',
      title: '1. Overview and Data Controller',
      paragraphs: [
        `This Privacy Policy governs the collection, use, and protection of information by ${OPERATOR_NAME} (referred to as "${SITE_NAME}", "we", "us", or "our").`,
        'We believe strictly in data minimization: we only process what is needed to deliver code reviews, and we never store your repository source code on our servers.',
      ],
    },
    {
      id: 'data-collected',
      title: '2. Data We Collect',
      paragraphs: [
        'We collect only the essential metadata necessary to provide and secure our service:',
      ],
      bulletPoints: [
        'Account Data: Name, email address, and avatar image obtained when you sign in via Google or GitHub OAuth.',
        'GitHub App Installation Data: Account login, installation ID, repository names, pull request numbers, and commit SHAs.',
        'Review Run Metadata: Execution status, estimated review cost in USD, and timestamps.',
        'Customer AI Provider API Keys: Customer-supplied API keys for Anthropic, OpenAI, or Google Gemini are stored fully encrypted with AES-256-GCM and never echoed back in the user interface after saving.',
      ],
    },
    {
      id: 'data-not-stored',
      title: '3. Data We Do NOT Store',
      paragraphs: [
        'Source Code: MergePilot does not store your repository source code.',
        'Pull request diffs and file contents are inspected ephemerally in memory at review time and dispatched exclusively to your selected AI provider using your own API credentials. They are never persisted or retained on MergePilot storage systems.',
      ],
    },
    {
      id: 'how-we-use-data',
      title: '4. How We Use Data',
      paragraphs: [
        'We utilize collected data solely for the following purposes:',
      ],
      bulletPoints: [
        'Authenticating users, maintaining sessions, and managing workspace memberships.',
        'Executing automated code reviews and posting findings back to pull requests on GitHub.',
        'Enforcing customer-defined monthly spending limits and budgets.',
        'Protecting system integrity and preventing abuse.',
      ],
    },
    {
      id: 'google-user-data',
      title: '5. Google User Data and Limited Use Requirements',
      paragraphs: [
        'When you authenticate using Google, we request only the basic openid, email, and profile permission scopes.',
        'We use this information exclusively to sign you in, verify your identity, and display your name and email in your workspace.',
        'We do not sell Google user data to any third party and we do not use Google user data for advertising, marketing, or retargeting purposes.',
        `${SITE_NAME}'s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.`,
      ],
      link: {
        text: 'https://developers.google.com/terms/api-services-user-data-policy',
        url: 'https://developers.google.com/terms/api-services-user-data-policy',
      },
    },
    {
      id: 'github-data',
      title: '6. GitHub Data and App Permissions',
      paragraphs: [
        'Our GitHub App requests only the minimum permissions required to conduct automated pull request reviews:',
      ],
      bulletPoints: [
        'Contents: Read-only access to view modified files and diffs being reviewed.',
        'Pull requests: Read & Write access to post automated review comments and suggestions.',
        'Issues: Read & Write access to post summary comments where appropriate.',
        'Metadata: Read-only access to identify repositories.',
        'Email: Read-only access to associate your GitHub user with your workspace.',
      ],
    },
    {
      id: 'third-parties',
      title: '7. Third-Party Service Providers',
      paragraphs: [
        'We work solely with trusted third-party providers for infrastructure and model execution:',
      ],
      bulletPoints: [
        'Authentication: Google and GitHub for secure single sign-on.',
        'AI Providers: Anthropic, OpenAI, and Google Gemini — prompts and diff snippets are transmitted directly using the customer’s own API key under the customer’s agreement with the respective provider.',
        'Hosting & Database: Secure cloud infrastructure hosting our web application and session stores.',
      ],
    },
    {
      id: 'cookies',
      title: '8. Cookies and Local Storage',
      paragraphs: [
        'We use essential first-party session cookies solely to maintain your authenticated session.',
        'We use localStorage exclusively to remember your preferred interface language (Arabic or English). We do not deploy advertising or tracking cookies.',
      ],
    },
    {
      id: 'retention-deletion',
      title: '9. Data Retention and Deletion',
      paragraphs: [
        'We retain workspace metadata as long as your account remains active. You may delete workspaces, remove API keys, or uninstall the GitHub App at any time.',
        `To request complete deletion of your account and all associated data, contact us at ${SUPPORT_EMAIL}. All relevant data will be permanently deleted within 30 days of receiving your verified request.`,
      ],
    },
    {
      id: 'security',
      title: '10. Security and Key Encryption',
      paragraphs: [
        'We implement industry-standard security controls including TLS 1.3 in transit, and AES-256-GCM symmetric encryption for all customer API keys at rest.',
        'API keys and secrets are strictly excluded from logs, error reports, and client payloads.',
      ],
    },
    {
      id: 'children',
      title: '11. Children’s Privacy',
      paragraphs: [
        'Our service is built for software professionals and teams and is not directed to individuals under 16 years of age. We do not knowingly collect personal data from children under 16.',
      ],
    },
    {
      id: 'changes',
      title: '12. Changes to This Policy',
      paragraphs: [
        'We may update this policy periodically to reflect product changes or legal requirements. When significant revisions are published, we will update the "Last updated" date at the top of this document.',
      ],
    },
    {
      id: 'contact',
      title: '13. Contact Information',
      paragraphs: [
        `If you have questions or concerns regarding this Privacy Policy or data protection, please reach out to us at: ${SUPPORT_EMAIL}.`,
      ],
    },
  ],
};
