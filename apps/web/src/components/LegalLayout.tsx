import { Link } from 'react-router';
import { Globe, ArrowLeft, ArrowRight } from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { Logo } from './Logo.js';
import { Footer } from './Footer.js';
import type { LegalDocument } from '../legal/types.js';

export interface LegalLayoutProps {
  document: LegalDocument;
}

export function LegalLayout({ document }: LegalLayoutProps) {
  const { t, toggleLanguage, dir } = useI18n();
  const BackArrow = dir === 'rtl' ? ArrowRight : ArrowLeft;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-ink-950 text-ink-800 dark:text-ink-100 flex flex-col font-sans">
      {/* Public Header */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-ink-900/90 backdrop-blur-md border-b border-gray-200 dark:border-ink-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
            <Logo size="sm" />
          </Link>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('languageToggle')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-ink-700 hover:bg-gray-100 dark:hover:bg-ink-800 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{t('languageToggle')}</span>
            </button>

            <Link
              to="/login"
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand-600 hover:bg-brand-700 text-white transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {t('signInCTA')}
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-10 sm:py-14">
        {/* Back Link */}
        <div className="mb-6">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline"
          >
            <BackArrow className="w-3.5 h-3.5" />
            <span>{t('backToHome')}</span>
          </Link>
        </div>

        {/* Document Header */}
        <header className="mb-10 pb-6 border-b border-gray-200 dark:border-ink-800">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-ink-900 dark:text-ink-50 mb-3">
            {document.title}
          </h1>
          <p className="text-base text-gray-600 dark:text-gray-300 mb-4 max-w-2xl leading-relaxed">
            {document.subtitle}
          </p>
          <div className="text-xs font-mono text-gray-500 dark:text-gray-400">
            <span>{t('lastUpdatedLabel')}: </span>
            <time dateTime={document.lastUpdated}>{document.lastUpdated}</time>
          </div>
        </header>

        {/* Table of Contents */}
        <nav
          aria-label={t('tableOfContents')}
          className="mb-12 p-6 rounded-xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 shadow-xs"
        >
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-4">
            {t('tableOfContents')}
          </h2>
          <ol className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
            {document.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-brand-600 dark:text-brand-400 hover:underline block truncate py-0.5"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* Document Sections */}
        <article className="space-y-12">
          {document.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-24 p-6 sm:p-8 rounded-xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 shadow-xs"
            >
              <h2 className="text-xl sm:text-2xl font-bold text-ink-900 dark:text-ink-50 mb-4">
                {section.title}
              </h2>

              <div className="space-y-3.5 text-sm sm:text-base leading-relaxed text-gray-700 dark:text-gray-300">
                {section.paragraphs.map((p, idx) => (
                  <p key={idx}>{p}</p>
                ))}

                {section.bulletPoints && section.bulletPoints.length > 0 && (
                  <ul className="list-disc list-inside space-y-2 ps-2 pt-2 text-gray-700 dark:text-gray-300">
                    {section.bulletPoints.map((bp, bidx) => (
                      <li key={bidx} className="leading-relaxed">
                        <span>{bp}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {section.link && (
                  <div className="pt-2">
                    <a
                      href={section.link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-brand-600 dark:text-brand-400 hover:underline font-mono text-xs sm:text-sm break-all"
                    >
                      {section.link.text}
                    </a>
                  </div>
                )}
              </div>
            </section>
          ))}
        </article>
      </main>

      <Footer />
    </div>
  );
}
