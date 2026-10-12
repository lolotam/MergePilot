import { useI18n } from '../i18n/context.js';
import { LegalLayout } from '../components/LegalLayout.js';
import { termsAr } from '../legal/terms.ar.js';
import { termsEn } from '../legal/terms.en.js';

export function TermsPage() {
  const { language } = useI18n();
  const document = language === 'ar' ? termsAr : termsEn;

  return <LegalLayout document={document} />;
}
