"use client";

import { PanelLeft } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

const Ctx = createContext<{ open: boolean; setOpen: (o: boolean) => void } | null>(null);

export function MobileNavProvider({ sidebar, children }: { sidebar: (close: () => void) => ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Ctx.Provider value={{ open, setOpen }}>
      {children}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar(() => setOpen(false))}
        </SheetContent>
      </Sheet>
    </Ctx.Provider>
  );
}

export function MobileNavTrigger() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={() => ctx.setOpen(true)}>
      <PanelLeft />
    </Button>
  );
}
