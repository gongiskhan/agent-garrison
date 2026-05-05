"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  Circle,
  Command,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RadioTower,
  Save,
  Send,
  ShieldCheck,
  Square,
  Star,
  Terminal,
  Trash2,
  Unlock,
  Wrench,
  X
} from "lucide-react";
import clsx from "clsx";
import { ExtensionPane } from "@/components/ExtensionPane";
import { FittingEditor } from "@/components/FittingEditor";
import { faculties } from "@/lib/faculties";
import type {
  FittingSelectionMap,
  ConfigSchemaField,
  GlobalConfig,
  LibraryEntry,
  FacultyId,
  RunnerState,
  SelectedFitting,
  VaultSecret,
  VerifyResult
} from "@/lib/types";

type Tab = "compose" | "run" | "chat" | "vault";

interface ChatAttachment {
  filename: string;
  path: string;
  bytes: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: ChatAttachment[];
  toolCalls?: { name: string; input?: unknown }[];
  status?: "pending" | "streaming" | "complete" | "error";
  costUsd?: number | null;
  errorText?: string;
}

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

interface CapabilityIssueView {
  fittingId: string;
  code: "missing-required" | "ambiguous-singleton" | "too-many-for-optional" | "unknown-kind";
  kind: string;
  name?: string;
  message: string;
}

interface CompositionView {
  id: string;
  name: string;
  directory: string;
  manifestPath: string;
  selections: FittingSelectionMap;
  globalConfig: GlobalConfig;
  derivedTasks?: {
    source: string;
    truthFile: string;
    fittingId: string;
  };
  capabilityIssues: CapabilityIssueView[];
}

const coreSeedIds = [
  "loop-heartbeat",
  "trello-data-source",
  "browser-automation",
  "memory",
  "tier-classifier",
  "http-gateway"
];

const facultyGroups: Array<{ label: string; ids: FacultyId[] }> = [
  { label: "Cadence", ids: ["heartbeat", "scheduler"] },
  { label: "Context", ids: ["data-sources", "knowledge-base", "memory"] },
  { label: "Action", ids: ["automations", "skills", "gateway", "channels"] },
  { label: "Control", ids: ["classifier", "observability", "soul", "orchestrator"] }
];

