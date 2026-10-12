export interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const WORDMARK_HEIGHT = { sm: 'h-5 sm:h-6', md: 'h-6 sm:h-8', lg: 'h-9 sm:h-11' } as const;
const MARK_SIZE = { sm: 'h-6 w-6', md: 'h-8 w-8', lg: 'h-10 w-10' } as const;

/**
 * The owner's original artwork (transparent PNGs in public/brand). One <img> inside a <picture>:
 * the browser swaps to the dark-mode file (light ink, so "Pilot" and the P stay readable) when the
 * system is in dark mode, the same signal the stylesheet uses.
 */
export function Logo({ size = 'md', showWordmark = true, className = '' }: LogoProps) {
  const [light, dark, dims] = showWordmark
    ? ['/brand/logo.png', '/brand/logo-dark.png', `${WORDMARK_HEIGHT[size]} w-auto`]
    : ['/brand/mark.png', '/brand/mark-dark.png', MARK_SIZE[size]];

  return (
    <picture dir="ltr" className={`inline-flex min-w-0 items-center select-none ${className}`}>
      <source srcSet={dark} media="(prefers-color-scheme: dark)" />
      <img src={light} alt="MergePilot" className={`${dims} max-w-full`} draggable={false} />
    </picture>
  );
}
