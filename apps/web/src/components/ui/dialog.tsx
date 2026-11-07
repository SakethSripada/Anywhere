"use client";

import { Dialog as D } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconClose } from "../icons";
import { IconButton } from "./button";

export const DialogRoot = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
  size = "md",
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <D.Portal>
      <D.Backdrop
        className={
          "fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] transition-opacity duration-200 ease-out " +
          "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0"
        }
      />
      <D.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
        <D.Popup
          className={cn(
            "relative w-full rounded-xl bg-surface shadow-overlay outline-none",
            "transition-[transform,opacity] duration-200 ease-out",
            "data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[ending-style]:duration-150",
            size === "sm" && "max-w-sm",
            size === "md" && "max-w-lg",
            size === "lg" && "max-w-2xl",
            className,
          )}
        >
          <div className="flex items-start gap-4 px-5 pt-5 pb-1">
            <div className="min-w-0 flex-1">
              <D.Title className="text-md font-semibold tracking-tight text-fg">{title}</D.Title>
              {description && (
                <D.Description className="mt-1 text-sm text-fg-subtle">{description}</D.Description>
              )}
            </div>
            <D.Close render={<IconButton label="Close" size="sm" className="-mt-1 -mr-1.5" />}>
              <IconClose />
            </D.Close>
          </div>
          {children && <div className="px-5 py-4">{children}</div>}
          {footer && (
            <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-line bg-canvas/40 px-5 py-3">
              {footer}
            </div>
          )}
        </D.Popup>
      </D.Viewport>
    </D.Portal>
  );
}
