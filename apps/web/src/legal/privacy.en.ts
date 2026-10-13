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
        'AI Provider Credentials: Customer-supplied API keys and connected OpenAI/Codex, Anthropic/Claude, or xAI/Grok subscription access tokens, refresh tokens, expiry and account identifiers are encrypted with AES-256-GCM. Secret values are never returned to the user interface after saving.',
      ],
    },
    {
      id: 'data-not-stored',
      title: '3. Data We Do NOT Store',
      paragraphs: [
        'Source Code: MergePilot does not store your repository source code.',
        'Pull request diffs and file contents are inspected in memory at review time and sent to your configured AI provider using your active API-key or subscription credentials. Review results, including findings and suggestions, are retained according to your workspace retention settings.',
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
        'The service operator can view account and workspace metadata (name, email, sign-in providers, workspaces, connected installations, review run metadata and costs) to operate, support and secure the service — never source code or API keys.',
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
        'AI Providers: your configured providers, including Anthropic, OpenAI, Google Gemini and xAI. Prompts and diff snippets use your active API-key or subscription credentials. Subscription tokens are refreshed through the provider’s authentication service.',
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
        'We retain workspace metadata as long as your account remains active. You may delete workspaces, remove API keys or connected subscription credentials, or uninstall the GitHub App at any time. Pending subscription login attempts expire after 15 minutes.',
        `To request complete deletion of your account and all associated data, contact us at ${SUPPORT_EMAIL}. All relevant data will be permanently deleted within 30 days of receiving your verified request.`,
      ],
    },
    {
      id: 'security',
      title: '10. Security and Key Encryption',
      paragraphs: [
        'We use HTTPS/TLS in transit and AES-256-GCM envelope encryption for stored customer API keys and subscription tokens.',
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
