export interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const WORDMARK_HEIGHT = { sm: 'h-6', md: 'h-8', lg: 'h-11' } as const;
const MARK_SIZE = { sm: 'h-6 w-6', md: 'h-8 w-8', lg: 'h-10 w-10' } as const;

/**
 * The owner's original artwork (transparent PNGs in public/brand). The dark-mode files recolor
 * the ink parts to a light ink so "Pilot" and the P stay readable on dark backgrounds.
 */
export function Logo({ size = 'md', showWordmark = true, className = '' }: LogoProps) {
  const [light, dark, dims] = showWordmark
    ? ['/brand/logo.png', '/brand/logo-dark.png', `${WORDMARK_HEIGHT[size]} w-auto`]
    : ['/brand/mark.png', '/brand/mark-dark.png', MARK_SIZE[size]];

  return (
    <span dir="ltr" className={`inline-flex items-center select-none ${className}`}>
      <img src={light} alt="MergePilot" className={`${dims} dark:hidden`} draggable={false} />
      <img
        src={dark}
        alt="MergePilot"
        className={`${dims} hidden dark:block`}
        draggable={false}
      />
    </span>
  );
}
