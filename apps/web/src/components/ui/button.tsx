import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const button = cva(
  'inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55',
  {
    variants: {
      variant: {
        primary: 'border-brand bg-brand text-white hover:bg-brand-hover',
        secondary: 'border-line-strong bg-surface text-ink hover:bg-canvas',
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-canvas',
        danger: 'border-danger bg-danger text-white hover:bg-danger-ink',
        note: 'border-warn bg-warn text-white hover:bg-warn-ink',
        nav: 'border-transparent bg-transparent text-nav-text hover:bg-nav-2',
      },
      size: { md: '', sm: 'min-h-8 px-2.5 text-xs', lg: 'min-h-11 px-4 text-sm', icon: 'min-h-9 w-9 px-0' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} type={asChild ? undefined : (type ?? 'button')} className={cn(button({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';
