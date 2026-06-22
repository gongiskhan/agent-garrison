import { redirect } from "next/navigation";

// The Armory folded into the Composition surface: Fitting discovery is now the
// search box on /compose (it spans every Faculty). /armory redirects there so
// old links keep working.
export default function ArmoryPage() {
  redirect("/compose");
}
