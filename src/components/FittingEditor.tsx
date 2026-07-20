"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Save,
  X
} from "lucide-react";
import clsx from "clsx";
import type { LibraryEntry } from "@/lib/types";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div
      className="grid h-full place-items-center gap-3 bg-[var(--surface)] text-sm text-[var(--mute)]"
      role="status"
      aria-label="Loading code editor"
    >
      <Loader2 size={18} className="animate-spin text-[var(--brass)]" />
    </div>
  )
});

interface DirectoryEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

interface FileContents {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  size: number;
}

interface TreeNodeState {
  path: string;
  name: string;
  type: "file" | "dir";
  expanded: boolean;
  loading: boolean;
  error?: string;
  children?: TreeNodeState[];
}

function languageForPath(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "html":
      return "html";
    case "css":
      return "css";
    case "sh":
    case "bash":
      return "shell";
    default:
      return "plaintext";
  }
}

async function fetchListing(fittingId: string, dirPath: string): Promise<DirectoryEntry[]> {
  const url = new URL(`/api/fittings/${encodeURIComponent(fittingId)}/files`, window.location.origin);
  if (dirPath) url.searchParams.set("path", dirPath);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to list directory (${response.status})`);
  }
  const json = (await response.json()) as { entries: DirectoryEntry[] };
  return json.entries;
}

async function fetchFile(fittingId: string, filePath: string): Promise<FileContents> {
  const url = new URL(`/api/fittings/${encodeURIComponent(fittingId)}/file`, window.location.origin);
  url.searchParams.set("path", filePath);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to read file (${response.status})`);
  }
  return (await response.json()) as FileContents;
}

