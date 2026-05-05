"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
    <div className="grid h-full place-items-center text-sm text-[#6b6e68]">
      <Loader2 size={18} className="animate-spin" />
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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void onSave();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSave, requestClose]);

  const language = useMemo(() => (selectedPath ? languageForPath(selectedPath) : "plaintext"), [selectedPath]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit files in ${entry.name}`}
    >
      <div className="grid h-full w-full max-w-[1200px] grid-rows-[auto_1fr] overflow-hidden border border-[#18211c] bg-[#f7f3ea] shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-[#cfc6b8] bg-white px-4 py-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-[#6b6e68]">Edit files</div>
            <div className="truncate text-sm font-semibold text-[#18211c]">{entry.name}</div>
            {entry.localPath ? (
              <div className="truncate text-xs text-[#6b6e68]">{entry.localPath}</div>
            ) : null}
          </div>
          <button
            className="grid h-9 w-9 place-items-center border border-[#cfc6b8] bg-white text-[#18211c] hover:border-[#18211c]"
            onClick={requestClose}
            aria-label="Close editor"
          >
            <X size={16} />
          </button>
        </header>

        <div className="grid h-full min-h-0 grid-cols-[280px_1fr]">
          <aside className="flex h-full min-h-0 flex-col overflow-y-auto border-r border-[#cfc6b8] bg-white">
            <TreeView node={root} onClick={onClickEntry} selectedPath={selectedPath} depth={0} />
          </aside>
          <section className="flex h-full min-h-0 flex-col bg-white">
            {selectedPath ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-[#cfc6b8] px-4 py-2">
                  <div className="min-w-0 truncate text-xs font-mono text-[#343d36]">{selectedPath}</div>
                  <div className="flex items-center gap-2">
                    {saveNotice ? <span className="text-xs text-[#2c6f63]">{saveNotice}</span> : null}
                    <button
                      onClick={onDiscard}
                      disabled={!dirty || saving}
                      className="inline-flex h-8 items-center gap-2 border border-[#cfc6b8] bg-white px-3 text-xs font-medium text-[#18211c] disabled:opacity-50"
                    >
                      Discard
                    </button>
                    <button
                      onClick={() => void onSave()}
                      disabled={!dirty || saving}
                      className={clsx(
                        "inline-flex h-8 items-center gap-2 border px-3 text-xs font-medium",
                        dirty && !saving
                          ? "border-[#2c6f63] bg-[#2c6f63] text-white hover:bg-[#235149]"
                          : "border-[#cfc6b8] bg-white text-[#6b6e68]"
                      )}
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                      Save
                    </button>
                  </div>
                </div>
                {fileError ? (
                  <div className="border-b border-[#e8b5a8] bg-[#fbe9e3] px-4 py-2 text-xs text-[#7a2f1d]">
                    {fileError}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {fileLoading ? (
                    <div className="grid h-full place-items-center text-sm text-[#6b6e68]">
                      <Loader2 size={18} className="animate-spin" />
                    </div>
                  ) : fileEncoding === "base64" ? (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-[#6b6e68]">
                      Binary file — not editable.
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
              <div className="grid h-full place-items-center px-6 text-center text-sm text-[#6b6e68]">
                Select a file in the tree to start editing.
              </div>
            )}
          </section>
        </div>
      </div>

      {closeConfirm ? (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-6">
          <div className="grid w-full max-w-md gap-4 border border-[#18211c] bg-white p-5">
            <div className="text-sm font-semibold text-[#18211c]">Discard unsaved changes?</div>
            <div className="text-xs leading-5 text-[#6b6e68]">
              You have unsaved edits in <span className="font-mono">{selectedPath}</span>. Closing will lose them.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCloseConfirm(false)}
                className="inline-flex h-9 items-center border border-[#cfc6b8] bg-white px-3 text-xs font-medium text-[#18211c]"
              >
                Keep editing
              </button>
              <button
                onClick={() => {
                  setCloseConfirm(false);
                  onClose();
                }}
                className="inline-flex h-9 items-center border border-[#7a2f1d] bg-[#7a2f1d] px-3 text-xs font-medium text-white"
              >
                Discard
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
        className={clsx(
          "flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[#f3ede0]",
          selectedPath && selectedPath === node.path && node.type === "file" ? "bg-[#e4f0eb]" : null,
          depth === 0 ? "font-semibold" : null
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.type === "dir" ? (
          node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="inline-block w-3" />
        )}
        {node.type === "dir" ? <Folder size={12} className="text-[#8b6a22]" /> : <FileText size={12} className="text-[#6b6e68]" />}
        <span className="truncate">{depth === 0 ? "/" : node.name}</span>
        {node.loading ? <Loader2 size={10} className="ml-1 animate-spin text-[#6b6e68]" /> : null}
      </button>
      {node.error ? (
        <div className="px-2 py-1 text-[10px] text-[#7a2f1d]" style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}>
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
