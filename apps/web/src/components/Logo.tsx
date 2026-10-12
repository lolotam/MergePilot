export interface LogoProps {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}

const SIZE_CONFIG = {
  sm: {
    mark: 'w-6 h-6',
    text: 'text-base',
    gap: 'gap-2',
  },
  md: {
    mark: 'w-8 h-8',
    text: 'text-xl',
    gap: 'gap-2.5',
  },
  lg: {
    mark: 'w-10 h-10',
    text: 'text-2xl sm:text-3xl',
    gap: 'gap-3',
  },
};

export function Logo({ size = 'md', showWordmark = true, className = '' }: LogoProps) {
  const cfg = SIZE_CONFIG[size];

  return (
    <div
      dir="ltr"
      className={`inline-flex items-center ${cfg.gap} font-extrabold tracking-tight select-none text-start ${className}`}
    >
      <svg
        viewBox="90 74 1090 1090"
        className={`${cfg.mark} shrink-0`}
        aria-hidden="true"
        focusable="false"
      >
        {/* The 'M' part using brand green */}
        <path
          className="fill-brand-600 dark:fill-brand-500"
          d="M123 395 Q123 382 135 375 L198 340 Q210 334 222 342 L575 606 L742 514 Q765 503 765 528 L765 822 Q765 832 756 838 L643 925 Q624 938 624 915 L624 740 L556 786 Q546 792 536 785 L268 563 L268 862 Q268 885 248 872 L135 797 Q123 789 123 775 Z"
        />
        {/* The 'P' part using currentColor */}
        <path
          fill="currentColor"
          d="M480 470 Q472 464 480 457 L690 308 L962 308 A207 207 0 0 1 962 722 L822 722 Q812 722 812 712 L812 600 Q812 590 822 590 L940 590 A75 75 0 0 0 940 440 L752 440 L586 548 Q572 557 560 547 Z"
        />
      </svg>

      {showWordmark && (
        <span className={`${cfg.text} font-bold leading-none`}>
          <span className="text-brand-600 dark:text-brand-400">Merge</span>
          <span className="text-ink-800 dark:text-ink-100">Pilot</span>
        </span>
      )}
    </div>
  );
}
