"use client";

import { Tooltip as T } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { Kbd } from "./kbd";

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delay={350} closeDelay={60}>
    {children}
  </T.Provider>
);

export function Tooltip({
  content,
  shortcut,
  side = "top",
  children,
}: {
  content: ReactNode;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <T.Root>
      <T.Trigger render={children} />
      <T.Portal>
        <T.Positioner side={side} sideOffset={8} className="z-[60]">
          <T.Popup
            className={
              "flex items-center gap-2 rounded-md bg-overlay px-2 py-1 text-xs font-medium text-fg shadow-overlay " +
              "origin-[var(--transform-origin)] transition-[transform,opacity] duration-120 ease-out " +
              "data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 " +
              "data-[instant]:transition-none"
            }
          >
            {content}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </T.Popup>
        </T.Positioner>
      </T.Portal>
    </T.Root>
  );
}
