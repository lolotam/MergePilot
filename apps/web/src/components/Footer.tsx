import { Link } from 'react-router';
import { useI18n } from '../i18n/context.js';
import { SITE_NAME, SUPPORT_EMAIL } from '../config/site.js';

export function Footer() {
  const { t } = useI18n();
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-ink-200 dark:border-ink-800 bg-[#FBFBFA]/80 dark:bg-ink-950/80 backdrop-blur-md py-8 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-ink-500 dark:text-ink-400">
        <div className="flex items-center gap-2">
          <span>
            © {currentYear} {SITE_NAME}. {t('footerCopyright')}
          </span>
        </div>

        <nav aria-label="Footer navigation" className="flex items-center gap-6">
          <Link
            to="/privacy"
            className="hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            {t('footerPrivacy')}
          </Link>
          <Link
            to="/terms"
            className="hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            {t('footerTerms')}
          </Link>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            {SUPPORT_EMAIL}
          </a>
        </nav>
      </div>
    </footer>
  );
}
