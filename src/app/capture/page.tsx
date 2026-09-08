import { CapturePage } from "@/components/capture/CapturePage";

// The app's capture surface. Renders only inside the Garrison iOS app; a
// browser gets a one-line pointer. The route exists on every node so the
// sidebar entry (shown only with the native bridge) always resolves.
export default function Capture() {
  return <CapturePage />;
}
