"use client";

import { useState } from "react";
import { PERMISSION_TOOL_PREFIXES } from "@/lib/settings-catalog";
import {
  validatePermissionRule,
  parsePermissionRule,
  buildPermissionRule
} from "@/lib/settings-validate";
import { useExternalReset, monoStyle, errStyle } from "./types";

const RAW = "mcp__ / raw";

const rowGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(110px, 150px) 1fr auto",
  gap: 8,
  marginBottom: 6,
  alignItems: "center"
} as const;

// Rule rows for permissions.allow/deny/ask. Rules matching the schema's
// Tool(specifier) shape parse into a tool select + specifier input; mcp__ and
// legacy non-matching strings render as raw text — flagged when invalid, but
// NEVER silently rewritten (they were on disk; surfacing beats mangling). New
// rules are validated against the schema pattern before they can be added.
export function PermissionRulesEditor({
  value,
  onChange,
  testIdBase
}: {
  value: unknown;
  onChange: (next: unknown, opts?: { immediate?: boolean }) => void;
  testIdBase: string;
}) {
  const fromValue = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => (typeof s === "string" ? s : JSON.stringify(s))) : [];
  const [rules, setRules] = useState<string[]>(() => fromValue(value));
  const markEmitted = useExternalReset(value, (incoming) => setRules(fromValue(incoming)));

  const [addTool, setAddTool] = useState<string>("Bash");
  const [addSpec, setAddSpec] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);

  const emit = (next: string[], immediate: boolean) => {
    setRules(next);
    const out = next.length > 0 ? next : undefined;
    markEmitted(out);
    onChange(out, { immediate });
  };

  const addRule = () => {
    const rule = addTool === RAW ? addSpec.trim() : buildPermissionRule(addTool, addSpec);
    const msg = validatePermissionRule(rule);
    if (msg) {
      setAddErr(msg);
      return;
    }
    setAddErr(null);
    setAddSpec("");
    emit([...rules, rule], true);
  };

  return (
    <div data-testid={testIdBase}>
      {rules.map((rule, i) => {
        const parsed = parsePermissionRule(rule, PERMISSION_TOOL_PREFIXES);
        if (parsed) {
          return (
            <div key={i} style={rowGrid}>
              <select
                className="text"
                data-testid={`${testIdBase}.${i}.tool`}
                value={parsed.tool}
                onChange={(e) =>
                  emit(
                    rules.map((r, j) => (j === i ? buildPermissionRule(e.target.value, parsed.specifier) : r)),
                    true
                  )
                }
              >
                {PERMISSION_TOOL_PREFIXES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                className="text"
                data-testid={`${testIdBase}.${i}.spec`}
                style={monoStyle}
                value={parsed.specifier}
                placeholder="specifier, e.g. git add:* (empty = whole tool)"
                onChange={(e) =>
                  emit(rules.map((r, j) => (j === i ? buildPermissionRule(parsed.tool, e.target.value) : r)), false)
                }
                onBlur={() => emit(rules, true)}
              />
              <button
                type="button"
                className="btn small ghost"
                data-testid={`${testIdBase}.${i}.remove`}
                onClick={() => emit(rules.filter((_, j) => j !== i), true)}
              >
                Remove
              </button>
            </div>
          );
        }
        const invalid = validatePermissionRule(rule);
        return (
          <div key={i} style={rowGrid}>
            <span className={`pill${invalid ? " warn" : ""}`} style={{ fontSize: 10.5, justifySelf: "start" }}>
              {invalid ? "unrecognized" : "raw"}
            </span>
            <input
              className="text"
              data-testid={`${testIdBase}.${i}.raw`}
              style={monoStyle}
              value={rule}
              onChange={(e) => emit(rules.map((r, j) => (j === i ? e.target.value : r)), false)}
              onBlur={() => emit(rules, true)}
            />
            <button
              type="button"
              className="btn small ghost"
              data-testid={`${testIdBase}.${i}.remove`}
              onClick={() => emit(rules.filter((_, j) => j !== i), true)}
            >
              Remove
            </button>
          </div>
        );
      })}

      <div style={rowGrid}>
        <select
          className="text"
          data-testid={`${testIdBase}.add.tool`}
          value={addTool}
          onChange={(e) => {
            setAddTool(e.target.value);
            setAddErr(null);
          }}
        >
          {PERMISSION_TOOL_PREFIXES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
          <option value={RAW}>{RAW}</option>
        </select>
        <input
          className="text"
          data-testid={`${testIdBase}.add.spec`}
          style={monoStyle}
          value={addSpec}
          placeholder={addTool === RAW ? "full rule, e.g. mcp__github__search_repositories" : "specifier (optional)"}
          onChange={(e) => {
            setAddSpec(e.target.value);
            setAddErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRule();
            }
          }}
        />
        <button type="button" className="btn small ghost" data-testid={`${testIdBase}.add`} onClick={addRule}>
          Add rule
        </button>
      </div>
      {addErr ? <p style={errStyle}>{addErr}</p> : null}
    </div>
  );
}
