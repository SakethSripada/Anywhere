"use client";

import { Menu as M } from "@base-ui/react/menu";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconCheck, IconChevronRight } from "../icons";
import { Kbd } from "./kbd";

export const MenuRoot = M.Root;
export const MenuTrigger = M.Trigger;

/** Shared popup surface for menus, selects and popovers. */
export const popupSurface =
  "rounded-lg bg-overlay shadow-overlay outline-none " +
  "origin-[var(--transform-origin)] transition-[transform,opacity] duration-150 ease-out " +
  "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 " +
  "data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[ending-style]:duration-100";

export function MenuContent({
  children,
  className,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  width = "w-56",
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  width?: string;
}) {
  return (
    <M.Portal>
      <M.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50 outline-none">
        <M.Popup className={cn(popupSurface, "p-1", width, className)}>{children}</M.Popup>
      </M.Positioner>
    </M.Portal>
  );
}

const itemBase =
  "relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2 text-sm text-fg-muted outline-none " +
  "transition-colors duration-75 data-[highlighted]:bg-hover data-[highlighted]:text-fg " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-subtle " +
  "data-[highlighted]:[&>svg]:text-fg-muted";

export function MenuItem({
  icon,
  shortcut,
  tone,
  className,
  children,
  ...props
}: ComponentProps<typeof M.Item> & { icon?: ReactNode; shortcut?: string; tone?: "danger" }) {
  return (
    <M.Item
      className={cn(
        itemBase,
        tone === "danger" &&
          "text-bad data-[highlighted]:bg-bad-soft data-[highlighted]:text-bad [&>svg]:text-bad/80 data-[highlighted]:[&>svg]:text-bad",
        className as string,
      )}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children as ReactNode}</span>
      {shortcut && <Kbd className="ml-auto">{shortcut}</Kbd>}
    </M.Item>
  );
}

export function MenuCheckboxItem({
  children,
  className,
  ...props
}: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn(itemBase, "pr-8", className as string)} {...props}>
      <span className="flex-1 truncate">{children as ReactNode}</span>
      <M.CheckboxItemIndicator className="absolute right-2 text-accent data-[unchecked]:hidden">
        <IconCheck size={14} />
      </M.CheckboxItemIndicator>
    </M.CheckboxItem>
  );
}

export function MenuRadioGroup(props: ComponentProps<typeof M.RadioGroup>) {
  return <M.RadioGroup {...props} />;
}

export function MenuRadioItem({ children, className, description, ...props }: ComponentProps<typeof M.RadioItem> & { description?: string }) {
  return (
    <M.RadioItem
      className={cn(itemBase, "h-auto min-h-8 py-1.5 pr-8", className as string)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children as ReactNode}</span>
        {description && <span className="truncate text-xs text-fg-subtle">{description}</span>}
      </span>
      <M.RadioItemIndicator className="absolute right-2 text-accent data-[unchecked]:hidden">
        <IconCheck size={14} />
      </M.RadioItemIndicator>
    </M.RadioItem>
  );
}

export function MenuSeparator() {
  return <M.Separator className="-mx-1 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <M.GroupLabel className="px-2 pt-1.5 pb-1 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">
      {children}
    </M.GroupLabel>
  );
}

export const MenuGroup = M.Group;

export function MenuSubmenu({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <M.SubmenuRoot>
      <M.SubmenuTrigger className={cn(itemBase, "data-[popup-open]:bg-hover data-[popup-open]:text-fg")}>
        {icon}
        <span className="flex-1">{label}</span>
        <IconChevronRight size={14} className="text-fg-faint" />
      </M.SubmenuTrigger>
      <M.Portal>
        <M.Positioner sideOffset={4} alignOffset={-4} className="z-50 outline-none">
          <M.Popup className={cn(popupSurface, "w-52 p-1")}>{children}</M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.SubmenuRoot>
  );
}
