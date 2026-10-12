import { Link } from 'react-router';
import {
  Globe,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Languages,
  BookOpenCheck,
  KeyRound,
  CheckCircle2,
  Sliders,
  Lock,
  Cpu,
  Github,
  HelpCircle,
} from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { Logo } from '../components/Logo.js';
import { Footer } from '../components/Footer.js';

export function LandingPage() {
  const { t, toggleLanguage, dir } = useI18n();
  const Arrow = dir === 'rtl' ? ArrowLeft : ArrowRight;

  const steps = [
    {
      num: '01',
      title: t('landingStep1Title'),
      desc: t('landingStep1Desc'),
      icon: Github,
    },
    {
      num: '02',
      title: t('landingStep2Title'),
      desc: t('landingStep2Desc'),
      icon: KeyRound,
    },
    {
      num: '03',
      title: t('landingStep3Title'),
      desc: t('landingStep3Desc'),
      icon: CheckCircle2,
    },
  ];

  const features = [
    {
      title: t('featArabicTitle'),
      desc: t('featArabicDesc'),
      icon: Languages,
    },
    {
      title: t('featRulesTitle'),
      desc: t('featRulesDesc'),
      icon: BookOpenCheck,
    },
    {
      title: t('featByokTitle'),
      desc: t('featByokDesc'),
      icon: Cpu,
    },
    {
      title: t('featVerificationTitle'),
      desc: t('featVerificationDesc'),
      icon: ShieldCheck,
    },
    {
      title: t('featBudgetTitle'),
      desc: t('featBudgetDesc'),
      icon: Sliders,
    },
    {
      title: t('featSecurityTitle'),
      desc: t('featSecurityDesc'),
      icon: Lock,
    },
  ];

  const providers = [
    { name: 'Anthropic', models: 'Claude 3.7 Sonnet, Claude 3.5 Haiku' },
    { name: 'OpenAI', models: 'GPT-4o, GPT-4o mini, o1' },
    { name: 'Google Gemini', models: 'Gemini 2.5 Flash, Gemini 2.5 Pro' },
  ];

  const faqs = [
    { q: t('faqQ1'), a: t('faqA1') },
    { q: t('faqQ2'), a: t('faqA2') },
    { q: t('faqQ3'), a: t('faqA3') },
    { q: t('faqQ4'), a: t('faqA4') },
    { q: t('faqQ5'), a: t('faqA5') },
  ];

  return (
    <div className="min-h-screen bg-[#FBFBFA] dark:bg-ink-950 text-ink-800 dark:text-ink-100 flex flex-col font-sans">
      {/* Public Top Bar */}
      <header className="sticky top-0 z-40 bg-[#FBFBFA]/90 dark:bg-ink-900/90 backdrop-blur-md border-b border-ink-200 dark:border-ink-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
            <Logo size="md" />
          </Link>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('languageToggle')}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{t('languageToggle')}</span>
            </button>

            <Link
              to="/login"
              className="whitespace-nowrap px-5 py-2 text-xs font-semibold rounded-full bg-brand-600 hover:bg-brand-700 text-white transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {t('signInCTA')}
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-16 pb-20 sm:pt-24 sm:pb-28 border-b border-ink-200 dark:border-ink-800">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 mb-6 rounded-full bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-800 text-brand-700 dark:text-brand-300 text-xs font-medium">
            <span className="w-2 h-2 rounded-full bg-brand-500" />
            <span>{t('appTagline')}</span>
          </div>

          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>

          <h1 className="font-serif text-3xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-ink-900 dark:text-ink-50 mb-6 leading-tight sm:leading-tight">
            {t('landingHeroTitle')}
          </h1>

          <p className="text-base sm:text-lg text-ink-500 dark:text-ink-400 mb-10 max-w-2xl mx-auto font-sans leading-relaxed">
            {t('landingHeroSubtitle')}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/login"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full bg-brand-600 hover:bg-brand-700 text-white font-medium text-sm transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <span>{t('landingGetStarted')}</span>
              <Arrow className="w-4 h-4" />
            </Link>

            <Link
              to="/login"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 hover:bg-ink-50 dark:hover:bg-ink-800 text-ink-800 dark:text-ink-100 font-medium text-sm transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Github className="w-4 h-4" />
              <span>{t('landingInstallGitHub')}</span>
            </Link>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-ink-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-ink-900 dark:text-ink-50 mb-3">
            {t('howItWorksTitle')}
          </h2>
          <p className="text-sm sm:text-base text-ink-500 dark:text-ink-400 font-sans">
            {t('howItWorksSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {steps.map((st) => {
            const Icon = st.icon;
            return (
              <div
                key={st.num}
                className="p-6 rounded-[10px] bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-xs font-mono font-bold text-brand-700 dark:text-brand-300 px-2.5 py-1 rounded-full bg-brand-50 dark:bg-brand-900/40 border border-brand-200 dark:border-brand-800">
                      {st.num}
                    </span>
                    <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center">
                      <Icon className="w-4 h-4" />
                    </div>
                  </div>
                  <h3 className="text-base font-bold text-ink-900 dark:text-ink-50 mb-2">
                    {st.title}
                  </h3>
                  <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-400 leading-relaxed font-sans">
                    {st.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-ink-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-ink-900 dark:text-ink-50 mb-3">
            {t('featuresTitle')}
          </h2>
          <p className="text-sm sm:text-base text-ink-500 dark:text-ink-400 font-sans">
            {t('featuresSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feat, idx) => {
            const Icon = feat.icon;
            return (
              <div
                key={idx}
                className="p-6 rounded-[10px] bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 shadow-xs transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center mb-4">
                  <Icon className="w-4 h-4" />
                </div>
                <h3 className="text-base font-bold text-ink-900 dark:text-ink-50 mb-2">
                  {feat.title}
                </h3>
                <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-400 leading-relaxed font-sans">
                  {feat.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* AI Providers Row */}
      <section className="py-16 sm:py-20 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-ink-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="font-serif text-xl sm:text-2xl font-bold text-ink-900 dark:text-ink-50 mb-2">
            {t('providersTitle')}
          </h2>
          <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-400 font-sans">
            {t('providersSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {providers.map((p) => (
            <div
              key={p.name}
              className="p-6 rounded-[10px] bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 text-center shadow-xs"
            >
              <h3 className="font-bold text-base text-ink-900 dark:text-ink-50 mb-1">
                {p.name}
              </h3>
              <p className="text-xs text-brand-700 dark:text-brand-300 font-mono">
                {p.models}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-20 sm:py-24 max-w-4xl mx-auto px-4 sm:px-6 w-full border-b border-ink-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-14">
          <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 mb-3">
            <HelpCircle className="w-4 h-4" />
          </div>
          <h2 className="font-serif text-2xl sm:text-3xl font-bold text-ink-900 dark:text-ink-50 mb-3">
            {t('faqTitle')}
          </h2>
          <p className="text-sm sm:text-base text-ink-500 dark:text-ink-400 font-sans">
            {t('faqSubtitle')}
          </p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              className="p-6 rounded-[10px] bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 shadow-xs"
            >
              <h3 className="text-base font-bold text-ink-900 dark:text-ink-50 mb-2">
                {faq.q}
              </h3>
              <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-400 leading-relaxed font-sans">
                {faq.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Bottom Banner */}
      <section className="py-16 sm:py-24 bg-brand-700 text-white text-center px-4 sm:px-6">
        <div className="max-w-2xl mx-auto">
          <h2 className="font-serif text-2xl sm:text-4xl font-bold mb-4">
            {t('ctaBannerTitle')}
          </h2>
          <p className="text-sm sm:text-base text-brand-100 mb-8 max-w-xl mx-auto font-sans">
            {t('ctaBannerSubtitle')}
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-full bg-white hover:bg-ink-50 text-brand-800 font-semibold text-sm shadow-xs transition-colors"
          >
            <span>{t('landingGetStarted')}</span>
            <Arrow className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
