import { redirect } from "next/navigation";

// D12 - the Compose grid folded into Muster: composing a system (duties, targets,
// standing Fittings, the Orchestrator prompt, the Runtimes) now happens on the
// one Muster page. /compose redirects there so old links / the sidebar entry keep
// working. The /armory → /compose → /muster chain is preserved (armory still
// redirects to /compose, which now lands on /muster).
export default function ComposePage() {
  redirect("/muster");
}