async function saveFile(fittingId: string, filePath: string, content: string): Promise<{ size: number }> {
  const response = await fetch(`/api/fittings/${encodeURIComponent(fittingId)}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, content })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `Failed to save file (${response.status})`);
  }
  return { size: body.size ?? content.length };
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function FittingEditor({
  entry,
  onClose
}: {
  entry: LibraryEntry;
  onClose: () => void;
}) {
  const [root, setRoot] = useState<TreeNodeState>({
    path: "",
    name: entry.name,
    type: "dir",
    expanded: true,
    loading: true
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileEncoding, setFileEncoding] = useState<"utf8" | "base64">("utf8");
  const [savedContent, setSavedContent] = useState<string>("");
  const [bufferContent, setBufferContent] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const keepEditingButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const dirty = bufferContent !== savedContent;

  const updateNode = useCallback(
    (path: string, mutate: (node: TreeNodeState) => TreeNodeState): void => {
      setRoot((prev) => mutateTree(prev, path, mutate));
    },
    []
  );

  const loadDirectory = useCallback(
    async (path: string) => {
      try {
        const entries = await fetchListing(entry.id, path);
        const children: TreeNodeState[] = entries.map((child) => ({
          path: joinPath(path, child.name),
          name: child.name,
          type: child.type,
          expanded: false,
          loading: false
        }));
        updateNode(path, (node) => ({ ...node, loading: false, error: undefined, children }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateNode(path, (node) => ({ ...node, loading: false, error: message }));
      }
    },
    [entry.id, updateNode]
  );

  useEffect(() => {
    void loadDirectory("");
  }, [loadDirectory]);

  const onToggleDir = useCallback(
    (node: TreeNodeState) => {
      if (node.type !== "dir") return;
      const willExpand = !node.expanded;
      updateNode(node.path, (current) => ({
        ...current,
        expanded: willExpand,
        loading: willExpand && !current.children ? true : current.loading
      }));
      if (willExpand && !node.children) {
        void loadDirectory(node.path);
      }
    },
    [loadDirectory, updateNode]
  );

  const openFile = useCallback(
    async (filePath: string) => {
      setFileLoading(true);
      setFileError(null);
      setSaveNotice(null);
      try {
        const file = await fetchFile(entry.id, filePath);
        setSelectedPath(filePath);
        setFileEncoding(file.encoding);
        setSavedContent(file.encoding === "utf8" ? file.content : "");
        setBufferContent(file.encoding === "utf8" ? file.content : "");
      } catch (error) {
        setFileError(error instanceof Error ? error.message : String(error));
        setSelectedPath(filePath);
        setFileEncoding("utf8");
        setSavedContent("");
        setBufferContent("");
      } finally {
        setFileLoading(false);
      }
    },
    [entry.id]
  );

  const onClickEntry = useCallback(
    (node: TreeNodeState) => {
      if (node.type === "dir") {
        onToggleDir(node);
        return;
      }
      if (dirty && node.path !== selectedPath) {
        const confirmed = window.confirm("Discard unsaved changes and open another file?");
        if (!confirmed) return;
      }
      void openFile(node.path);
    },
    [dirty, onToggleDir, openFile, selectedPath]
  );

  const onSave = useCallback(async () => {
    if (!selectedPath || !dirty) return;
    setSaving(true);
    setFileError(null);
    setSaveNotice(null);
    try {
      await saveFile(entry.id, selectedPath, bufferContent);
      setSavedContent(bufferContent);
      setSaveNotice("Saved");
      setTimeout(() => setSaveNotice(null), 2000);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [bufferContent, dirty, entry.id, selectedPath]);

  const onDiscard = useCallback(() => {
    setBufferContent(savedContent);
    setFileError(null);
  }, [savedContent]);

  const requestClose = useCallback(() => {
    if (dirty) {
      setCloseConfirm(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const dismissCloseConfirm = useCallback(() => {
    setCloseConfirm(false);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (closeConfirm) {
      requestAnimationFrame(() => keepEditingButtonRef.current?.focus());
    }
  }, [closeConfirm]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (closeConfirm) {
          dismissCloseConfirm();
        } else {
          requestClose();
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      } else if (event.key === "Tab") {
        const activeDialog = closeConfirm ? confirmDialogRef.current : dialogRef.current;
        if (!activeDialog) return;
        const focusable = activeDialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeConfirm, dismissCloseConfirm, onSave, requestClose]);

  const language = useMemo(() => (selectedPath ? languageForPath(selectedPath) : "plaintext"), [selectedPath]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-2 backdrop-blur-[2px] sm:p-5"
      style={{ background: "color-mix(in srgb, var(--ink) 68%, transparent)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="grid h-full w-full max-w-[1240px] grid-rows-[auto_1fr] overflow-hidden rounded-[10px] border border-[var(--rule-2)] bg-[var(--paper)]"
        style={{
          boxShadow: "0 32px 100px color-mix(in srgb, var(--ink) 34%, transparent)"
        }}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit files in ${entry.name}`}
        aria-describedby={entry.localPath ? "fitting-editor-path" : undefined}
      >
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-[var(--rule-2)] bg-[var(--surface-strong)] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--brass)]">
              Fitting workshop · edit files
            </div>
            <div id="fitting-editor-title" className="mt-0.5 truncate text-base font-semibold text-[var(--ink)]">
              {entry.name}
            </div>
            {entry.localPath ? (
              <div id="fitting-editor-path" className="truncate font-mono text-[11px] text-[var(--mute)]">
                {entry.localPath}
              </div>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[6px] border border-[var(--rule-2)] bg-[var(--surface)] text-[var(--ink)] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] active:translate-y-px active:scale-[0.98]"
            onClick={requestClose}
            aria-label="Close editor"
          >
            <X size={17} aria-hidden />
          </button>
        </header>

        <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(140px,30%)_1fr] md:grid-cols-[280px_1fr] md:grid-rows-1">
          <aside
            className="flex h-full min-h-0 flex-col overflow-y-auto border-b border-[var(--rule)] bg-[var(--surface)] md:border-b-0 md:border-r"
            aria-label={`${entry.name} file tree`}
          >
            <TreeView node={root} onClick={onClickEntry} selectedPath={selectedPath} depth={0} />
          </aside>
          <section className="flex h-full min-h-0 flex-col bg-[var(--paper)]" aria-label="File editor">
            {selectedPath ? (
              <>
                <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--surface)] px-3 py-2 sm:px-4">
                  <div className="min-w-0 truncate font-mono text-[11px] text-[var(--ink-mute)]">{selectedPath}</div>
                  <div className="flex items-center gap-2">
                    {saveNotice ? (
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--sage)]" role="status" aria-live="polite">
                        {saveNotice}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={onDiscard}
                      disabled={!dirty || saving}
                      className="inline-flex h-9 items-center gap-2 rounded-[5px] border border-[var(--rule-2)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)] active:translate-y-px disabled:opacity-45"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      onClick={() => void onSave()}
                      disabled={!dirty || saving}
                      className={clsx(
                        "inline-flex h-9 items-center gap-2 rounded-[5px] border px-3 text-xs font-semibold transition active:translate-y-px active:scale-[0.99]",
                        dirty && !saving
                          ? "border-[var(--sage)] bg-[var(--sage)] text-[var(--paper)] hover:brightness-90"
                          : "border-[var(--rule)] bg-[var(--surface)] text-[var(--mute)]"
                      )}
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
                      Save
                    </button>
                  </div>
                </div>
                {fileError ? (
                  <div className="border-b border-[var(--alarm)] bg-[var(--alarm-soft)] px-4 py-2.5 text-xs text-[var(--alarm)]" role="alert">
                    {fileError}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {fileLoading ? (
                    <div className="grid h-full place-items-center gap-3 text-sm text-[var(--mute)]" role="status">
                      <Loader2 size={18} className="animate-spin text-[var(--brass)]" aria-hidden />
                      <span>Opening file…</span>
                    </div>
                  ) : fileEncoding === "base64" ? (
                    <div className="grid h-full place-items-center px-6 text-center">
                      <div className="max-w-sm border-l-2 border-[var(--brass)] bg-[var(--surface)] px-5 py-4 text-sm text-[var(--mute)]">
                        Binary file — preview and editing are unavailable.
                      </div>
                    </div>
                  ) : (
                    <Monaco
                      height="100%"
                      language={language}
                      value={bufferContent}
                      onChange={(value) => setBufferContent(value ?? "")}
                      theme="vs"
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        wordWrap: "on",
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        tabSize: 2
                      }}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="grid h-full place-items-center px-6 text-center">
                <div className="max-w-sm border-l-2 border-[var(--brass)] bg-[var(--surface)] px-5 py-4 text-sm leading-6 text-[var(--mute)]">
                  <div className="mb-1 font-semibold text-[var(--ink)]">Choose a file</div>
                  Select an item in the Fitting tree to inspect and edit its source.
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {closeConfirm ? (
        <div
          className="fixed inset-0 z-[60] grid place-items-center p-4 backdrop-blur-[2px]"
          style={{ background: "color-mix(in srgb, var(--ink) 74%, transparent)" }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissCloseConfirm();
          }}
        >
          <div
            ref={confirmDialogRef}
            className="grid w-full max-w-md gap-5 rounded-[8px] border border-[var(--rule-2)] bg-[var(--surface)] p-5 sm:p-6"
            style={{ boxShadow: "0 24px 70px color-mix(in srgb, var(--ink) 38%, transparent)" }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-dialog-title"
            aria-describedby="discard-dialog-description"
          >
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--alarm)]">Unsaved changes</div>
              <div id="discard-dialog-title" className="mt-1 font-display text-xl font-semibold text-[var(--ink)]">
                Discard your edits?
              </div>
            </div>
            <div id="discard-dialog-description" className="text-sm leading-6 text-[var(--mute)]">
              You have unsaved edits in <span className="font-mono">{selectedPath}</span>. Closing will lose them.
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                ref={keepEditingButtonRef}
                type="button"
                onClick={dismissCloseConfirm}
                className="inline-flex h-10 items-center rounded-[5px] border border-[var(--rule-2)] bg-[var(--surface)] px-4 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--ink-mute)] hover:bg-[var(--paper-2)] active:translate-y-px"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  setCloseConfirm(false);
                  onClose();
                }}
                className="inline-flex h-10 items-center rounded-[5px] border border-[var(--alarm)] bg-[var(--alarm)] px-4 text-xs font-semibold text-[var(--paper)] transition hover:brightness-90 active:translate-y-px active:scale-[0.99]"
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function mutateTree(node: TreeNodeState, path: string, mutate: (node: TreeNodeState) => TreeNodeState): TreeNodeState {
  if (node.path === path) {
    return mutate(node);
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((child) => mutateTree(child, path, mutate))
  };
}

