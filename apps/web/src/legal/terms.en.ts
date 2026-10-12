import type { LegalDocument } from './types.js';
import { SITE_NAME, SUPPORT_EMAIL, OPERATOR_NAME, GOVERNING_LAW, LAST_UPDATED } from '../config/site.js';

export const termsEn: LegalDocument = {
  title: 'Terms of Service',
  subtitle: `Legal terms and conditions governing your access and use of the ${SITE_NAME} code review service provided by ${OPERATOR_NAME}.`,
  lastUpdated: LAST_UPDATED,
  sections: [
    {
      id: 'acceptance',
      title: '1. Acceptance of Terms',
      paragraphs: [
        `By creating an account, accessing, or using ${SITE_NAME}, you agree to be legally bound by these Terms of Service and our Privacy Policy.`,
        'If you do not agree to these terms, you must not use the service and should uninstall our GitHub App immediately.',
      ],
    },
    {
      id: 'the-service',
      title: '2. The Service and Customer Responsibility for Code',
      paragraphs: [
        `${SITE_NAME} provides automated, AI-assisted code review comments and suggestions on GitHub pull requests.`,
        'Review comments and code suggestions are generated automatically by large language models and may contain inaccuracies, false positives, or incomplete suggestions. You and your development team remain solely and exclusively responsible for reviewing, verifying, testing, and merging all code into your repositories.',
        'MergePilot reviews do not constitute a formal code audit, security certification, or guarantee that code is free from flaws or vulnerabilities.',
      ],
    },
    {
      id: 'accounts',
      title: '3. Accounts and Workspaces',
      paragraphs: [
        'You must sign in using a verified Google or GitHub account. You are responsible for safeguarding your login credentials.',
        'Workspace owners and administrators bear full responsibility for team members they invite, role assignments (owner, admin, member), budget configurations, and API keys stored in the workspace.',
      ],
    },
    {
      id: 'api-keys-billing',
      title: '4. Customer API Keys and Third-Party Provider Costs',
      paragraphs: [
        'MergePilot operates under a Bring Your Own Key (BYOK) architecture. You supply your own API credentials for AI providers (Anthropic, OpenAI, Google Gemini).',
        'All AI usage charges and model execution fees are billed directly to you by your selected AI provider under your independent account and agreement with them. MergePilot does not intermediate AI token billing and is not responsible for provider invoices or rate limits.',
        'You may configure monthly budget caps in MergePilot to halt reviews when a threshold is met, but you remain responsible for monitoring your provider account usage.',
      ],
    },
    {
      id: 'acceptable-use',
      title: '5. Acceptable Use',
      paragraphs: [
        'You agree not to use or misuse the service in connection with any of the following:',
      ],
      bulletPoints: [
        'Violating applicable local, national, or international laws and regulations.',
        'Processing unlawful, malicious, defamatory, or harmful code (such as malware or exploits).',
        'Attempting to attack, probe, reverse engineer, or disrupt MergePilot systems or infrastructure.',
        'Circumventing security mechanisms, authentication barriers, or monthly budget controls.',
      ],
    },
    {
      id: 'github-permissions',
      title: '6. GitHub Permissions and Non-Destructive Behavior',
      paragraphs: [
        'The MergePilot GitHub App operates strictly to post review summaries and inline comments on pull requests.',
        'MergePilot will never push commits (git push), never approve pull requests, and never merge pull requests under any circumstances.',
      ],
    },
    {
      id: 'availability',
      title: '7. Availability and Service Modifications',
      paragraphs: [
        'The service is provided on an "AS IS" and "AS AVAILABLE" basis without warranties of uninterrupted uptime or error-free operation.',
        'We reserve the right to deploy updates, enhance functionality, or perform scheduled maintenance with commercially reasonable efforts.',
      ],
    },
    {
      id: 'intellectual-property',
      title: '8. Intellectual Property',
      paragraphs: [
        'You retain all intellectual property rights and ownership of your source code, repositories, and diff contents. MergePilot asserts no ownership over your code.',
        `${OPERATOR_NAME} retains all intellectual property rights, trademarks, and design assets associated with the ${SITE_NAME} service, website, and brand.`,
      ],
    },
    {
      id: 'disclaimer-liability',
      title: '9. Disclaimers and Limitation of Liability',
      paragraphs: [
        `To the maximum extent permitted by applicable law, neither ${SITE_NAME} nor its operators shall be liable for indirect, incidental, punitive, or consequential damages, including loss of profits, data corruption, or damages arising from code merged following AI reviews.`,
        'In all circumstances, our cumulative liability is strictly limited to the direct fees paid by you to MergePilot in the twelve months preceding the claim, if any.',
      ],
    },
    {
      id: 'termination',
      title: '10. Termination',
      paragraphs: [
        'You may discontinue service at any time by uninstalling the GitHub App or requesting workspace deletion.',
        'We reserve the right to suspend or terminate accounts that breach these Terms of Service or engage in abusive behavior.',
      ],
    },
    {
      id: 'governing-law',
      title: '11. Governing Law',
      paragraphs: [
        `These Terms shall be governed by and construed in accordance with the laws of ${GOVERNING_LAW}, and any disputes shall be resolved exclusively in the competent courts thereof.`,
      ],
    },
    {
      id: 'contact',
      title: '12. Contact Information',
      paragraphs: [
        `For inquiries regarding these Terms of Service, please contact us at: ${SUPPORT_EMAIL}.`,
      ],
    },
  ],
};
