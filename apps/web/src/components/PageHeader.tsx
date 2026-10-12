import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  badge?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, action, badge, className = '' }: PageHeaderProps) {
  return (
    <div className={`pt-2 sm:pt-4 pb-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 ${className}`}>
      <div className="space-y-1.5 min-w-0">
        {badge && <div className="mb-2">{badge}</div>}
        <h1 className="font-serif text-3xl sm:text-4xl font-bold tracking-tight text-ink-900 dark:text-ink-50">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm sm:text-[15px] text-ink-500 dark:text-ink-400 font-sans max-w-2xl leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0 flex items-center gap-3 pt-1">{action}</div>}
    </div>
  );
}
