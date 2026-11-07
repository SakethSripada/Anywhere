import type { Metadata } from "next";
import { MachineList } from "@/components/machines/machine-list";

export const metadata: Metadata = { title: "Machines" };

export default function MachinesPage() {
  return <MachineList />;
}
