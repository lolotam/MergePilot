import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { I18nProvider, useI18n } from './i18n/context.js';
import { ToastProvider } from './components/Toast.js';
import { Layout } from './components/Layout.js';
import { LoginPage } from './pages/LoginPage.js';
import { RootRedirectPage } from './pages/RootRedirectPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { ReposPage } from './pages/ReposPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TeamPage } from './pages/TeamPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { InstallPage } from './pages/InstallPage.js';
import { PrivacyPage } from './pages/PrivacyPage.js';
import { TermsPage } from './pages/TermsPage.js';

// Operator-only area: loaded on demand so regular users never download it.
const AdminPage = lazy(() => import('./admin/AdminPage.js'));
const RunDetailPage = lazy(() => import('./runs/RunDetailPage.js'));

function PageFallback() {
  const { t } = useI18n();
  return <div className="py-12 text-center text-sm text-gray-400">{t('loading')}</div>;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<RootRedirectPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/install" element={<InstallPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route element={<Layout />}>
                <Route path="/w/:workspaceId" element={<OverviewPage />} />
                <Route path="/w/:workspaceId/repos" element={<ReposPage />} />
                <Route path="/w/:workspaceId/settings" element={<SettingsPage />} />
                <Route path="/w/:workspaceId/team" element={<TeamPage />} />
                <Route path="/w/:workspaceId/runs" element={<RunsPage />} />
                <Route
                  path="/w/:workspaceId/runs/:runId"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <RunDetailPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <AdminPage />
                    </Suspense>
                  }
                />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
