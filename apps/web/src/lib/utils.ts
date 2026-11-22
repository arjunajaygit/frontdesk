import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The design system's named type scale (index.css @theme --text-*). Without this, tailwind-merge would read
// `text-body` as a colour and drop it when merged with `text-ink`.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['caption', 'meta', 'body', 'ui', 'title', 'heading', 'display'] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
