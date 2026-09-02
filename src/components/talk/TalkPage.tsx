"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { MessagesSquare } from "lucide-react";
// Base layers first, the Garrison skin last, same order the web-channel-default
// fitting concatenates them in (ui/build.mjs): the skin overrides on equal
// specificity, so it has to come after the component stylesheet.
import "@xterm/xterm/css/xterm.css";
import "@garrison/claude-chat/styles.css";
import "@garrison/talk/ui/styles.css";
import "./talk-page.css";
import { nativeCapture } from "@/lib/native-bridge";
import { useNativeBridge } from "@/components/capture/BridgeGate";
import { useAppBar } from "@/components/chrome/AppBar";

// Browser-only: the conversations UI reads window.location for its thread /
// context query contract and drives MediaRecorder, the service worker and the
// clipboard. Rendering it on the server would only produce markup the client
// immediately replaces.
const TalkApp = dynamic(() => import("@garrison/talk/ui"), {
  ssr: false,
  loading: () => <div className="talk-page-loading" aria-busy="true" />
});

export interface TalkPageProps {
  /** Thread to open, from the /talk/<conversationId> route. */
  thread?: string;
}

export function TalkPage({ thread }: TalkPageProps) {
  // In the Garrison app the composer gets the record button (G5); the bridge
  // is the shell's one native-capture module, handed in so the talk package
  // never reads window.Capacitor itself.
  const native = useNativeBridge() === true;
  // Phone: the shell's app bar is the one header. The page contributes its name
  // and a threads button that flips the talk drawer through a counter prop, so
  // the talk UI's own floating toggle can stay hidden under the shell.
  const [threadsToggle, setThreadsToggle] = useState(0);
  const flipThreads = useCallback(() => setThreadsToggle((n) => n + 1), []);
  const actions = useMemo(
    () => (
      <button type="button" className="app-bar-btn" aria-label="Threads" title="Threads" onClick={flipThreads}>
        <MessagesSquare size={20} aria-hidden />
      </button>
    ),
    [flipThreads]
  );
  useAppBar({ title: "Conversations", actions });
  return (
    <div className="talk-host talk-page">
      <TalkApp thread={thread} captureBridge={native ? nativeCapture : null} threadsToggle={threadsToggle} />
    </div>
  );
}