function TreeView({
  node,
  selectedPath,
  onClick,
  depth
}: {
  node: TreeNodeState;
  selectedPath: string | null;
  onClick: (node: TreeNodeState) => void;
  depth: number;
}) {
  return (
    <div className="grid w-full text-xs">
      <button
        type="button"
        onClick={() => onClick(node)}
        aria-expanded={node.type === "dir" ? node.expanded : undefined}
        aria-current={selectedPath === node.path && node.type === "file" ? "true" : undefined}
        className={clsx(
          "flex min-h-8 items-center gap-1.5 border-l-2 border-transparent px-2 py-1.5 text-left text-[var(--ink-mute)] transition hover:bg-[var(--paper-2)] hover:text-[var(--ink)] active:translate-y-px",
          selectedPath && selectedPath === node.path && node.type === "file"
            ? "border-l-[var(--brass)] bg-[var(--sage-soft)] text-[var(--ink)]"
            : null,
          depth === 0 ? "font-semibold text-[var(--ink)]" : null
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.type === "dir" ? (
          node.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />
        ) : (
          <span className="inline-block w-3" />
        )}
        {node.type === "dir" ? (
          <Folder size={12} className="text-[var(--brass)]" aria-hidden />
        ) : (
          <FileText size={12} className="text-[var(--mute)]" aria-hidden />
        )}
        <span className="truncate">{depth === 0 ? "/" : node.name}</span>
        {node.loading ? <Loader2 size={10} className="ml-1 animate-spin text-[var(--brass)]" aria-hidden /> : null}
      </button>
      {node.error ? (
        <div
          className="bg-[var(--alarm-soft)] px-2 py-1.5 text-[10px] text-[var(--alarm)]"
          style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
          role="alert"
        >
          {node.error}
        </div>
      ) : null}
      {node.expanded && node.children
        ? node.children.map((child) => (
            <TreeView
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onClick={onClick}
              depth={depth + 1}
            />
          ))
        : null}
    </div>
  );
}
