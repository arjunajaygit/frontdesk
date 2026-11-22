import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** One button vocabulary for the whole product. Heights: sm 32px, md 36px, lg 44px (comfortable tap targets). */
export const buttonStyles = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'border-brand bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(15_118_110/0.25)] hover:border-brand-hover hover:bg-brand-hover',
        secondary: 'border-line-strong bg-surface text-ink shadow-xs hover:border-ink-3/40 hover:bg-surface-2',
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-ink/[0.05] hover:text-ink',
        danger: 'border-danger bg-danger text-white shadow-xs hover:bg-danger-ink',
        note: 'border-note bg-note text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(161_92_7/0.25)] hover:bg-note-ink',
      },
      size: {
        sm: 'h-8 px-2.5 text-meta',
        md: 'h-9 px-3 text-body',
        lg: 'h-11 px-4 text-ui',
        icon: 'h-9 w-9 px-0',
        'icon-sm': 'h-8 w-8 px-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} type={asChild ? undefined : (type ?? 'button')} className={cn(buttonStyles({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';