const facultyRoleCopy: Record<FacultyId, { role: string; fit: string }> = {
  heartbeat: {
    role: "Defines when the operative wakes up without a human prompt.",
    fit: "It triggers the gateway on a cadence, so routine work starts from the same entry point as inbound channel events."
  },
  scheduler: {
    role: "Handles scheduled work that is not part of the heartbeat loop.",
    fit: "Use this for one-off or calendar-like jobs that should not change the main wake cadence."
  },
  "data-sources": {
    role: "Feeds live external state into the operative.",
    fit: "Data sources are read paths. When Trello is selected, derived Tasks become Trello-backed automatically."
  },
  "knowledge-base": {
    role: "Provides static references the operative can read.",
    fit: "Use this for docs, codebases, policies, and project context that should inform work but not act as live integrations."
  },
  automations: {
    role: "Gives the operative tools that can act in the world.",
    fit: "Browser, desktop, or scripted UI control belongs here; testing can reuse these when it needs to drive an interface."
  },
  skills: {
    role: "Reusable capabilities the Operative can invoke during work.",
    fit: "A Fitting here exposes a skill — a procedure, helper, or test author — that the Orchestrator can call as a sub-agent or tool."
  },
  memory: {
    role: "Controls what the operative remembers within and across sessions.",
    fit: "A single memory Fitting owns recency, persistence cadence, and compiled memory output."
  },
  classifier: {
    role: "Classifies each prompt before work starts.",
    fit: "This is an operative Fitting, not a separate app surface. It sets the routing floor and escalation behavior."
  },
  gateway: {
    role: "Receives jobs from heartbeat, channels, and local test inputs.",
    fit: "The gateway is the MCP-speaking front door; public exposure remains a manual documented step in v1."
  },
  channels: {
    role: "Connects real user-facing message surfaces.",
    fit: "Slack, Discord, Telegram, WhatsApp, and custom UIs belong here. The Run test box is not a channel."
  },
  observability: {
    role: "Reports health, errors, no-ops, and runtime state.",
    fit: "Observability routes loop outcomes to logs or alert channels so silent failure is not treated as success."
  },
  soul: {
    role: "Defines identity, tone, voice, and boundaries.",
    fit: "The runner concatenates orchestrator first, then soul, to produce the system prompt passed to Claude Code."
  },
  orchestrator: {
    role: "Governs the operative's behavior.",
    fit: "This is the capstone. It coordinates Faculties, owns global config, and provides the behavioral spine."
  }
};

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("compose");
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [composition, setComposition] = useState<CompositionView | null>(null);
  const [runnerState, setRunnerState] = useState<RunnerState | null>(null);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [vaultNeedsPassword, setVaultNeedsPassword] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [secrets, setSecrets] = useState<VaultSecret[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingFitting, setEditingFitting] = useState<LibraryEntry | null>(null);
  const compositionId = composition?.id;

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!compositionId) {
      return;
    }
    const source = new EventSource(`/api/runner/${compositionId}/logs`);
    source.onmessage = (event) => {
      setLogs((current) => [...current.slice(-900), JSON.parse(event.data) as LogEvent]);
    };
    return () => source.close();
  }, [compositionId]);

  const selectedEntries = useMemo(() => {
    const selectedIds = new Set(
      Object.values(composition?.selections ?? {})
        .flatMap((items) => items ?? [])
        .map((item) => item.id)
    );
    return library.filter((entry) => selectedIds.has(entry.id));
  }, [composition?.selections, library]);

  const selectedCount = selectedEntries.length;
  const verifiedCount = (runnerState?.verifyResults ?? verifyResults).filter((result) => result.ok).length;
  const verifyTotal = (runnerState?.verifyResults ?? verifyResults).length;
  const isRunning = runnerState?.status === "running";
  const readiness = useMemo(
    () => computeReadiness(composition, selectedEntries, vaultUnlocked, vaultNeedsPassword, runnerState, verifyTotal, verifiedCount),
    [composition, selectedEntries, vaultUnlocked, vaultNeedsPassword, runnerState, verifyTotal, verifiedCount]
  );

  async function refreshAll() {
    setError(null);
    const [libraryResponse, compositionResponse, vaultResponse] = await Promise.all([
      fetch("/api/library"),
      fetch("/api/compositions"),
      fetch("/api/vault/secrets")
    ]);
    const libraryData = await readJson(libraryResponse);
    const compositionData = await readJson(compositionResponse);
    const vaultData = await readJson(vaultResponse);
    const nextComposition = compositionData.compositions[0] as CompositionView;
    setLibrary(libraryData.library);
    setComposition(nextComposition);
    setVaultUnlocked(Boolean(vaultData.unlocked));
    setVaultNeedsPassword(Boolean(vaultData.needsPassword));
    setSecrets(vaultData.secrets ?? []);
    const stateResponse = await fetch(`/api/runner/${nextComposition.id}/state`);
    setRunnerState((await readJson(stateResponse)).state);
  }

  async function saveComposition(next: Partial<CompositionView>) {
    if (!composition) {
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const response = await fetch(`/api/compositions/${composition.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: next.name ?? composition.name,
          selections: next.selections ?? composition.selections,
          globalConfig: next.globalConfig ?? composition.globalConfig
        })
      });
      const data = await readJson(response);
      setComposition(data.composition);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function runAction(action: "up" | "down" | "verify" | "dev") {
    if (!composition) {
      return;
    }
    setBusy(action);
    setError(null);
    if (action === "up" || action === "dev" || action === "verify") {
      setTab("run");
    }
    try {
      const response = await fetch(`/api/runner/${composition.id}/${action}`, { method: "POST" });
      const data = await readJson(response);
      if (data.state) {
        setRunnerState(data.state);
      }
      if (data.results) {
        setVerifyResults(data.results);
      }
      const stateResponse = await fetch(`/api/runner/${composition.id}/state`);
      setRunnerState((await readJson(stateResponse)).state);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
      const stateResponse = await fetch(`/api/runner/${composition.id}/state`);
      setRunnerState((await readJson(stateResponse)).state);
    } finally {
      setBusy(null);
    }
  }

  async function unlock() {
    setBusy("vault");
    setError(null);
    try {
      const response = await fetch("/api/vault/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase })
      });
      const data = await readJson(response);
      setVaultUnlocked(data.unlocked);
      setVaultNeedsPassword(Boolean(data.needsPassword));
      setSecrets(data.secrets ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function saveSecrets() {
    setBusy("secrets");
    setError(null);
    try {
      const response = await fetch("/api/vault/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets })
      });
      const data = await readJson(response);
      setSecrets(data.secrets ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  }

  async function openFittingSource(entry: LibraryEntry, kind: "local" | "repo") {
    setError(null);
    try {
      const response = await fetch("/api/library/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, kind })
      });
      await readJson(response);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  function selectedForFaculty(facultyId: FacultyId): SelectedFitting[] {
    return composition?.selections[facultyId] ?? [];
  }

  function entrySelection(entry: LibraryEntry): SelectedFitting | undefined {
    return selectedForFaculty(entry.faculty).find((selection) => selection.id === entry.id);
  }

  function setSingleSelection(facultyId: FacultyId, fittingId: string) {
    if (!composition) {
      return;
    }
    const entry = library.find((candidate) => candidate.id === fittingId);
    const selections = { ...composition.selections };
    if (!entry) {
      delete selections[facultyId];
    } else {
      selections[facultyId] = [defaultSelection(entry)];
    }
    void saveComposition({ selections });
  }

  function toggleMultiSelection(entry: LibraryEntry) {
    if (!composition) {
      return;
    }
    const current = selectedForFaculty(entry.faculty);
    const exists = current.some((selection) => selection.id === entry.id);
    const selections = { ...composition.selections };
    selections[entry.faculty] = exists
      ? current.filter((selection) => selection.id !== entry.id)
      : [...current, defaultSelection(entry)];
    if (selections[entry.faculty]?.length === 0) {
      delete selections[entry.faculty];
    }
    void saveComposition({ selections });
  }

  function loadSeedStack() {
    if (!composition) {
      return;
    }
    const selections: FittingSelectionMap = { ...composition.selections };
    for (const id of coreSeedIds) {
      const entry = library.find((candidate) => candidate.id === id);
      if (!entry) {
        continue;
      }
      const current = selections[entry.faculty] ?? [];
      if (entry.metadata.cardinality_hint === "single") {
        selections[entry.faculty] = [defaultSelection(entry)];
      } else if (!current.some((selection) => selection.id === entry.id)) {
        selections[entry.faculty] = [...current, defaultSelection(entry)];
      }
    }
    void saveComposition({ selections });
  }

  function updateConfig(entry: LibraryEntry, key: string, value: string | number | boolean) {
    if (!composition) {
      return;
    }
    const current = selectedForFaculty(entry.faculty);
    const selections = { ...composition.selections };
    selections[entry.faculty] = current.map((selection) =>
      selection.id === entry.id
        ? { ...selection, config: { ...selection.config, [key]: value } }
        : selection
    );
    setComposition({ ...composition, selections });
    void saveComposition({ selections });
  }

  if (!composition) {
    return (
      <main className="min-h-screen bg-[#121712] p-6 text-[#f3f0e7]">
        <div className="mx-auto mt-24 max-w-sm border border-[#d5c6a1]/30 bg-[#1b211d] p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <Loader2 className="animate-spin text-[#d8b35d]" size={18} />
            <span className="font-medium">Loading Agent Garrison</span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f2efe6] text-[#18211c]">
      <div className="fixed inset-0 pointer-events-none opacity-[0.36] [background-image:linear-gradient(rgba(24,33,28,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(24,33,28,0.045)_1px,transparent_1px)] [background-size:28px_28px]" />

      <div className="relative mx-auto grid min-w-0 max-w-[1500px] gap-3 px-3 py-3 md:grid-cols-[248px_1fr] md:gap-4 md:px-4 md:py-4">
        <aside className="min-w-0 md:sticky md:top-4 md:h-[calc(100vh-32px)]">
          <div className="min-w-0 border border-[#cfc6b8] bg-[#111814] text-[#f5f1e6] shadow-[0_24px_80px_rgba(24,33,28,0.24)] md:flex md:h-full md:flex-col">
            <div className="border-b border-[#f2efe6]/10 p-3 md:p-4">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center border border-[#d9b860]/70 bg-[#d9b860] text-[#111814]">
                  <Command size={20} />
                </div>
                <div>
                  <h1 className="text-lg font-semibold">Agent Garrison</h1>
                  <p className="text-xs text-[#b9c2b7]">local operative console</p>
                </div>
              </div>
            </div>

            <nav className="flex min-w-0 gap-1 overflow-x-auto p-2 md:grid md:gap-1 md:p-3">
              <TabButton active={tab === "compose"} icon={<Boxes size={17} />} label="Compose" onClick={() => setTab("compose")} />
              <TabButton active={tab === "run"} icon={<Terminal size={17} />} label="Run" onClick={() => setTab("run")} />
              <TabButton active={tab === "chat"} icon={<MessageSquare size={17} />} label="Chat" onClick={() => setTab("chat")} />
              <TabButton active={tab === "vault"} icon={<KeyRound size={17} />} label="Vault" onClick={() => setTab("vault")} />
            </nav>

            <div className="mt-auto hidden border-t border-[#f2efe6]/10 p-4 md:block">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-xs uppercase text-[#b9c2b7]">Runtime</span>
                <StatusPill label={runnerState?.status ?? "idle"} tone={statusTone(runnerState?.status)} />
              </div>
              <div className="grid gap-2 text-xs text-[#c8d0c6]">
                <div className="flex items-center justify-between">
                  <span>Fittings</span>
                  <strong className="text-[#f5f1e6]">{selectedCount}</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span>Verify</span>
                  <strong className="text-[#f5f1e6]">{verifyTotal ? `${verifiedCount}/${verifyTotal}` : "-"}</strong>
                </div>
                <div className="flex items-center justify-between">
                  <span>PID</span>
                  <strong className="text-[#f5f1e6]">{runnerState?.pid ?? "-"}</strong>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="mb-4 border border-[#cfc6b8] bg-[#fbfaf5] shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
            {vaultNeedsPassword ? (
              <button
                className="flex w-full items-center gap-2 border-b border-[#9b362d]/30 bg-[#9b362d] px-4 py-3 text-left text-sm font-semibold text-white"
                onClick={() => setTab("vault")}
              >
                <AlertTriangle size={17} />
                Vault is using the unsafe starter state. Define a vault password before storing secrets or running real work.
              </button>
            ) : null}
            <div className="grid gap-3 p-4 xl:grid-cols-[1fr_auto]">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="border border-[#18211c] bg-[#18211c] px-2 py-1 text-xs font-semibold uppercase text-white">
                    {composition.name}
                  </span>
                  <StatusPill label={runnerState?.status ?? "idle"} tone={statusTone(runnerState?.status)} />
                  <span className="truncate text-xs text-[#6f716b]">{composition.manifestPath}</span>
                </div>
                <h2 className="text-lg font-semibold leading-tight tracking-normal">Dogfood operative</h2>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <PrimaryButton icon={<Play size={17} />} label={isRunning ? "Restart" : "Run"} disabled={Boolean(busy)} onClick={() => runAction("up")} />
                <CommandButton icon={<Wrench size={16} />} label="Dev" disabled={Boolean(busy)} onClick={() => runAction("dev")} />
                <CommandButton icon={<ShieldCheck size={16} />} label="Verify" disabled={Boolean(busy)} onClick={() => runAction("verify")} />
                <CommandButton icon={<Square size={16} />} label="Stop" disabled={Boolean(busy)} onClick={() => runAction("down")} />
              </div>
            </div>
          </header>

          {error ? (
            <div className="mb-4 border border-[#b44a3f]/30 bg-[#fae9e5] px-4 py-3 text-sm font-medium text-[#9b362d]">
              {error}
            </div>
          ) : null}

          {tab === "compose" ? (
            <ComposeTab
              composition={composition}
              library={library}
              readiness={readiness}
              selectedEntries={selectedEntries}
              vaultNeedsPassword={vaultNeedsPassword}
              busy={busy}
              selectedForFaculty={selectedForFaculty}
              entrySelection={entrySelection}
              setSingleSelection={setSingleSelection}
              toggleMultiSelection={toggleMultiSelection}
              updateConfig={updateConfig}
              openFittingSource={openFittingSource}
              onEditFitting={setEditingFitting}
              saveComposition={saveComposition}
              loadSeedStack={loadSeedStack}
              openRun={() => setTab("run")}
            />
          ) : null}
          {tab === "run" ? (
            <RunTab
              state={runnerState}
              logs={logs}
              verifyResults={verifyResults.length ? verifyResults : runnerState?.verifyResults ?? []}
              busy={busy}
              onAction={runAction}
            />
          ) : null}
          {tab === "chat" ? (
            <ChatTab compositionId={composition.id} isRunning={runnerState?.status === "running"} />
          ) : null}
          {tab === "vault" ? (
            <VaultTab
              unlocked={vaultUnlocked}
              passphrase={passphrase}
              setPassphrase={setPassphrase}
              secrets={secrets}
              setSecrets={setSecrets}
              needsPassword={vaultNeedsPassword}
              busy={busy}
              unlock={unlock}
              saveSecrets={saveSecrets}
            />
          ) : null}
        </section>
      </div>
      {editingFitting ? (
        <FittingEditor entry={editingFitting} onClose={() => setEditingFitting(null)} />
      ) : null}
    </main>
  );
}

function ComposeTab({
  composition,
  library,
  readiness,
  selectedEntries,
  vaultNeedsPassword,
  busy,
  selectedForFaculty,
  entrySelection,
  setSingleSelection,
  toggleMultiSelection,
  updateConfig,
  openFittingSource,
  onEditFitting,
  saveComposition,
  loadSeedStack,
  openRun
}: {
  composition: CompositionView;
  library: LibraryEntry[];
  readiness: Array<{ label: string; detail: string; ok: boolean }>;
  selectedEntries: LibraryEntry[];
  vaultNeedsPassword: boolean;
  busy: string | null;
  selectedForFaculty: (facultyId: FacultyId) => SelectedFitting[];
  entrySelection: (entry: LibraryEntry) => SelectedFitting | undefined;
  setSingleSelection: (facultyId: FacultyId, fittingId: string) => void;
  toggleMultiSelection: (entry: LibraryEntry) => void;
  updateConfig: (entry: LibraryEntry, key: string, value: string | number | boolean) => void;
  openFittingSource: (entry: LibraryEntry, kind: "local" | "repo") => Promise<void>;
  onEditFitting: (entry: LibraryEntry) => void;
  saveComposition: (next: Partial<CompositionView>) => Promise<void>;
  loadSeedStack: () => void;
  openRun: () => void;
}) {
  return (
    <div className="grid gap-4">
      <section className="border border-[#cfc6b8] bg-[#fbfaf5] p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        <div className="grid gap-4 xl:grid-cols-[1fr_auto]">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold">Operative stack</h3>
              <span className="border border-[#d9d1c2] bg-[#f7f3ea] px-2 py-1 text-xs font-semibold uppercase text-[#6b6e68]">
                {selectedEntries.length} selected
              </span>
            </div>
            <p className="max-w-4xl text-sm leading-6 text-[#666b63]">
              Pick a Fitting for each Faculty. Garrison writes the choices into the composition manifest,
              APM installs those packages, then the runner assembles the operative prompt and launches Claude Code.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CommandButton icon={<Plus size={16} />} label="Seed stack" disabled={busy === "save"} onClick={loadSeedStack} />
            <CommandButton icon={<ChevronRight size={16} />} label="Run panel" onClick={openRun} />
          </div>
        </div>

        {vaultNeedsPassword ? (
          <div className="mt-4 flex items-start gap-3 border border-[#9b362d]/30 bg-[#fae9e5] px-3 py-3 text-sm text-[#9b362d]">
            <AlertTriangle className="mt-0.5 shrink-0" size={17} />
            <div>
              <strong>Vault password is not set.</strong> The vault starts open for bootstrap convenience, but
              secrets should not be stored until a password creates the encrypted vault file.
            </div>
          </div>
        ) : null}

        <div className="mt-4 grid gap-2 md:grid-cols-5">
          {readiness.map((item) => (
            <div key={item.label} className="flex items-center justify-between border border-[#d9d1c2] bg-white px-3 py-2">
              <div>
                <div className="text-xs font-semibold uppercase text-[#6b6e68]">{item.label}</div>
                <div className="mt-1 text-xs text-[#18211c]">{item.detail}</div>
              </div>
              {item.ok ? <Check size={16} className="text-[#2c6f63]" /> : <Circle size={16} className="text-[#8b6a22]" />}
            </div>
          ))}
        </div>

        {selectedEntries.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold uppercase text-[#6b6e68]">
              Capability checks
            </div>
            {composition.capabilityIssues.length === 0 ? (
              <div className="flex items-center justify-between border border-[#d9d1c2] bg-white px-3 py-2">
                <div>
                  <div className="text-xs font-semibold uppercase text-[#6b6e68]">All capabilities</div>
                  <div className="mt-1 text-xs text-[#18211c]">satisfied across selected Fittings</div>
                </div>
                <Check size={16} className="text-[#2c6f63]" />
              </div>
            ) : (
              <div className="grid gap-2">
                {composition.capabilityIssues.map((issue, index) => (
                  <div
                    key={`${issue.fittingId}-${issue.code}-${issue.kind}-${issue.name ?? ""}-${index}`}
                    className="flex items-center justify-between gap-3 border border-[#d9d1c2] bg-white px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold uppercase text-[#6b6e68]">
                        Capability {issue.kind}{issue.name ? `:${issue.name}` : ""}
                      </div>
                      <div className="mt-1 text-xs text-[#18211c]">
                        {capabilityIssueDetail(issue)}
                      </div>
                    </div>
                    <Circle size={16} className="shrink-0 text-[#8b6a22]" />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section className="border border-[#cfc6b8] bg-[#fbfaf5] shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        <div className="grid gap-4 border-b border-[#d9d1c2] p-4 xl:grid-cols-[1fr_170px_170px_190px]">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-[#6b6e68]">Operative</span>
            <input
              className="h-11 border border-[#cfc6b8] bg-white px-3 text-sm outline-none focus:border-[#18211c]"
              value={composition.name}
              onChange={(event) => void saveComposition({ name: event.target.value })}
            />
          </label>
          <ConfigNumber
            label="Tasks/tick"
            value={composition.globalConfig.guardrails.max_tasks_per_tick}
            onChange={(value) =>
              void saveComposition({
                globalConfig: {
                  ...composition.globalConfig,
                  guardrails: { ...composition.globalConfig.guardrails, max_tasks_per_tick: value }
                }
              })
            }
          />
          <ConfigNumber
            label="Tools/tick"
            value={composition.globalConfig.guardrails.max_tool_calls_per_tick}
            onChange={(value) =>
              void saveComposition({
                globalConfig: {
                  ...composition.globalConfig,
                  guardrails: { ...composition.globalConfig.guardrails, max_tool_calls_per_tick: value }
                }
              })
            }
          />
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-semibold uppercase text-[#6b6e68]">Permissions</span>
            <select
              className="h-11 border border-[#cfc6b8] bg-white px-3 text-sm outline-none focus:border-[#18211c]"
              value={composition.globalConfig.permissions_mode}
              onChange={(event) =>
                void saveComposition({
                  globalConfig: {
                    ...composition.globalConfig,
                    permissions_mode: event.target.value as GlobalConfig["permissions_mode"]
                  }
                })
              }
            >
              <option value="full-auto">full-auto</option>
              <option value="auto">auto</option>
              <option value="allow-file-edits">allow-file-edits</option>
              <option value="conservative">conservative</option>
            </select>
          </label>
        </div>

        {composition.derivedTasks ? (
          <div className="border-b border-[#d9d1c2] bg-[#e4f0eb] px-4 py-3 text-sm font-medium text-[#21584e]">
            Derived Tasks: {composition.derivedTasks.source} · {composition.derivedTasks.truthFile}
          </div>
        ) : null}

        <div className="divide-y divide-[#d9d1c2]">
          {facultyGroups.map((group) => (
            <div key={group.label}>
              <div className="bg-[#eee8dc] px-4 py-2 text-xs font-semibold uppercase text-[#6b6e68]">
                {group.label}
              </div>
              {group.ids.map((facultyId) => {
                const faculty = faculties.find((candidate) => candidate.id === facultyId)!;
                const entries = library.filter((entry) => entry.faculty === faculty.id);
                const selected = selectedForFaculty(faculty.id);
                return (
                  <FacultyRow
                    key={faculty.id}
                    faculty={faculty}
                    entries={entries}
                    selected={selected}
                    busy={busy}
                    entrySelection={entrySelection}
                    setSingleSelection={setSingleSelection}
                    toggleMultiSelection={toggleMultiSelection}
                    updateConfig={updateConfig}
                    openFittingSource={openFittingSource}
                    onEditFitting={onEditFitting}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function FacultyRow({
  faculty,
  entries,
  selected,
  busy,
  entrySelection,
  setSingleSelection,
  toggleMultiSelection,
  updateConfig,
  openFittingSource,
  onEditFitting
}: {
  faculty: (typeof faculties)[number];
  entries: LibraryEntry[];
  selected: SelectedFitting[];
  busy: string | null;
  entrySelection: (entry: LibraryEntry) => SelectedFitting | undefined;
  setSingleSelection: (facultyId: FacultyId, fittingId: string) => void;
  toggleMultiSelection: (entry: LibraryEntry) => void;
  updateConfig: (entry: LibraryEntry, key: string, value: string | number | boolean) => void;
  openFittingSource: (entry: LibraryEntry, kind: "local" | "repo") => Promise<void>;
  onEditFitting: (entry: LibraryEntry) => void;
}) {
  const copy = facultyRoleCopy[faculty.id];
  return (
    <div className="grid gap-4 px-4 py-5 xl:grid-cols-[310px_1fr]">
      <div className="min-w-0">
        <div className="flex items-start gap-3">
          <span className={clsx("grid h-8 w-8 shrink-0 place-items-center border text-xs font-semibold", selected.length ? "border-[#18211c] bg-[#18211c] text-white" : "border-[#cfc6b8] bg-white text-[#6b6e68]")}>
            {faculty.order}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="truncate font-semibold">{faculty.name}</h4>
              {faculty.governing ? <span className="border border-[#d9b860]/40 bg-[#fff5cf] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#80611b]">capstone</span> : null}
            </div>
            <p className="mt-1 text-xs text-[#6b6e68]">{faculty.cardinality} · {faculty.shapes.join(", ")}</p>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-[#343d36]">{copy.role}</p>
        <p className="mt-2 text-xs leading-5 text-[#6b6e68]">{copy.fit}</p>
      </div>

      <div className="grid gap-3">
        {entries.length === 0 ? (
          <div className="border border-dashed border-[#cfc6b8] bg-[#f7f3ea] px-4 py-4 text-sm text-[#77736a]">
            No Fitting is curated for this Faculty yet.
          </div>
        ) : (
          <div className={clsx("grid gap-3", entries.length > 1 && "lg:grid-cols-2")}>
            {entries.map((entry) => {
              const checked = selected.some((selection) => selection.id === entry.id);
              return (
                <FittingCard
                  key={entry.id}
                  entry={entry}
                  selected={checked}
                  disabled={busy === "save"}
                  onSelect={() =>
                    faculty.cardinality === "single"
                      ? setSingleSelection(faculty.id, checked ? "" : entry.id)
                      : toggleMultiSelection(entry)
                  }
                  openFittingSource={openFittingSource}
                  onEditFitting={onEditFitting}
                />
              );
            })}
          </div>
        )}

        {entries
          .filter((entry) => entrySelection(entry))
          .map((entry) => (
            <FittingConfig
              key={entry.id}
              entry={entry}
              selection={entrySelection(entry)!}
              updateConfig={updateConfig}
            />
          ))}
      </div>
    </div>
  );
}

function FittingCard({
  entry,
  selected,
  disabled,
  onSelect,
  openFittingSource,
  onEditFitting
}: {
  entry: LibraryEntry;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  openFittingSource: (entry: LibraryEntry, kind: "local" | "repo") => Promise<void>;
  onEditFitting: (entry: LibraryEntry) => void;
}) {
  return (
    <div
      className={clsx(
        "grid gap-3 border p-4 transition",
        selected ? "border-[#2c6f63] bg-[#e4f0eb]" : "border-[#d9d1c2] bg-white hover:border-[#8f8576]"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{entry.name}</span>
            <span className="border border-[#cfc6b8] bg-[#f7f3ea] px-2 py-0.5 text-[11px] font-semibold uppercase text-[#6b6e68]">
              {entry.metadata.component_shape}
            </span>
          </div>
          <p className="text-sm leading-6 text-[#4f574f]">{entry.summary}</p>
        </div>
        <button
          className={clsx(
            "grid h-9 w-9 shrink-0 place-items-center border transition",
            selected ? "border-[#2c6f63] bg-[#2c6f63] text-white" : "border-[#cfc6b8] bg-white text-[#18211c]"
          )}
          disabled={disabled}
          onClick={onSelect}
          aria-label={selected ? `Deselect ${entry.name}` : `Select ${entry.name}`}
        >
          {selected ? <Check size={17} /> : <Plus size={17} />}
        </button>
      </div>

      <div className="grid gap-2 text-xs text-[#6b6e68] sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <Star size={14} className="text-[#8b6a22]" />
          <span>Rating {entry.ratings.global ?? "-"} global / {entry.ratings.claude_code ?? "-"} Claude Code</span>
        </div>
        <div className="truncate">Platform {entry.platforms.join(", ")}</div>
        <div className="truncate sm:col-span-2">Source {sourceLabel(entry)}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        {entry.localPath ? (
          <>
            <button
              className="inline-flex h-9 items-center gap-2 border border-[#cfc6b8] bg-white px-3 text-xs font-medium hover:border-[#18211c]"
              onClick={() => void openFittingSource(entry, "local")}
            >
              <FolderOpen size={14} />
              Open folder
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 border border-[#cfc6b8] bg-white px-3 text-xs font-medium hover:border-[#18211c]"
              onClick={() => onEditFitting(entry)}
            >
              <Pencil size={14} />
              Edit files
            </button>
          </>
        ) : null}
        <button
          className="inline-flex h-9 items-center gap-2 border border-[#cfc6b8] bg-white px-3 text-xs font-medium hover:border-[#18211c]"
          onClick={() => void openFittingSource(entry, "repo")}
        >
          <ExternalLink size={14} />
          Open repo
        </button>
      </div>
    </div>
  );
}

function FittingConfig({
  entry,
  selection,
  updateConfig
}: {
  entry: LibraryEntry;
  selection: SelectedFitting;
  updateConfig: (entry: LibraryEntry, key: string, value: string | number | boolean) => void;
}) {
  if (entry.metadata.config_schema.length === 0) {
    return null;
  }
  return (
    <div className="border border-[#d9d1c2] bg-[#f7f3ea] p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{entry.name}</div>
          <div className="mt-1 text-xs text-[#6b6e68]">{entry.summary}</div>
        </div>
        <ShieldCheck size={18} className="shrink-0 text-[#2c6f63]" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {entry.metadata.config_schema.map((field) => (
          <ConfigField
            key={field.key}
            field={field}
            value={selection.config[field.key] ?? field.default ?? ""}
            onChange={(value) => updateConfig(entry, field.key, value)}
          />
        ))}
      </div>
      {entry.metadata.ui?.extension ? (
        <div className="mt-3 border-t border-[#d9d1c2] pt-3">
          <ExtensionPane entry={entry} selection={selection} />
        </div>
      ) : null}
    </div>
  );
}

function RunTab({
  state,
  logs,
  verifyResults,
  busy,
  onAction
}: {
  state: RunnerState | null;
  logs: LogEvent[];
  verifyResults: VerifyResult[];
  busy: string | null;
  onAction: (action: "up" | "down" | "verify" | "dev") => Promise<void>;
}) {
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  return (
    <div className="grid min-w-0 gap-4">
      <section className="grid min-w-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="border border-[#cfc6b8] bg-[#fbfaf5] p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold">Dispatch</h3>
              <p className="mt-1 text-sm text-[#666b63]">Status: {state?.status ?? "idle"}</p>
            </div>
            <RadioTower className={state?.status === "running" ? "text-[#2c6f63]" : "text-[#d9b860]"} size={26} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PrimaryButton icon={<Play size={17} />} label={state?.status === "running" ? "Restart" : "Run"} disabled={Boolean(busy)} onClick={() => onAction("up")} />
            <CommandButton icon={<Square size={16} />} label="Stop" disabled={Boolean(busy)} onClick={() => onAction("down")} />
            <CommandButton icon={<ShieldCheck size={16} />} label="Verify" disabled={Boolean(busy)} onClick={() => onAction("verify")} />
            <CommandButton icon={<Wrench size={16} />} label="Dev mode" disabled={Boolean(busy)} onClick={() => onAction("dev")} />
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <Metric label="Status" value={state?.status ?? "idle"} tone={statusTone(state?.status)} />
          <Metric label="PID" value={state?.pid ? String(state.pid) : "-"} />
          <Metric label="Dev" value={state?.devMode ? "on" : "off"} />
          <Metric label="Verify" value={`${verifyResults.filter((result) => result.ok).length}/${verifyResults.length}`} tone={verifyResults.length && verifyResults.every((result) => result.ok) ? "good" : "idle"} />
        </div>
      </section>

      <section className="min-w-0">
        <div className="min-w-0 border border-[#cfc6b8] bg-[#fbfaf5] p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">Verify hooks</h3>
            <span className="text-sm text-[#6b6e68]">{verifyResults.filter((result) => result.ok).length}/{verifyResults.length}</span>
          </div>
          {verifyResults.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {verifyResults.map((result) => (
                <div key={result.fittingId} className="flex items-center justify-between gap-3 border border-[#d9d1c2] bg-white px-3 py-2 text-sm">
                  <span className="truncate">{result.fittingId}</span>
                  <span className={result.ok ? "font-medium text-[#2c6f63]" : "font-medium text-[#9b362d]"}>{result.ok ? "passed" : "failed"}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-dashed border-[#cfc6b8] bg-[#f7f3ea] px-3 py-8 text-center text-sm text-[#77736a]">
              Verify has not run yet.
            </div>
          )}
        </div>
      </section>

      <section className="min-w-0 border border-[#27362d] bg-[#0d1511] font-mono text-xs text-[#d7e3dc] shadow-[0_18px_70px_rgba(24,33,28,0.24)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d7e3dc]/10 px-4 py-3 text-[#9fb7aa]">
          <div className="flex items-center gap-2">
            <Terminal size={14} />
            Runtime log
          </div>
          <span>{logs.length} lines</span>
        </div>
        <div className="h-[520px] overflow-auto px-4 py-3 leading-5">
          {logs.length === 0 ? (
            <div className="text-[#7f9188]">No log lines yet.</div>
          ) : (
            logs.map((event, index) => (
              <div key={`${event.ts}-${index}`} className="grid gap-2 border-b border-[#d7e3dc]/5 py-1 sm:grid-cols-[108px_74px_minmax(0,1fr)]">
                <span className="text-[#718378]">{event.ts.split("T")[1]?.replace("Z", "")}</span>
                <span className={clsx("font-semibold uppercase", logTone(event.stream))}>{event.stream}</span>
                <span className={clsx("min-w-0 whitespace-pre-wrap break-words", event.stream === "stderr" && "text-[#ffb7a8]")}>{event.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}

function ChatTab({
  compositionId,
  isRunning
}: {
  compositionId: string;
  isRunning: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  const canSend = isRunning && draft.trim().length > 0 && !sending;

  async function handleAttach(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!isRunning) {
      setError("Start the operative first to attach files.");
      return;
    }
    setAttaching(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const bytes = await file.arrayBuffer();
        const base64 = bufferToBase64(bytes);
        const response = await fetch(`/api/runner/${compositionId}/attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64: base64 })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error ?? `attach failed: ${response.status}`);
        }
        setPendingAttachments((prev) => [
          ...prev,
          { filename: file.name, path: data.path, bytes: data.bytes }
        ]);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(path: string) {
    setPendingAttachments((prev) => prev.filter((item) => item.path !== path));
  }

  function clearChat() {
    if (sending) return;
    setMessages([]);
    setError(null);
  }

  async function send() {
    if (!canSend) return;
    const trimmed = draft.trim();
    const attachments = pendingAttachments;
    const composedMessage = attachments.length
      ? `${trimmed}\n\nAttached files:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`
      : trimmed;

    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
      attachments,
      status: "complete"
    };
    const assistantId = `a-${Date.now()}`;
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      status: "streaming"
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setDraft("");
    setPendingAttachments([]);
    setSending(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/runner/${compositionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: composedMessage }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`chat failed: ${response.status} ${errorText}`);
      }
      await readSseStream(response.body, (event, data) => {
        const payload = (data ?? {}) as Record<string, unknown>;
        if (event === "chunk") {
          const text = String(payload.text ?? "");
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + text } : m))
          );
        } else if (event === "tool") {
          const tool = { name: String(payload.name ?? "?"), input: payload.input };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, toolCalls: [...(m.toolCalls ?? []), tool] }
                : m
            )
          );
        } else if (event === "done") {
          const finalReply = String(payload.reply ?? "");
          const cost = typeof payload.cost_usd === "number" ? payload.cost_usd : null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    text: finalReply || m.text,
                    status: "complete",
                    costUsd: cost
                  }
                : m
            )
          );
        } else if (event === "error") {
          const errText = String(payload.error ?? "stream error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, status: "error", errorText: errText } : m
            )
          );
        }
      });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId && m.status === "streaming" ? { ...m, status: "complete" } : m
        )
      );
    } catch (sendError) {
      const messageText = sendError instanceof Error ? sendError.message : String(sendError);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, status: "error", errorText: messageText } : m
        )
      );
      setError(messageText);
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border border-[#cfc6b8] bg-[#fbfaf5] px-4 py-3 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Chat</h2>
          <p className="text-xs text-[#6b6e68]">
            {isRunning
              ? "Talking to the running operative through the gateway. Enter to send, Shift+Enter for newline."
              : "Operative is not running — start it from the Run tab to chat."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#6b6e68]">{messages.length} message{messages.length === 1 ? "" : "s"}</span>
          <CommandButton
            icon={<Trash2 size={14} />}
            label="Clear"
            disabled={messages.length === 0 || sending}
            onClick={clearChat}
          />
        </div>
      </header>

      <section className="min-w-0 border border-[#cfc6b8] bg-[#fbfaf5] shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        <div ref={scrollRef} className="h-[calc(100vh-360px)] min-h-[420px] overflow-auto px-4 py-5">
          {messages.length === 0 ? (
            <div className="grid h-full place-items-center text-center text-sm text-[#77736a]">
              <div>
                <MessageSquare size={32} className="mx-auto mb-3 text-[#cfc6b8]" />
                <div>No messages yet.</div>
                <div className="mt-1 text-xs">Type below and press Enter to send.</div>
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              {messages.map((message) => (
                <ChatBubble key={message.id} message={message} />
              ))}
            </div>
          )}
        </div>
      </section>

      {error ? (
        <div className="border border-[#b44a3f]/30 bg-[#fae9e5] px-4 py-2 text-sm text-[#9b362d]">{error}</div>
      ) : null}

      <section className="min-w-0 border border-[#cfc6b8] bg-[#fbfaf5] p-3 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        {pendingAttachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingAttachments.map((attachment) => (
              <div
                key={attachment.path}
                className="flex items-center gap-2 border border-[#d9d1c2] bg-white px-2 py-1 text-xs"
              >
                <Paperclip size={12} />
                <span className="max-w-[200px] truncate">{attachment.filename}</span>
                <span className="text-[#9a958b]">{formatBytes(attachment.bytes)}</span>
                <button
                  type="button"
                  className="text-[#9a958b] hover:text-[#9b362d]"
                  onClick={() => removeAttachment(attachment.path)}
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid gap-2 md:grid-cols-[auto_1fr_auto] md:items-end">
          <button
            type="button"
            className="flex h-10 items-center gap-2 border border-[#cfc6b8] bg-white px-3 text-sm hover:border-[#18211c] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => fileInputRef.current?.click()}
            disabled={attaching || !isRunning}
          >
            {attaching ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
            <span className="hidden md:inline">Attach</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => handleAttach(event.target.files)}
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isRunning ? "Message Verity..." : "Operative offline."}
            disabled={!isRunning}
            rows={1}
            className="min-h-[40px] w-full resize-none border border-[#cfc6b8] bg-white px-3 py-2 text-sm outline-none focus:border-[#18211c] disabled:cursor-not-allowed disabled:bg-[#f3eee2]"
          />
          <PrimaryButton
            icon={sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            label={sending ? "Sending" : "Send"}
            disabled={!canSend}
            onClick={() => void send()}
          />
        </div>
      </section>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={clsx("flex min-w-0 gap-3", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[85%] min-w-0 border px-4 py-3 shadow-[0_4px_14px_rgba(24,33,28,0.05)]",
          isUser
            ? "border-[#18211c] bg-[#18211c] text-[#f5f1e6]"
            : "border-[#d9d1c2] bg-white text-[#18211c]"
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">
          {isUser ? "You" : "Verity"}
          {message.status === "streaming" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" />
              streaming
            </span>
          ) : null}
          {message.status === "error" ? <span className="text-[#ffb7a8]">error</span> : null}
        </div>
        {message.toolCalls && message.toolCalls.length > 0 ? (
          <div className="mb-2 grid gap-1">
            {message.toolCalls.map((tool, index) => (
              <div
                key={`${tool.name}-${index}`}
                className={clsx(
                  "flex items-center gap-2 border px-2 py-1 text-xs",
                  isUser
                    ? "border-[#3a4640] bg-[#0f1612] text-[#a8b8af]"
                    : "border-[#e1dccd] bg-[#f7f3ea] text-[#6b6e68]"
                )}
              >
                <Wrench size={11} />
                <span className="font-mono">{tool.name}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap break-words text-sm leading-6">
          {message.text}
          {message.status === "streaming" && !message.text ? (
            <span className="text-[#a8b8af]">Thinking…</span>
          ) : null}
          {message.status === "streaming" ? (
            <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-current align-middle opacity-60" />
          ) : null}
        </div>
        {message.errorText ? (
          <div className="mt-2 text-xs text-[#ffb7a8]">{message.errorText}</div>
        ) : null}
        {message.attachments && message.attachments.length > 0 ? (
          <div className="mt-2 grid gap-1 text-xs opacity-80">
            {message.attachments.map((attachment) => (
              <div key={attachment.path} className="flex items-center gap-2">
                <Paperclip size={11} />
                <span className="truncate">{attachment.filename}</span>
                <span className="opacity-70">{formatBytes(attachment.bytes)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {typeof message.costUsd === "number" ? (
          <div className="mt-2 text-[10px] uppercase tracking-wide opacity-50">
            cost ${message.costUsd.toFixed(4)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.trim()) continue;
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += (data ? "\n" : "") + line.slice(5).trimStart();
        }
      }
      if (event === "open") continue;
      let parsed: unknown = null;
      if (data) {
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
      }
      onEvent(event, parsed);
    }
  }
}

function VaultTab({
  unlocked,
  passphrase,
  setPassphrase,
  secrets,
  setSecrets,
  needsPassword,
  busy,
  unlock,
  saveSecrets
}: {
  unlocked: boolean;
  passphrase: string;
  setPassphrase: (value: string) => void;
  secrets: VaultSecret[];
  setSecrets: (value: VaultSecret[]) => void;
  needsPassword: boolean;
  busy: string | null;
  unlock: () => Promise<void>;
  saveSecrets: () => Promise<void>;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
      <section className={clsx("border p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]", needsPassword ? "border-[#9b362d]/40 bg-[#fae9e5]" : "border-[#cfc6b8] bg-[#fbfaf5]")}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold">Vault</h3>
          {needsPassword ? <AlertTriangle className="text-[#9b362d]" /> : unlocked ? <Unlock className="text-[#2c6f63]" /> : <Lock className="text-[#8b6a22]" />}
        </div>
        {needsPassword ? (
          <div className="mb-4 text-sm leading-6 text-[#9b362d]">
            The starter vault is open only because no encrypted vault exists yet. Define a password now;
            after that, secrets are AES-256-GCM encrypted in <span className="font-mono">data/vault.json</span>.
          </div>
        ) : null}
        <div className="flex gap-2">
          <input
            type="password"
            className="h-11 min-w-0 flex-1 border border-[#cfc6b8] bg-white px-3 text-sm outline-none focus:border-[#18211c]"
            value={passphrase}
            placeholder="Passphrase"
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <PrimaryButton icon={<KeyRound size={16} />} label={needsPassword ? "Set password" : unlocked ? "Unlocked" : "Unlock"} disabled={busy === "vault"} onClick={unlock} />
        </div>
      </section>

      <section className="border border-[#cfc6b8] bg-[#fbfaf5] p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Secrets</h3>
          <div className="flex gap-2">
            <CommandButton icon={<Plus size={16} />} label="Add" disabled={!unlocked || needsPassword} onClick={() => setSecrets([...secrets, { key: "", value: "" }])} />
            <CommandButton icon={<Save size={16} />} label="Save" disabled={!unlocked || needsPassword || busy === "secrets"} onClick={saveSecrets} />
          </div>
        </div>
        {unlocked && !needsPassword ? (
          <div className="grid gap-2">
            {secrets.map((secret, index) => (
              <div key={index} className="grid gap-2 md:grid-cols-[1fr_2fr_42px]">
                <input
                  className="h-10 border border-[#cfc6b8] bg-white px-3 text-sm outline-none focus:border-[#18211c]"
                  value={secret.key}
                  placeholder="KEY"
                  onChange={(event) =>
                    setSecrets(secrets.map((item, itemIndex) => (itemIndex === index ? { ...item, key: event.target.value } : item)))
                  }
                />
                <input
                  className="h-10 border border-[#cfc6b8] bg-white px-3 text-sm outline-none focus:border-[#18211c]"
                  value={secret.value}
                  placeholder="value"
                  onChange={(event) =>
                    setSecrets(secrets.map((item, itemIndex) => (itemIndex === index ? { ...item, value: event.target.value } : item)))
                  }
                />
                <button
                  className="grid h-10 place-items-center border border-[#cfc6b8] bg-white hover:border-[#9b362d] hover:text-[#9b362d]"
                  onClick={() => setSecrets(secrets.filter((_item, itemIndex) => itemIndex !== index))}
                  aria-label="Remove secret"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            {secrets.length === 0 ? <div className="border border-dashed border-[#cfc6b8] bg-[#f7f3ea] px-3 py-8 text-center text-sm text-[#77736a]">No secrets stored.</div> : null}
          </div>
        ) : (
          <div className="border border-dashed border-[#cfc6b8] bg-[#f7f3ea] px-3 py-8 text-center text-sm text-[#77736a]">
            {needsPassword ? "Set a vault password before storing secrets." : "Locked"}
          </div>
        )}
      </section>
    </div>
  );
}

function ConfigField({
  field,
  value,
  onChange
}: {
  field: ConfigSchemaField;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const label = (
    <span className="text-xs font-semibold uppercase text-[#6b6e68]">
      {field.key}
      {field.required ? " *" : ""}
    </span>
  );
  if (field.type === "boolean") {
    return (
      <label className="flex h-10 items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="grid gap-1 text-sm">
        {label}
        <select className="h-10 border border-[#cfc6b8] bg-white px-3 outline-none focus:border-[#18211c]" value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const numeric = field.type === "integer" || field.type === "number";
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <input
        className="h-10 border border-[#cfc6b8] bg-white px-3 outline-none focus:border-[#18211c]"
        type={numeric ? "number" : "text"}
        value={String(value)}
        onChange={(event) => onChange(numeric ? Number(event.target.value) : event.target.value)}
      />
    </label>
  );
}

function ConfigNumber({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-xs font-semibold uppercase text-[#6b6e68]">{label}</span>
      <input className="h-11 border border-[#cfc6b8] bg-white px-3 outline-none focus:border-[#18211c]" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Metric({ label, value, tone = "idle" }: { label: string; value: string; tone?: "good" | "bad" | "active" | "idle" }) {
  return (
    <div className="border border-[#cfc6b8] bg-[#fbfaf5] p-4 shadow-[0_12px_40px_rgba(24,33,28,0.08)]">
      <div className="text-xs font-semibold uppercase text-[#6b6e68]">{label}</div>
      <div className={clsx("mt-2 text-2xl font-semibold", tone === "good" && "text-[#2c6f63]", tone === "bad" && "text-[#9b362d]", tone === "active" && "text-[#215b70]")}>{value}</div>
    </div>
  );
}

function StatusPill({ label, tone = "idle" }: { label: string; tone?: "good" | "bad" | "active" | "idle" }) {
  return (
    <span className={clsx(
      "inline-flex items-center border px-2 py-1 text-[11px] font-semibold uppercase",
      tone === "good" && "border-[#2c6f63]/30 bg-[#e4f0eb] text-[#21584e]",
      tone === "bad" && "border-[#b44a3f]/30 bg-[#fae9e5] text-[#9b362d]",
      tone === "active" && "border-[#215b70]/30 bg-[#e4eef2] text-[#215b70]",
      tone === "idle" && "border-[#d9d1c2] bg-[#eee8dc] text-[#6b6e68]"
    )}>
      {label}
    </span>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "flex h-11 min-w-max items-center gap-3 px-3 text-left text-sm transition md:w-full",
        active ? "bg-[#f5f1e6] text-[#111814]" : "text-[#d4dbd2] hover:bg-[#f5f1e6]/10"
      )}
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function CommandButton({
  icon,
  label,
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      className="inline-flex h-11 items-center justify-center gap-2 border border-[#cfc6b8] bg-white px-3 text-sm font-medium shadow-[0_6px_20px_rgba(24,33,28,0.06)] transition hover:border-[#18211c] hover:bg-[#f7f3ea]"
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {icon}
      {label}
    </button>
  );
}

function PrimaryButton({
  icon,
  label,
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      className="inline-flex h-11 items-center justify-center gap-2 border border-[#18211c] bg-[#18211c] px-4 text-sm font-semibold text-white shadow-[0_12px_28px_rgba(24,33,28,0.18)] transition hover:bg-[#2a382f]"
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {icon}
      {label}
    </button>
  );
}

function defaultSelection(entry: LibraryEntry): SelectedFitting {
  return {
    id: entry.id,
    config: Object.fromEntries(
      entry.metadata.config_schema
        .filter((field) => field.default !== undefined)
        .map((field) => [field.key, field.default as string | number | boolean])
    )
  };
}

function computeReadiness(
  composition: CompositionView | null,
  selectedEntries: LibraryEntry[],
  vaultUnlocked: boolean,
  vaultNeedsPassword: boolean,
  state: RunnerState | null,
  verifyTotal: number,
  verifiedCount: number
) {
  const selectedIds = new Set(selectedEntries.map((entry) => entry.id));
  const missing = coreSeedIds.filter((id) => !selectedIds.has(id)).length;
  return [
    {
      label: "Seed stack",
      detail: missing === 0 ? "six core Fittings selected" : `${missing} core Fittings missing`,
      ok: missing === 0
    },
    {
      label: "Tasks",
      detail: composition?.derivedTasks ? `${composition.derivedTasks.source} backed` : "no task source",
      ok: Boolean(composition?.derivedTasks)
    },
    {
      label: "Vault",
      detail: vaultNeedsPassword ? "password needed" : vaultUnlocked ? "unlocked" : "locked",
      ok: !vaultNeedsPassword && vaultUnlocked
    },
    {
      label: "Runner",
      detail: state?.status ?? "idle",
      ok: state?.status === "running"
    },
    {
      label: "Verify hooks",
      detail: verifyTotal ? `${verifiedCount}/${verifyTotal} passing` : "not run",
      ok: verifyTotal > 0 && verifiedCount === verifyTotal
    }
  ];
}

function sourceLabel(entry: LibraryEntry): string {
  return entry.localPath ?? entry.repo;
}

function capabilityIssueDetail(issue: CapabilityIssueView): string {
  switch (issue.code) {
    case "missing-required":
      return `required by ${issue.fittingId}: no provider in composition`;
    case "ambiguous-singleton":
      return `consumed by ${issue.fittingId}: more than one provider`;
    case "too-many-for-optional":
      return `consumed by ${issue.fittingId}: more than one provider for optional-one`;
    case "unknown-kind":
      return `declared by ${issue.fittingId}: unknown capability kind`;
  }
}

function logTone(stream: LogEvent["stream"]): string {
  if (stream === "stderr") {
    return "text-[#ffb7a8]";
  }
  if (stream === "input") {
    return "text-[#f2d071]";
  }
  if (stream === "stdout") {
    return "text-[#9fd1bb]";
  }
  return "text-[#9fb7aa]";
}

function statusTone(status?: RunnerState["status"]): "good" | "bad" | "active" | "idle" {
  if (status === "running") {
    return "good";
  }
  if (status === "failed") {
    return "bad";
  }
  if (status === "starting" || status === "verifying" || status === "stopping") {
    return "active";
  }
  return "idle";
}

async function readJson(response: Response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? response.statusText);
  }
  return data;
}
