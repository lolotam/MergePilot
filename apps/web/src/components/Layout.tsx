import { useState, useRef, useEffect } from 'react';
import { Outlet, Link, NavLink, useNavigate, useParams, useLocation } from 'react-router';
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
  Shield,
  Menu,
  X,
  ExternalLink,
  ChevronRight,
  GitBranch,
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
  const location = useLocation();
  const navigate = useNavigate();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      navigate('/login');
    }
  };

  // Determine section and current page for breadcrumb
  const isPlatformAdminRoute = location.pathname.startsWith('/admin');
  const sectionName = isPlatformAdminRoute
    ? t('navAdmin')
    : currentWorkspace?.name ?? t('sectionWorkspace');

  let currentPageName = t('navOverview');
  if (isPlatformAdminRoute) {
    currentPageName = t('navAdmin');
  } else if (location.pathname.endsWith('/repos')) {
    currentPageName = t('navRepos');
  } else if (location.pathname.endsWith('/runs')) {
    currentPageName = t('navRuns');
  } else if (location.pathname.endsWith('/team')) {
    currentPageName = t('navTeam');
  } else if (location.pathname.endsWith('/settings')) {
    currentPageName = t('navSettings');
  }

  const navLinks = currentWorkspace
    ? [
        { to: `/w/${currentWorkspace.id}`, end: true, icon: LayoutDashboard, label: t('navOverview') },
        { to: `/w/${currentWorkspace.id}/repos`, end: false, icon: FolderGit2, label: t('navRepos') },
        { to: `/w/${currentWorkspace.id}/runs`, end: false, icon: ListTodo, label: t('navRuns') },
        { to: `/w/${currentWorkspace.id}/team`, end: false, icon: Users, label: t('navTeam') },
        { to: `/w/${currentWorkspace.id}/settings`, end: false, icon: Settings, label: t('navSettings') },
      ]
    : [];

  const sidebarContent = (
    <div className="flex flex-col h-full justify-between">
      {/* Top: Logo & Workspace Switcher */}
      <div className="space-y-5">
        <div className="px-2 pt-1 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
            <Logo size="sm" />
          </Link>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label={t('close')}
            className="md:hidden p-1.5 rounded-full text-ink-500 hover:text-ink-800 dark:hover:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Workspace Switcher */}
        {currentWorkspace && (
          <div className="relative px-1" ref={workspaceMenuRef}>
            <button
              type="button"
              onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
              aria-expanded={workspaceMenuOpen}
              aria-label={t('switchWorkspace')}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium rounded-full bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-brand-500 shrink-0" />
                <span className="truncate">{currentWorkspace.name}</span>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-ink-400 shrink-0" />
            </button>

            {workspaceMenuOpen && (
              <div className="absolute start-1 end-1 mt-1.5 rounded-xl shadow-lg bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 py-1.5 z-50 animate-in fade-in">
                <div className="px-3 py-1.5 text-[10px] font-bold text-ink-400 uppercase tracking-wider">
                  {t('switchWorkspace')}
                </div>
                {workspaces.map((ws) => (
                  <Link
                    key={ws.id}
                    to={`/w/${ws.id}`}
                    onClick={() => setWorkspaceMenuOpen(false)}
                    className={`flex items-center justify-between px-3 py-2 text-xs hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors ${
                      ws.id === currentWorkspace.id
                        ? 'font-bold text-brand-700 dark:text-brand-400 bg-brand-50/50 dark:bg-brand-950/40'
                        : 'text-ink-700 dark:text-ink-300'
                    }`}
                  >
                    <span className="truncate">{ws.name}</span>
                    <span className="text-[10px] text-ink-400 capitalize">
                      {ws.role === 'owner' ? t('roleOwner') : ws.role === 'admin' ? t('roleAdmin') : t('roleMember')}
                    </span>
                  </Link>
                ))}
                <div className="border-t border-ink-200 dark:border-ink-800 my-1" />
                <Link
                  to="/"
                  onClick={() => setWorkspaceMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-xs text-brand-700 dark:text-brand-400 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t('createWorkspace')}</span>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Navigation List */}
        <nav className="space-y-1 px-1" aria-label="Main Navigation">
          {navLinks.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 py-2.5 text-xs font-medium rounded-full transition-all ${
                    isActive
                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 font-semibold'
                      : 'text-ink-600 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-100 hover:bg-ink-100/60 dark:hover:bg-ink-800/50'
                  }`
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* Bottom: Highlighted CTA Pill & Pinned User Menu */}
      <div className="space-y-3 px-1 pt-4 border-t border-ink-200/80 dark:border-ink-800">
        {/* Highlighted CTA Pill with subtle gradient border */}
        {currentWorkspace && (
          <div className="p-[1px] rounded-full bg-linear-to-r from-brand-500 via-brand-400 to-brand-600 shadow-xs">
            <Link
              to={`/w/${currentWorkspace.id}/repos`}
              className="flex items-center justify-between gap-2 px-3.5 py-2 text-xs font-semibold rounded-full bg-white dark:bg-ink-900 text-brand-700 dark:text-brand-300 hover:bg-brand-50/70 dark:hover:bg-ink-800 transition-colors"
            >
              <div className="flex items-center gap-2 truncate">
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-brand-600 dark:text-brand-400" />
                <span className="truncate">{t('installGitHubApp')}</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-brand-500 shrink-0" />
            </Link>
          </div>
        )}

        {/* User Avatar + Name + Menu */}
        {meData?.user && (
          <div className="relative" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              aria-label={t('signedInAs')}
              className="w-full flex items-center justify-between gap-2.5 p-2 rounded-full hover:bg-ink-100/70 dark:hover:bg-ink-800/70 transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {meData.user.image ? (
                  <img
                    src={meData.user.image}
                    alt={meData.user.name || meData.user.email}
                    className="w-7 h-7 rounded-full object-cover shrink-0"
                  />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center font-bold text-xs shrink-0">
                    {meData.user.name ? meData.user.name.charAt(0).toUpperCase() : <User className="w-3.5 h-3.5" />}
                  </div>
                )}
                <div className="text-start min-w-0">
                  <p className="text-xs font-semibold text-ink-900 dark:text-ink-100 truncate">
                    {meData.user.name || meData.user.email}
                  </p>
                </div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-ink-400 shrink-0" />
            </button>

            {userMenuOpen && (
              <div
                role="menu"
                className="absolute start-0 end-0 bottom-full mb-2 rounded-xl shadow-xl bg-white dark:bg-ink-900 border border-ink-200 dark:border-ink-700 py-1.5 z-50 animate-in fade-in"
              >
                <div className="px-3 py-2 text-xs border-b border-ink-200 dark:border-ink-800">
                  <p className="font-semibold text-ink-900 dark:text-ink-100 truncate">
                    {meData.user.name || meData.user.email}
                  </p>
                  <p className="text-[11px] text-ink-500 dark:text-ink-400 truncate">{meData.user.email}</p>
                </div>

                {meData.isPlatformAdmin && (
                  <Link
                    to="/admin"
                    role="menuitem"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-2 text-xs text-brand-700 dark:text-brand-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors font-medium"
                  >
                    <Shield className="w-3.5 h-3.5" />
                    <span>{t('navAdmin')}</span>
                  </Link>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSignOut}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 text-start transition-colors font-medium"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{t('signOut')}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FBFBFA] dark:bg-ink-950 text-ink-800 dark:text-ink-100 flex flex-col font-sans">
      {/* Mobile Top Header (<= 768px) */}
      <header className="md:hidden sticky top-0 z-40 bg-[#FBFBFA]/90 dark:bg-ink-900/90 backdrop-blur-md border-b border-ink-200 dark:border-ink-800 px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-expanded={mobileMenuOpen}
            aria-label={t('menuToggle')}
            className="p-1.5 rounded-full text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <Link to="/" className="flex items-center gap-2" aria-label={t('appName')}>
            <Logo size="sm" />
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLanguage}
            aria-label={t('languageToggle')}
            className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>{t('languageToggle')}</span>
          </button>
        </div>
      </header>

      {/* Mobile Drawer (<= 768px) */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-xs md:hidden animate-in fade-in"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside
            data-testid="mobile-drawer"
            className="fixed inset-y-0 start-0 z-50 w-64 bg-[#FBFBFA] dark:bg-ink-950 border-e border-ink-200 dark:border-ink-800 p-4 shadow-2xl md:hidden animate-in slide-in-from-start"
          >
            {sidebarContent}
          </aside>
        </>
      )}

      {/* Desktop Fixed Start Sidebar (~240px) */}
      <aside className="hidden md:flex md:w-60 md:flex-col md:fixed md:inset-y-0 md:start-0 bg-[#FBFBFA] dark:bg-ink-950 border-e border-ink-200 dark:border-ink-800 z-30 p-4">
        {/* One sidebar instance at a time: the menus' outside-click refs must point at the visible copy. */}
        {!mobileMenuOpen && sidebarContent}
      </aside>

      {/* Main Column */}
      <div className="md:ps-60 flex-1 flex flex-col min-h-screen">
        {/* Desktop Top Bar */}
        <header className="hidden md:flex sticky top-0 z-20 bg-[#FBFBFA]/80 dark:bg-ink-950/80 backdrop-blur-md border-b border-ink-200 dark:border-ink-800 h-14 sm:h-16 px-4 sm:px-6 items-center justify-between">
          {/* Breadcrumb: Section / Page */}
          <nav aria-label={t('breadcrumb')} className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-500 dark:text-ink-400 font-medium truncate max-w-[150px] sm:max-w-[200px]">
              {sectionName}
            </span>
            <span className="text-ink-300 dark:text-ink-600">/</span>
            <span className="font-semibold text-ink-900 dark:text-ink-100">{currentPageName}</span>
          </nav>

          {/* Right actions: Language toggle and GitHub link */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('languageToggle')}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              <span>{t('languageToggle')}</span>
            </button>

            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-ink-500 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-100 transition-colors"
            >
              <span>{t('viewOnGitHub')}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6">
          <Outlet />
        </main>

        {/* Dashboard Footer */}
        <Footer />
      </div>
    </div>
  );
}
