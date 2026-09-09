import React, { type ReactNode } from "react";

export function PushNotice({ text, kind = "notice", onDismiss }: { text: ReactNode; kind?: "notice" | "toast"; onDismiss: () => void }) {
  return <div className={kind === "toast" ? "wc-push-toast" : "wc-push-notice"} role="status">
    <span>{text}</span>
    <button type="button" onClick={onDismiss} aria-label={kind === "toast" ? "Dismiss notification" : "Dismiss notification notice"}>×</button>
  </div>;
}
