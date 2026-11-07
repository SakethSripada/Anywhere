"use client";

import { Toast as T } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconAlert, IconCheck, IconClose, IconInfo } from "../icons";

/** App-wide toast manager so non-React code (API helpers) can notify too. */
export const toasts = T.createToastManager();

export const toast = {
  success: (title: ReactNode, description?: ReactNode) => toasts.add({ title, description, type: "success", timeout: 3500 }),
  error: (title: ReactNode, description?: ReactNode) =>
    toasts.add({ title, description, type: "error", timeout: 6000, priority: "high" }),
  info: (title: ReactNode, description?: ReactNode) => toasts.add({ title, description, type: "info", timeout: 4000 }),
};

const icon = {
  success: <IconCheck size={14} className="text-ok" />,
  error: <IconAlert size={14} className="text-bad" />,
  info: <IconInfo size={14} className="text-busy" />,
};

function ToastList() {
  const { toasts: list } = T.useToastManager();
  return list.map((t) => (
    <T.Root
      key={t.id}
      toast={t}
      swipeDirection={["right", "down"]}
      className={cn(
        "pointer-events-auto relative w-full select-none rounded-xl bg-overlay p-3 pr-9 shadow-overlay",
        "[transform:translate(var(--toast-swipe-movement-x),var(--toast-swipe-movement-y))]",
        "transition-[transform,opacity] duration-250 ease-out",
        "data-[starting-style]:translate-y-3 data-[starting-style]:opacity-0",
        "data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[limited]:opacity-0",
      )}
    >
      <T.Content className="flex gap-2.5">
        {t.type && t.type in icon && (
          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/5">
            {icon[t.type as keyof typeof icon]}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <T.Title className="text-sm font-medium text-fg" />
          <T.Description className="mt-0.5 text-xs text-fg-subtle empty:hidden" />
        </div>
        <T.Close
          aria-label="Dismiss"
          className="absolute top-2.5 right-2.5 grid size-5 place-items-center rounded-sm text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <IconClose size={12} />
        </T.Close>
      </T.Content>
    </T.Root>
  ));
}

export function Toaster({ children }: { children: ReactNode }) {
  return (
    <T.Provider toastManager={toasts} limit={3}>
      {children}
      <T.Portal>
        <T.Viewport className="fixed right-4 bottom-4 z-[70] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none sm:right-6 sm:bottom-6">
          <ToastList />
        </T.Viewport>
      </T.Portal>
    </T.Provider>
  );
}
