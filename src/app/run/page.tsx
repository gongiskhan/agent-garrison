import { redirect } from "next/navigation";

// The Run panel merged into the Garrison dashboard (the home route). /run is
// kept as a redirect so old links / bookmarks still land on the run console.
export default function RunPage() {
  redirect("/");
}
