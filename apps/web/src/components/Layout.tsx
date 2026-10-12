import { useState, useRef, useEffect } from 'react';
import { Outlet, Link, NavLink, useNavigate, useParams } from 'react-router';
import {
  LayoutDashboard,
  FolderGit2,
  ListTodo,
  Users,
  Settings,
  Globe,
  LogOut,
  ChevronDown,
  Plus,
  User,
} from 'lucide-react';
import { useI18n } from '../i18n/context.js';
import { useMeQuery } from '../api/hooks.js';
import { authClient } from '../auth/client.js';
import { Logo } from './Logo.js';
import { Footer } from './Footer.js';

export function Layout() {
  const { t, toggleLanguage } = useI18n();
  const { data: meData } = useMeQuery();
  const { workspaceId } = useParams();
  const navigate = useNavigate();

  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const workspaces = meData?.workspaces ?? [];
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      navigate('/login');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-ink-950 text-ink-800 dark:text-ink-100 flex flex-col font-sans">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/90 dark:bg-ink-900/90 backdrop-blur-md border-b border-gray-200 dark:border-ink-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-2">
          {/* Logo & Workspace Switcher */}
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
              <Logo size="sm" />
            </Link>

            {currentWorkspace && (
              <div className="relative" ref={workspaceMenuRef}>
                <button
                  type="button"
                  onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
                  aria-expanded={workspaceMenuOpen}
                  aria-label={t('switchWorkspace')}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-gray-100 dark:bg-ink-800 hover:bg-gray-200 dark:hover:bg-ink-750 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
                >
                  <span className="truncate max-w-[120px] sm:max-w-[180px]">{currentWorkspace.name}</span>
                  <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400 shrink-0" />
                </button>

                {workspaceMenuOpen && (
                  <div className="absolute start-0 mt-2 w-56 rounded-md shadow-lg bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 py-1 z-50 animate-in fade-in">
                    <div className="px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      {t('switchWorkspace')}
                    </div>
                    {workspaces.map((ws) => (
                      <Link
                        key={ws.id}
                        to={`/w/${ws.id}`}
                        onClick={() => setWorkspaceMenuOpen(false)}
                        className={`flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-ink-800 transition-colors ${
                          ws.id === currentWorkspace.id ? 'font-bold text-brand-600 dark:text-brand-400' : ''
                        }`}
                      >
                        <span className="truncate">{ws.name}</span>
                        <span className="text-xs text-gray-400 capitalize">
                          {ws.role === 'owner' ? t('roleOwner') : ws.role === 'admin' ? t('roleAdmin') : t('roleMember')}
                        </span>
                      </Link>
                    ))}
                    <div className="border-t border-gray-200 dark:border-ink-800 my-1" />
                    <Link
                      to="/"
                      onClick={() => setWorkspaceMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-brand-600 dark:text-brand-400 hover:bg-gray-100 dark:hover:bg-ink-800 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      <span>{t('createWorkspace')}</span>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right actions: Language toggle, User menu */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('languageToggle')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-ink-700 hover:bg-gray-100 dark:hover:bg-ink-800 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{t('languageToggle')}</span>
            </button>

            {meData?.user && (
              <div className="relative" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  aria-expanded={userMenuOpen}
                  aria-label={t('signedInAs')}
                  className="flex items-center gap-2 p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-ink-800 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
                >
                  {meData.user.image ? (
                    <img
                      src={meData.user.image}
                      alt={meData.user.name || meData.user.email}
                      className="w-7 h-7 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-950/60 text-brand-600 dark:text-brand-300 flex items-center justify-center font-bold text-xs">
                      {meData.user.name ? meData.user.name.charAt(0).toUpperCase() : <User className="w-4 h-4" />}
                    </div>
                  )}
                </button>

                {userMenuOpen && (
                  <div className="absolute end-0 mt-2 w-56 rounded-md shadow-lg bg-white dark:bg-ink-900 border border-gray-200 dark:border-ink-800 py-1 z-50 animate-in fade-in">
                    <div className="px-3 py-2 text-xs border-b border-gray-200 dark:border-ink-800">
                      <p className="font-semibold truncate">{meData.user.name || meData.user.email}</p>
                      <p className="text-gray-500 dark:text-gray-400 truncate">{meData.user.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-ink-800 text-start transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>{t('signOut')}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Workspace Subnavigation Tabs */}
        {workspaceId && (
          <div className="border-t border-gray-200 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-x-auto">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-6 text-sm">
              <NavLink
                to={`/w/${workspaceId}`}
                end
                className={({ isActive }) =>
                  `flex items-center gap-2 py-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`
                }
              >
                <LayoutDashboard className="w-4 h-4" />
                <span>{t('navOverview')}</span>
              </NavLink>

              <NavLink
                to={`/w/${workspaceId}/repos`}
                className={({ isActive }) =>
                  `flex items-center gap-2 py-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`
                }
              >
                <FolderGit2 className="w-4 h-4" />
                <span>{t('navRepos')}</span>
              </NavLink>

              <NavLink
                to={`/w/${workspaceId}/runs`}
                className={({ isActive }) =>
                  `flex items-center gap-2 py-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`
                }
              >
                <ListTodo className="w-4 h-4" />
                <span>{t('navRuns')}</span>
              </NavLink>

              <NavLink
                to={`/w/${workspaceId}/team`}
                className={({ isActive }) =>
                  `flex items-center gap-2 py-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`
                }
              >
                <Users className="w-4 h-4" />
                <span>{t('navTeam')}</span>
              </NavLink>

              <NavLink
                to={`/w/${workspaceId}/settings`}
                className={({ isActive }) =>
                  `flex items-center gap-2 py-3 border-b-2 font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400'
                      : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`
                }
              >
                <Settings className="w-4 h-4" />
                <span>{t('navSettings')}</span>
              </NavLink>
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>

      {/* Dashboard Footer */}
      <Footer />
    </div>
  );
}
