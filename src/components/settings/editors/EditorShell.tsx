"use client";

import { useState } from "react";
import type { KnownSettingView } from "@/lib/settings";
import { validateForKey, validateEnvKey } from "@/lib/settings-validate";
import { ConfirmDialog } from "@/components/quarters/ConfirmDialog";
import { BooleanControl, StringControl, NumberControl, EnumControl } from "./ScalarControls";
import { JsonEditor } from "./JsonEditor";
import { StringListEditor } from "./StringListEditor";
import { KeyValueEditor } from "./KeyValueEditor";
import { EnumMapEditor } from "./EnumMapEditor";
import { KeyValueListEditor } from "./KeyValueListEditor";
import { ObjectFormEditor } from "./ObjectFormEditor";
import { errStyle } from "./types";

// Wraps every settings row: label + mono key + doc/docs link on the left;
// pills (set / managed-only / auto-managed / deprecated), the per-type editor,
// a Raw JSON escape hatch on every structured editor, and a per-row Unset
// (confirmed for object-shaped keys) on the right.

const STRUCTURED = new Set([
  "string-list",
  "string-map",
  "enum-map",
  "string-list-map",
  "permission-rules",
  "object-form"
]);

const SCALAR = new Set(["boolean", "string", "number", "enum"]);

export function EditorShell({
  setting,
  value,
  invalidMsg,
  onChange,
  onInvalid,
  suggestions,
  footnote
}: {
  setting: KnownSettingView;
  value: unknown;
  invalidMsg: string | null;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid: (msg: string | null) => void;
  suggestions: { skills: string[]; mcpServers: string[] };
  footnote?: string;
}) {
  const [raw, setRaw] = useState(false);
  const [confirmUnset, setConfirmUnset] = useState(false);
  const present = value !== undefined;
  const rawCapable = STRUCTURED.has(setting.control);

  const unset = () => {
    onInvalid(null);
    onChange(undefined, { immediate: true });
  };

  return (
    <div
      data-row={setting.key}
      className="settings-editor-row"
    >
      <div className="settings-editor-control">
        <label className="font-display" style={{ fontWeight: 600, fontSize: 13.5, display: "block" }}>
          {setting.label}
        </label>
        <code style={{ fontSize: 11, color: "var(--mute)" }}>{setting.key}</code>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0 0" }}>
          {present ? (
            <span className="pill" style={{ fontSize: 9.5 }}>
              set
            </span>
          ) : null}
          {setting.managedOnly ? (
            <span className="pill warn" style={{ fontSize: 9.5 }} data-testid={`pill-managed-${setting.key}`}>
              managed-only
            </span>
          ) : null}
          {setting.machineManaged ? (
            <span className="pill idle" style={{ fontSize: 9.5 }}>
              auto-managed
            </span>
          ) : null}
          {setting.deprecated ? (
            <span className="pill alarm" style={{ fontSize: 9.5 }}>
              deprecated
            </span>
          ) : null}
        </div>
        <p style={{ margin: "5px 0 0", color: "var(--mute)", fontSize: 11.5 }}>
          {setting.doc}
          {setting.docsUrl ? (
            <>
              {" "}
              <a href={setting.docsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--sage)" }}>
                docs
              </a>
            </>
          ) : null}
        </p>
        {footnote ? <p style={{ margin: "5px 0 0", color: "var(--mute)", fontSize: 11 }}>{footnote}</p> : null}
      </div>

      <div>
        {rawCapable || present ? (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginBottom: 6 }}>
            {rawCapable ? (
              <button
                type="button"
                className="btn small ghost"
                data-testid={`setting-${setting.key}.rawtoggle`}
                disabled={raw && Boolean(invalidMsg)}
                title={raw && invalidMsg ? "Fix the JSON before switching back" : undefined}
                onClick={() => setRaw(!raw)}
              >
                {raw ? "Form" : "Raw JSON"}
              </button>
            ) : null}
            {present ? (
              <button
                type="button"
                className="btn small ghost"
                data-testid={`setting-${setting.key}.unset`}
                onClick={() => {
                  if (SCALAR.has(setting.control)) unset();
                  else setConfirmUnset(true);
                }}
              >
                Unset
              </button>
            ) : null}
          </div>
        ) : null}

        {raw && rawCapable ? (
          <JsonEditor
            value={value}
            onChange={onChange}
            onInvalid={onInvalid}
            testId={`setting-${setting.key}.raw`}
            validate={(parsed) => validateForKey(setting, parsed)}
          />
        ) : (
          <Control setting={setting} value={value} onChange={onChange} onInvalid={onInvalid} suggestions={suggestions} />
        )}

        {invalidMsg && setting.control === "object-form" && !raw ? (
          <p style={errStyle} data-testid={`setting-${setting.key}.invalid`}>
            {invalidMsg} — not saved until complete.
          </p>
        ) : null}
      </div>

      {confirmUnset ? (
        <ConfirmDialog
          title={`Unset ${setting.key}`}
          body={`Remove the "${setting.key}" key from settings.json? Claude Code falls back to its default.`}
          confirmLabel="Unset"
          testId={`confirm-unset-${setting.key}`}
          onConfirm={async () => unset()}
          onClose={() => setConfirmUnset(false)}
        />
      ) : null}
    </div>
  );
}

function Control({
  setting,
  value,
  onChange,
  onInvalid,
  suggestions
}: {
  setting: KnownSettingView;
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  onInvalid: (msg: string | null) => void;
  suggestions: { skills: string[]; mcpServers: string[] };
}) {
  const testId = `setting-${setting.key}`;
  const keySuggestions =
    setting.keySuggestionsSource === "skills"
      ? suggestions.skills
      : setting.keySuggestionsSource === "mcpServers"
      ? suggestions.mcpServers
      : undefined;

  switch (setting.control) {
    case "boolean":
      return <BooleanControl value={value} onChange={onChange} testId={testId} />;
    case "number":
      return (
        <NumberControl
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testId={testId}
          min={setting.min}
          max={setting.max}
          integer={setting.integer}
        />
      );
    case "enum":
      return <EnumControl value={value} onChange={onChange} testId={testId} enumValues={setting.enumValues ?? []} />;
    case "string-list":
      return (
        <StringListEditor
          value={value}
          onChange={onChange}
          testIdBase={testId}
          enumValues={setting.enumValues}
          placeholder={setting.placeholder}
          suggestions={keySuggestions}
        />
      );
    case "string-map":
      return (
        <KeyValueEditor
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testIdBase={testId}
          validateKey={setting.key === "env" ? validateEnvKey : undefined}
          keyPlaceholder={setting.placeholder}
          keySuggestions={keySuggestions}
        />
      );
    case "enum-map":
      return (
        <EnumMapEditor
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testIdBase={testId}
          enumValues={setting.enumValues ?? []}
          keyPlaceholder={setting.placeholder}
          keySuggestions={keySuggestions}
        />
      );
    case "string-list-map":
      return <KeyValueListEditor value={value} onChange={onChange} onInvalid={onInvalid} testIdBase={testId} />;
    case "object-form":
      return (
        <ObjectFormEditor
          fields={setting.fields ?? []}
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testIdBase={testId}
          suggestions={suggestions}
        />
      );
    case "json":
      return (
        <JsonEditor
          value={value}
          onChange={onChange}
          onInvalid={onInvalid}
          testId={testId}
          validate={(parsed) => validateForKey(setting, parsed)}
          placeholder={setting.placeholder}
        />
      );
    case "string":
    default:
      return <StringControl value={value} onChange={onChange} testId={testId} placeholder={setting.placeholder} />;
  }
}
