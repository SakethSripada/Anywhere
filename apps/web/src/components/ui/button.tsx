"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

const base =
  "group/button relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium " +
  "transition-[background-color,box-shadow,color,transform,opacity] duration-150 ease-out " +
  "focus-ring active:not-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-45";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-[inset_0_1px_0_0_oklch(1_0_0/0.28),inset_0_-1px_0_0_oklch(0_0_0/0.12),0_1px_2px_oklch(0_0_0/0.35)] " +
    "hover:bg-accent-hover",
  secondary:
    "bg-raised text-fg shadow-[inset_0_1px_0_0_oklch(1_0_0/0.06),0_0_0_1px_var(--color-line-strong),0_1px_2px_oklch(0_0_0/0.3)] " +
    "hover:bg-overlay",
  outline: "text-fg-muted shadow-[0_0_0_1px_var(--color-line-strong)] hover:bg-hover hover:text-fg",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-press",
  danger:
    "bg-bad-soft text-bad shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-bad)_30%,transparent)] hover:bg-bad/20",
};

const sizes: Record<Size, string> = {
  xs: "h-6 rounded-sm px-2 text-xs [&_svg]:size-3.5",
  sm: "h-7 rounded-md px-2.5 text-sm [&_svg]:size-3.5",
  md: "h-8 rounded-md px-3 text-sm [&_svg]:size-4",
  lg: "h-10 rounded-lg px-4 text-base [&_svg]:size-4",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, leading, trailing, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <span className={cn("contents", loading && "invisible")}>
        {leading}
        {children}
        {trailing}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={14} />
        </span>
      )}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "xs" | "sm" | "md";
  variant?: "ghost" | "secondary";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "sm", variant = "ghost", className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        base,
        variant === "ghost" ? variants.ghost : variants.secondary,
        size === "xs" && "size-6 rounded-sm [&_svg]:size-3.5",
        size === "sm" && "size-7 rounded-md [&_svg]:size-4",
        size === "md" && "size-8 rounded-md [&_svg]:size-4",
        "data-[popup-open]:bg-selected data-[popup-open]:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
