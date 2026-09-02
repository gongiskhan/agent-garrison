// Own-port mount of the Conversations UI. The application lives in
// @garrison/talk/ui; this file only puts it on the page.
import { createRoot } from "react-dom/client";
import { TalkApp } from "@garrison/talk/ui";

const root = createRoot(document.getElementById("root")!);
root.render(<TalkApp />);
