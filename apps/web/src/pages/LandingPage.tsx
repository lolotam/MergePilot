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
    <div className="min-h-screen bg-gray-50 dark:bg-ink-950 text-ink-800 dark:text-ink-100 flex flex-col font-sans">
      {/* Public Header */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-ink-900/90 backdrop-blur-md border-b border-gray-200 dark:border-ink-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
            <Logo size="md" />
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
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {t('signInCTA')}
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-12 pb-20 sm:pt-20 sm:pb-28 border-b border-gray-200 dark:border-ink-800 bg-linear-to-b from-white via-gray-50/50 to-gray-100/30 dark:from-ink-900 dark:via-ink-950/80 dark:to-ink-950">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 mb-8 rounded-full bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-800/80 text-brand-700 dark:text-brand-300 text-xs font-medium">
            <span className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
            <span>{t('appTagline')}</span>
          </div>

          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>

          <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black tracking-tight text-ink-900 dark:text-ink-50 mb-6 leading-tight sm:leading-tight">
            {t('landingHeroTitle')}
          </h1>

          <p className="text-base sm:text-xl text-gray-600 dark:text-gray-300 mb-10 max-w-3xl mx-auto leading-relaxed">
            {t('landingHeroSubtitle')}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/login"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm shadow-md transition-all hover:shadow-lg focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <span>{t('landingGetStarted')}</span>
              <Arrow className="w-4 h-4" />
            </Link>

            <Link
              to="/login"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-900 hover:bg-gray-50 dark:hover:bg-ink-800 text-ink-800 dark:text-ink-100 font-semibold text-sm transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Github className="w-4 h-4" />
              <span>{t('landingInstallGitHub')}</span>
            </Link>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-20 sm:py-28 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-gray-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-ink-900 dark:text-ink-50 mb-3">
            {t('howItWorksTitle')}
          </h2>
          <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400">
            {t('howItWorksSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {steps.map((st) => {
            const Icon = st.icon;
            return (
              <div
                key={st.num}
                className="relative p-6 sm:p-8 rounded-2xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 shadow-xs flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <span className="text-xs font-mono font-bold text-brand-600 dark:text-brand-400 px-2.5 py-1 rounded-md bg-brand-50 dark:bg-brand-950/60 border border-brand-200 dark:border-brand-900">
                      {st.num}
                    </span>
                    <Icon className="w-6 h-6 text-brand-600 dark:text-brand-400" />
                  </div>
                  <h3 className="text-lg font-bold text-ink-900 dark:text-ink-50 mb-2">
                    {st.title}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                    {st.desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20 sm:py-28 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-gray-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-ink-900 dark:text-ink-50 mb-3">
            {t('featuresTitle')}
          </h2>
          <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400">
            {t('featuresSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feat, idx) => {
            const Icon = feat.icon;
            return (
              <div
                key={idx}
                className="p-6 rounded-2xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 shadow-xs hover:border-brand-500/50 transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 flex items-center justify-center mb-4">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="text-base font-bold text-ink-900 dark:text-ink-50 mb-2">
                  {feat.title}
                </h3>
                <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                  {feat.desc}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* AI Providers Row */}
      <section className="py-16 sm:py-20 max-w-7xl mx-auto px-4 sm:px-6 w-full border-b border-gray-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-xl sm:text-2xl font-extrabold text-ink-900 dark:text-ink-50 mb-2">
            {t('providersTitle')}
          </h2>
          <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-400">
            {t('providersSubtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {providers.map((p) => (
            <div
              key={p.name}
              className="p-6 rounded-xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 text-center"
            >
              <h3 className="font-bold text-lg text-ink-900 dark:text-ink-50 mb-1">
                {p.name}
              </h3>
              <p className="text-xs text-brand-600 dark:text-brand-400 font-mono">
                {p.models}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ Section */}
      <section className="py-20 sm:py-28 max-w-4xl mx-auto px-4 sm:px-6 w-full border-b border-gray-200 dark:border-ink-800">
        <div className="text-center max-w-2xl mx-auto mb-16">
          <div className="inline-flex items-center gap-1.5 p-2 rounded-xl bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 mb-3">
            <HelpCircle className="w-5 h-5" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-ink-900 dark:text-ink-50 mb-3">
            {t('faqTitle')}
          </h2>
          <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400">
            {t('faqSubtitle')}
          </p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              className="p-6 rounded-xl bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 shadow-xs"
            >
              <h3 className="text-base font-bold text-ink-900 dark:text-ink-50 mb-2">
                {faq.q}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                {faq.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Bottom Banner */}
      <section className="py-16 sm:py-24 bg-linear-to-r from-brand-700 to-brand-900 text-white text-center px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-4xl font-extrabold mb-4">
            {t('ctaBannerTitle')}
          </h2>
          <p className="text-sm sm:text-base text-brand-100 mb-8 max-w-xl mx-auto">
            {t('ctaBannerSubtitle')}
          </p>
          <Link
            to="/login"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white hover:bg-gray-100 text-brand-800 font-bold text-sm shadow-md transition-colors"
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
