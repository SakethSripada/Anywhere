"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const inputBase =
  "w-full rounded-md bg-canvas/60 px-2.5 text-sm text-fg placeholder:text-fg-faint " +
  "shadow-[inset_0_0_0_1px_var(--color-line-strong),inset_0_1px_2px_oklch(0_0_0/0.25)] " +
  "transition-[box-shadow,background-color] duration-150 ease-out outline-none " +
  "hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.18),inset_0_1px_2px_oklch(0_0_0/0.25)] " +
  "focus:bg-canvas focus:shadow-[inset_0_0_0_1px_var(--color-accent-line),0_0_0_3px_var(--color-accent-soft)] " +
  "disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--color-bad)]";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode; trailing?: ReactNode }>(
  function Input({ className, leading, trailing, ...props }, ref) {
    if (!leading && !trailing) return <input ref={ref} className={cn(inputBase, "h-8", className)} {...props} />;
    return (
      <div className="relative flex items-center">
        {leading && (
          <span className="pointer-events-none absolute left-2.5 flex text-fg-faint [&_svg]:size-3.5">{leading}</span>
        )}
        <input ref={ref} className={cn(inputBase, "h-8", leading && "pl-8", trailing && "pr-14", className)} {...props} />
        {trailing && <span className="absolute right-2.5 flex text-xs text-fg-faint">{trailing}</span>}
      </div>
    );
  },
);

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-bad">{error}</p>
      ) : (
        hint && <p className="text-xs text-fg-faint">{hint}</p>
      )}
    </div>
  );
}
