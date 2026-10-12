import { useI18n } from '../i18n/context.js';
import { LegalLayout } from '../components/LegalLayout.js';
import { privacyAr } from '../legal/privacy.ar.js';
import { privacyEn } from '../legal/privacy.en.js';

export function PrivacyPage() {
  const { language } = useI18n();
  const document = language === 'ar' ? privacyAr : privacyEn;

  return <LegalLayout document={document} />;
}
