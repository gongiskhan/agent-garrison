import { MusterPage } from "@/components/muster/MusterPage";

// D12 - the Muster page: the one shell-owned top-level surface where the whole
// system is configured. S5a builds the shell + header + Duties section; the
// Standing Fittings section (S5b) and the Orchestrator panel (S5c) land later.
export default function Muster() {
  return <MusterPage />;
}
