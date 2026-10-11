import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { I18nProvider } from './i18n/context.js';
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
      <I18nProvider initialLanguage="ar">
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/install" element={<InstallPage />} />
              <Route element={<Layout />}>
                <Route path="/" element={<RootRedirectPage />} />
                <Route path="/w/:workspaceId" element={<OverviewPage />} />
                <Route path="/w/:workspaceId/repos" element={<ReposPage />} />
                <Route path="/w/:workspaceId/settings" element={<SettingsPage />} />
                <Route path="/w/:workspaceId/team" element={<TeamPage />} />
                <Route path="/w/:workspaceId/runs" element={<RunsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
