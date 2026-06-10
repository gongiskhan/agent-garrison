// The settings catalog — typed descriptors for EVERY key of Claude Code's
// settings.json, synced against the vendored official JSON Schema
// (src/lib/claude-settings-schema.json, source json.schemastore.org).
//
// tests/settings-catalog.test.ts mechanically enforces the sync: completeness
// in both directions, enum/bound equality, managed-only markers, the
// permission-rule pattern, and hook event names. On a Claude Code version
// bump: `npm run refresh:settings-schema` then `npm test` — the failing spec
// names exactly which line here needs editing.
//
// The catalog is the typed-controls layer ONLY. It never gates what may be
// written: keys absent from it (bespoke/experimental) round-trip untouched
// through the Advanced passthrough in the Settings panel.

export type ControlType =
  | "boolean" //         checkbox, saves immediately
  | "string" //          text input ("" -> unset at top level)
  | "number" //          number input honouring min/max/integer
  | "enum" //            select with an explicit (unset) option
  | "string-list" //     row-per-entry list editor (checkbox variant when enumValues set)
  | "string-map" //      key -> string value rows (env, modelOverrides)
  | "enum-map" //        key -> enum value rows (skillOverrides)
  | "string-list-map" // key -> string[] rows (sandbox.ignoreViolations)
  | "permission-rules" //rule rows with tool select + specifier (permissions.allow/deny/ask)
  | "object-form" //     structured sub-form over `fields`, recursive
  | "json"; //           validated raw-JSON textarea (deep unions, map-of-objects)

export type SettingGroupId =
  | "model"
  | "permissions"
  | "sandbox"
  | "hooks"
  | "mcp"
  | "plugins"
  | "skills"
  | "memory"
  | "git"
  | "terminal"
  | "sessions"
  | "auth"
  | "env"
  | "updates"
  | "enterprise";

// Back-compat alias (pre-catalog name used by the panel and tests).
export type SettingGroup = SettingGroupId;

export interface FieldDesc {
  key: string; //   subkey; the chain mirrors the schema properties path
  label: string;
  doc?: string;
  control: ControlType;
  enumValues?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  required?: boolean; //               e.g. statusLine.command
  constValue?: string; //              e.g. statusLine.type = "command" (auto-injected)
  emptyStringMeaningful?: boolean; //  attribution: "" hides attribution, distinct from unset
  managedOnly?: boolean; //            nested managed-only (sandbox.bwrapPath, ...)
  placeholder?: string;
  fields?: FieldDesc[]; //             when control === "object-form"
}

export interface KnownSetting {
  key: string;
  label: string;
  control: ControlType;
  group: SettingGroupId;
  doc: string;
  docsUrl?: string; //                 lifted verbatim from the schema description
  enumValues?: string[]; //            enum values (for enum-map: the VALUE enum)
  min?: number;
  max?: number;
  integer?: boolean;
  placeholder?: string;
  fields?: FieldDesc[];
  managedOnly?: boolean; //            only honoured in IT-deployed managed-settings.json
  machineManaged?: boolean; //         usually written by Claude Code itself
  deprecated?: boolean; //             schema description carries DEPRECATED
  keySuggestionsSource?: "skills" | "mcpServers"; // datalist feed for map keys / list rows
}

export const GROUP_ORDER: { id: SettingGroupId; label: string }[] = [
  { id: "model", label: "Model & reasoning" },
  { id: "permissions", label: "Permissions" },
  { id: "sandbox", label: "Sandbox" },
  { id: "hooks", label: "Hooks & automation" },
  { id: "mcp", label: "MCP servers" },
  { id: "plugins", label: "Plugins & marketplaces" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Files, memory & context" },
  { id: "git", label: "Git & attribution" },
  { id: "terminal", label: "Terminal & display" },
  { id: "sessions", label: "Sessions & worktrees" },
  { id: "auth", label: "Auth & credentials" },
  { id: "env", label: "Environment variables" },
  { id: "updates", label: "Updates & diagnostics" },
  { id: "enterprise", label: "Enterprise / managed-only" }
];

// Tool prefixes of the schema's permission-rule pattern, in schema order.
export const PERMISSION_TOOL_PREFIXES: string[] = [
  "Agent",
  "Bash",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write"
];

// Byte-equal to $defs.permissionRule.pattern in the vendored schema (asserted).
export const PERMISSION_RULE_PATTERN = `^((${PERMISSION_TOOL_PREFIXES.join(
  "|"
)})(\\([^)]+\\))?|mcp__.*)$`;

// Hook event names from the schema's hooks block, alphabetical (asserted).
// Settings renders hooks read-only; CRUD lives in Quarters > Hooks.
export const HOOK_EVENT_NAMES: string[] = [
  "ConfigChange",
  "CwdChanged",
  "Elicitation",
  "ElicitationResult",
  "FileChanged",
  "InstructionsLoaded",
  "Notification",
  "PermissionDenied",
  "PermissionRequest",
  "PostCompact",
  "PostToolBatch",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PreToolUse",
  "SessionEnd",
  "SessionStart",
  "Setup",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TaskCompleted",
  "TaskCreated",
  "TeammateIdle",
  "UserPromptExpansion",
  "UserPromptSubmit",
  "WorktreeCreate",
  "WorktreeRemove"
];

const DOCS = "https://code.claude.com/docs/en";

export const KNOWN_SETTINGS: KnownSetting[] = [
  // ── Model & reasoning ────────────────────────────────────────────────────
  {
    key: "model",
    label: "Model",
    control: "string",
    group: "model",
    doc: "Override the default model. Env vars (ANTHROPIC_MODEL, per-class pins) give finer control.",
    docsUrl: `${DOCS}/model-config`,
    placeholder: "claude-sonnet-4-6"
  },
  {
    key: "availableModels",
    label: "Available models",
    control: "string-list",
    group: "model",
    doc: "Restrict which models can be selected. Arrays merge and dedupe across settings levels.",
    docsUrl: `${DOCS}/model-config#restrict-model-selection`,
    placeholder: "claude-opus-4-8"
  },
  {
    key: "modelOverrides",
    label: "Model ID overrides",
    control: "string-map",
    group: "model",
    doc: "Map Anthropic model IDs to provider-specific IDs (Bedrock ARNs, Vertex versions, Foundry deployments).",
    docsUrl: `${DOCS}/model-config#override-model-ids-per-version`,
    placeholder: "claude-sonnet-4-6"
  },
  {
    key: "effortLevel",
    label: "Effort level",
    control: "enum",
    group: "model",
    doc: "Persist adaptive reasoning effort across sessions. Support varies by model; xhigh falls back to high where unsupported.",
    docsUrl: `${DOCS}/model-config#adjust-effort-level`,
    enumValues: ["low", "medium", "high", "xhigh", "max"],
    machineManaged: true
  },
  {
    key: "fastMode",
    label: "Fast mode",
    control: "boolean",
    group: "model",
    doc: "Faster output at higher per-token cost (defaults to Opus 4.7). Requires extra usage; toggle with /fast.",
    docsUrl: `${DOCS}/fast-mode`
  },
  {
    key: "fastModePerSessionOptIn",
    label: "Fast mode per-session opt-in",
    control: "boolean",
    group: "model",
    doc: "Fast mode no longer persists across sessions; each session must enable it with /fast. Useful for cost control.",
    docsUrl: `${DOCS}/fast-mode`
  },
  {
    key: "alwaysThinkingEnabled",
    label: "Always thinking",
    control: "boolean",
    group: "model",
    doc: "Enable extended thinking by default for all sessions. Typically set via /config.",
    docsUrl: `${DOCS}/common-workflows#use-extended-thinking-thinking-mode`,
    machineManaged: true
  },
  {
    key: "agent",
    label: "Main-thread agent",
    control: "string",
    group: "model",
    doc: "Run the main thread as a named agent (built-in or custom): its system prompt, tool restrictions and model apply.",
    docsUrl: `${DOCS}/sub-agents`,
    placeholder: "Explore"
  },
  {
    key: "outputStyle",
    label: "Output style",
    control: "string",
    group: "model",
    doc: "Output style for responses. Built-ins: default, Explanatory, Learning; custom styles live in output-styles/.",
    docsUrl: `${DOCS}/output-styles`,
    placeholder: "Explanatory"
  },

  // ── Permissions ──────────────────────────────────────────────────────────
  {
    key: "permissions",
    label: "Permissions",
    control: "object-form",
    group: "permissions",
    doc: "Tool usage permissions: allow / deny / ask rules, default mode, and extra directories in scope.",
    docsUrl: `${DOCS}/permissions`,
    fields: [
      {
        key: "allow",
        label: "Allow rules",
        control: "permission-rules",
        doc: "Rules for operations that run without prompting."
      },
      {
        key: "deny",
        label: "Deny rules",
        control: "permission-rules",
        doc: "Rules for blocked operations. Evaluated before allow."
      },
      {
        key: "ask",
        label: "Ask rules",
        control: "permission-rules",
        doc: "Rules that always prompt for confirmation."
      },
      {
        key: "defaultMode",
        label: "Default mode",
        control: "enum",
        enumValues: ["acceptEdits", "bypassPermissions", "default", "delegate", "dontAsk", "plan", "auto"],
        doc: "default prompts on first use; acceptEdits auto-accepts edits; plan is read-only; auto applies background safety checks."
      },
      {
        key: "disableBypassPermissionsMode",
        label: "Disable bypass mode",
        control: "enum",
        enumValues: ["disable"],
        doc: 'Set to "disable" to remove the ability to bypass permission prompts.'
      },
      {
        key: "disableAutoMode",
        label: "Disable auto mode",
        control: "enum",
        enumValues: ["disable"],
        doc: 'Set to "disable" to remove auto from the mode cycle and reject --permission-mode auto.'
      },
      {
        key: "additionalDirectories",
        label: "Additional directories",
        control: "string-list",
        doc: "Extra directories included in the permission scope.",
        placeholder: "~/shared-code"
      }
    ]
  },
  {
    key: "autoMode",
    label: "Auto mode classifier",
    control: "object-form",
    group: "permissions",
    doc: 'Tune the auto-mode classifier. Each section REPLACES the built-in rules unless "$defaults" appears as an entry.',
    docsUrl: `${DOCS}/permissions`,
    fields: [
      {
        key: "allow",
        label: "Allow rules",
        control: "string-list",
        doc: 'Classifier allow section. Include "$defaults" to splice the built-ins in.'
      },
      {
        key: "soft_deny",
        label: "Soft-deny rules",
        control: "string-list",
        doc: 'Classifier soft-deny section. Include "$defaults" to splice the built-ins in.'
      },
      {
        key: "hard_deny",
        label: "Hard-deny rules",
        control: "string-list",
        doc: "Block unconditionally, regardless of user intent."
      },
      {
        key: "environment",
        label: "Environment context",
        control: "string-list",
        doc: "Context entries describing this machine (e.g. solo developer, no shared infra)."
      }
    ]
  },
  {
    key: "useAutoModeDuringPlan",
    label: "Auto mode during plan",
    control: "boolean",
    group: "permissions",
    doc: "Apply the auto-mode classifier in plan mode to auto-approve safe read-only calls. Needs auto mode allowed.",
    docsUrl: `${DOCS}/permissions`
  },
  {
    key: "skipDangerousModePermissionPrompt",
    label: "Bypass-mode dialog accepted",
    control: "boolean",
    group: "permissions",
    doc: "Records acceptance of the bypass-permissions dialog. Typically managed by the CLI rather than set by hand.",
    machineManaged: true
  },
  {
    key: "skipWebFetchPreflight",
    label: "Skip WebFetch preflight",
    control: "boolean",
    group: "permissions",
    doc: "Skip the WebFetch blocklist check (for enterprise environments with restrictive policies).",
    docsUrl: `${DOCS}/settings#available-settings`
  },

  // ── Sandbox ──────────────────────────────────────────────────────────────
  {
    key: "sandbox",
    label: "Sandbox",
    control: "object-form",
    group: "sandbox",
    doc: "OS-level sandboxing for Bash: filesystem and network isolation, exclusions, proxies.",
    docsUrl: `${DOCS}/sandboxing`,
    fields: [
      { key: "enabled", label: "Enabled", control: "boolean", doc: "Enable sandboxed bash." },
      {
        key: "autoAllowBashIfSandboxed",
        label: "Auto-allow sandboxed bash",
        control: "boolean",
        doc: "Skip permission prompts for commands that will run sandboxed."
      },
      {
        key: "allowUnsandboxedCommands",
        label: "Allow unsandboxed escape",
        control: "boolean",
        doc: "Permit the dangerouslyDisableSandbox parameter. When false it is ignored and everything runs sandboxed."
      },
      {
        key: "excludedCommands",
        label: "Excluded commands",
        control: "string-list",
        doc: "Commands that never run in the sandbox.",
        placeholder: "docker"
      },
      {
        key: "filesystem",
        label: "Filesystem",
        control: "object-form",
        doc: "Filesystem access control for sandboxed commands.",
        fields: [
          {
            key: "allowWrite",
            label: "Allow write",
            control: "string-list",
            doc: "Writable paths. Prefixes: // absolute, ~/ home, ./ or bare relative.",
            placeholder: "~/.cache"
          },
          {
            key: "denyWrite",
            label: "Deny write",
            control: "string-list",
            doc: "Paths explicitly denied write access. Takes precedence over allow."
          },
          {
            key: "denyRead",
            label: "Deny read",
            control: "string-list",
            doc: "Paths denied read access.",
            placeholder: "~/.ssh"
          },
          {
            key: "allowRead",
            label: "Allow read",
            control: "string-list",
            doc: "Paths re-allowed within denyRead regions."
          },
          {
            key: "allowManagedReadPathsOnly",
            label: "Managed read paths only",
            control: "boolean",
            doc: "Only allowRead paths from managed settings apply.",
            managedOnly: true
          }
        ]
      },
      {
        key: "network",
        label: "Network",
        control: "object-form",
        doc: "Network isolation: domains, Unix sockets, proxy ports.",
        fields: [
          {
            key: "allowedDomains",
            label: "Allowed domains",
            control: "string-list",
            doc: "Domain allowlist; wildcard patterns like *.example.com supported.",
            placeholder: "github.com"
          },
          {
            key: "deniedDomains",
            label: "Denied domains",
            control: "string-list",
            doc: "Blocked domains, even when a broader allow wildcard would permit them."
          },
          {
            key: "allowUnixSockets",
            label: "Allowed Unix sockets",
            control: "string-list",
            doc: "Socket paths allowed for local IPC (SSH agent, Docker)."
          },
          {
            key: "allowAllUnixSockets",
            label: "Allow all Unix sockets",
            control: "boolean",
            doc: "Overrides the socket allowlist entirely."
          },
          {
            key: "allowLocalBinding",
            label: "Allow local binding",
            control: "boolean",
            doc: "Allow binding to localhost ports."
          },
          {
            key: "allowMachLookup",
            label: "Allowed Mach services",
            control: "string-list",
            doc: "macOS XPC/Mach service names the sandbox may look up (trailing * prefix match)."
          },
          {
            key: "allowManagedDomainsOnly",
            label: "Managed domains only",
            control: "boolean",
            doc: "Only managed-settings domains apply; others are blocked without prompts.",
            managedOnly: true
          },
          {
            key: "httpProxyPort",
            label: "HTTP proxy port",
            control: "number",
            min: 1,
            max: 65535,
            integer: true,
            doc: "Custom HTTP proxy port for network filtering; auto-started when unset."
          },
          {
            key: "socksProxyPort",
            label: "SOCKS proxy port",
            control: "number",
            min: 1,
            max: 65535,
            integer: true,
            doc: "Custom SOCKS proxy port for network filtering; auto-started when unset."
          }
        ]
      },
      {
        key: "ignoreViolations",
        label: "Ignore violations",
        control: "string-list-map",
        doc: 'Command pattern to filesystem paths whose violations are ignored. "*" matches all commands.'
      },
      {
        key: "ripgrep",
        label: "Ripgrep override",
        control: "object-form",
        doc: "Replace the bundled ripgrep binary and arguments.",
        fields: [
          { key: "command", label: "Command", control: "string", required: true, doc: "Path to the ripgrep binary." },
          { key: "args", label: "Arguments", control: "string-list", doc: "Extra arguments for the binary." }
        ]
      },
      {
        key: "enableWeakerNetworkIsolation",
        label: "Weaker network isolation",
        control: "boolean",
        doc: "macOS: allow the system TLS trust service in-sandbox (needed by Go tools behind a MITM proxy). Reduces security."
      },
      {
        key: "enableWeakerNestedSandbox",
        label: "Weaker nested sandbox",
        control: "boolean",
        doc: "For unprivileged Docker where /proc mounting fails. Significantly weakens the sandbox."
      },
      {
        key: "failIfUnavailable",
        label: "Fail if unavailable",
        control: "boolean",
        doc: "Hard-fail startup when sandbox dependencies are missing (default skips with a warning)."
      },
      {
        key: "enabledPlatforms",
        label: "Enabled platforms",
        control: "string-list",
        enumValues: ["macos", "linux", "wsl", "windows"],
        doc: "Limit the sandbox config to these platforms; elsewhere it is inert. Only honored from managed settings.",
        managedOnly: true
      },
      {
        key: "bwrapPath",
        label: "bwrap path",
        control: "string",
        doc: "Custom bubblewrap binary for the Linux/WSL sandbox.",
        managedOnly: true
      },
      {
        key: "socatPath",
        label: "socat path",
        control: "string",
        doc: "Custom socat binary for Linux/WSL network proxying.",
        managedOnly: true
      }
    ]
  },

  // ── Hooks & automation ───────────────────────────────────────────────────
  {
    key: "disableAllHooks",
    label: "Disable all hooks",
    control: "boolean",
    group: "hooks",
    doc: "Disable all hooks and statusLine execution. In managed settings this cannot be overridden.",
    docsUrl: `${DOCS}/hooks#disable-or-remove-hooks`
  },
  {
    key: "allowedHttpHookUrls",
    label: "Allowed HTTP hook URLs",
    control: "string-list",
    group: "hooks",
    doc: "URL patterns HTTP hooks may target (* wildcard). Empty array blocks all HTTP hooks; unset means no restriction.",
    docsUrl: `${DOCS}/settings#hook-configuration`,
    placeholder: "https://localhost:*"
  },
  {
    key: "httpHookAllowedEnvVars",
    label: "HTTP hook env vars",
    control: "string-list",
    group: "hooks",
    doc: "Env var names HTTP hooks may interpolate into headers; each hook's list is intersected with this one.",
    docsUrl: `${DOCS}/settings#hook-configuration`,
    placeholder: "HOOK_API_TOKEN"
  },

  // ── MCP servers ──────────────────────────────────────────────────────────
  {
    key: "enableAllProjectMcpServers",
    label: "Auto-approve project MCP servers",
    control: "boolean",
    group: "mcp",
    doc: "Automatically approve every server from a project's .mcp.json.",
    docsUrl: `${DOCS}/mcp`
  },
  {
    key: "enabledMcpjsonServers",
    label: "Approved .mcp.json servers",
    control: "string-list",
    group: "mcp",
    doc: "Approved MCP servers from .mcp.json.",
    docsUrl: `${DOCS}/mcp`,
    keySuggestionsSource: "mcpServers"
  },
  {
    key: "disabledMcpjsonServers",
    label: "Rejected .mcp.json servers",
    control: "string-list",
    group: "mcp",
    doc: "Rejected MCP servers from .mcp.json.",
    docsUrl: `${DOCS}/mcp`,
    keySuggestionsSource: "mcpServers"
  },
  {
    key: "channelsEnabled",
    label: "Channels enabled",
    control: "boolean",
    group: "mcp",
    doc: "Teams/Enterprise opt-in for channel notifications: MCP servers with the claude/channel capability can push inbound messages.",
    docsUrl: `${DOCS}/mcp`
  },

  // ── Plugins & marketplaces ───────────────────────────────────────────────
  {
    key: "enabledPlugins",
    label: "Enabled plugins",
    control: "json",
    group: "plugins",
    doc: 'Map of "plugin@marketplace" to true/false (or a string array of components). Example: { "formatter@anthropic-tools": true }.',
    docsUrl: `${DOCS}/plugins`
  },
  {
    key: "pluginConfigs",
    label: "Plugin configs",
    control: "json",
    group: "plugins",
    doc: "Per-plugin configuration (MCP server user configs, plugin options) keyed by plugin@marketplace ID.",
    docsUrl: `${DOCS}/plugins`
  },
  {
    key: "extraKnownMarketplaces",
    label: "Extra marketplaces",
    control: "json",
    group: "plugins",
    doc: "Additional plugin marketplaces by name, each with a source (url, github, git, npm, file, directory, hostPattern).",
    docsUrl: `${DOCS}/plugin-marketplaces`
  },
  {
    key: "skippedMarketplaces",
    label: "Skipped marketplaces",
    control: "string-list",
    group: "plugins",
    doc: "Marketplace names declined when prompted to install.",
    machineManaged: true
  },
  {
    key: "skippedPlugins",
    label: "Skipped plugins",
    control: "string-list",
    group: "plugins",
    doc: "Plugin IDs (plugin@marketplace) declined when prompted to install.",
    machineManaged: true
  },

  // ── Skills ───────────────────────────────────────────────────────────────
  {
    key: "skillOverrides",
    label: "Skill visibility",
    control: "enum-map",
    group: "skills",
    doc: "Per-skill visibility: on (default), name-only, user-invocable-only (/ picker only), off. Plugin skills unaffected.",
    docsUrl: `${DOCS}/skills#override-skill-visibility-from-settings`,
    enumValues: ["on", "name-only", "user-invocable-only", "off"],
    keySuggestionsSource: "skills"
  },
  {
    key: "disableSkillShellExecution",
    label: "Disable skill shell execution",
    control: "boolean",
    group: "skills",
    doc: "Disable inline shell execution in skills and custom slash commands (bundled and managed skills unaffected).",
    docsUrl: `${DOCS}/settings#available-settings`
  },

  // ── Files, memory & context ──────────────────────────────────────────────
  {
    key: "autoMemoryEnabled",
    label: "Auto memory",
    control: "boolean",
    group: "memory",
    doc: "Automatic memory saves capturing useful context. Also via CLAUDE_CODE_DISABLE_AUTO_MEMORY.",
    docsUrl: `${DOCS}/memory#auto-memory`
  },
  {
    key: "autoMemoryDirectory",
    label: "Auto memory directory",
    control: "string",
    group: "memory",
    doc: "Custom auto-memory location (~/ supported). Ignored in checked-in project settings for security.",
    docsUrl: `${DOCS}/memory`,
    placeholder: "~/.claude/memory"
  },
  {
    key: "claudeMdExcludes",
    label: "CLAUDE.md excludes",
    control: "string-list",
    group: "memory",
    doc: "Glob patterns (vs absolute paths) of CLAUDE.md files to skip loading. Useful in monorepos.",
    docsUrl: `${DOCS}/memory#exclude-specific-claude-md-files`,
    placeholder: "**/archived/**/CLAUDE.md"
  },
  {
    key: "plansDirectory",
    label: "Plans directory",
    control: "string",
    group: "memory",
    doc: "Where plan files are stored (default ~/.claude/plans; relative paths resolve from the project root).",
    placeholder: "~/.claude/plans"
  },
  {
    key: "respectGitignore",
    label: "Respect .gitignore",
    control: "boolean",
    group: "memory",
    doc: "The @ file picker excludes files matching .gitignore patterns (default on)."
  },
  {
    key: "fileSuggestion",
    label: "File suggestion script",
    control: "object-form",
    group: "memory",
    doc: "Custom script backing @ file autocomplete; receives the query as JSON on stdin.",
    docsUrl: `${DOCS}/settings#file-suggestion-settings`,
    fields: [
      { key: "type", label: "Type", control: "string", required: true, constValue: "command", doc: 'Always "command".' },
      { key: "command", label: "Command", control: "string", required: true, doc: "Shell command to execute for suggestions." }
    ]
  },

  // ── Git & attribution ────────────────────────────────────────────────────
  {
    key: "attribution",
    label: "Attribution",
    control: "object-form",
    group: "git",
    doc: "Co-authorship text for commits and PRs. Empty string hides attribution entirely.",
    docsUrl: `${DOCS}/settings#attribution-settings`,
    fields: [
      {
        key: "commit",
        label: "Commit attribution",
        control: "string",
        emptyStringMeaningful: true,
        doc: "Trailer text for git commits; empty string hides it."
      },
      {
        key: "pr",
        label: "PR attribution",
        control: "string",
        emptyStringMeaningful: true,
        doc: "Attribution for pull request descriptions; empty string hides it."
      }
    ]
  },
  {
    key: "includeCoAuthoredBy",
    label: "Include co-authored-by",
    control: "boolean",
    group: "git",
    doc: "Deprecated: use attribution instead. Includes the co-authored-by Claude byline (default true).",
    deprecated: true
  },
  {
    key: "includeGitInstructions",
    label: "Git instructions in prompt",
    control: "boolean",
    group: "git",
    doc: "Include the built-in git commit / PR workflow instructions in the system prompt.",
    docsUrl: `${DOCS}/settings#available-settings`
  },
  {
    key: "prUrlTemplate",
    label: "PR URL template",
    control: "string",
    group: "git",
    doc: "URL template for PR badges; placeholders {host} {owner} {repo} {number} {url}. Points links at internal review tools.",
    docsUrl: `${DOCS}/settings#available-settings`,
    placeholder: "https://reviews.example.com/{owner}/{repo}/{number}"
  },

  // ── Terminal & display ───────────────────────────────────────────────────
  {
    key: "tui",
    label: "Terminal renderer",
    control: "enum",
    group: "terminal",
    doc: "fullscreen = flicker-free alt-screen renderer with virtualized scrollback; default = classic main-screen renderer.",
    docsUrl: `${DOCS}/settings#available-settings`,
    enumValues: ["fullscreen", "default"]
  },
  {
    key: "viewMode",
    label: "View mode",
    control: "enum",
    group: "terminal",
    doc: "Transcript view: default, verbose (expanded tool details), focus (prompt + one-line summaries + response).",
    docsUrl: `${DOCS}/settings#available-settings`,
    enumValues: ["default", "verbose", "focus"]
  },
  {
    key: "statusLine",
    label: "Status line",
    control: "object-form",
    group: "terminal",
    doc: "Custom status line script: receives JSON session data on stdin, prints the line to stdout.",
    docsUrl: `${DOCS}/statusline`,
    fields: [
      { key: "type", label: "Type", control: "string", required: true, constValue: "command", doc: 'Always "command".' },
      { key: "command", label: "Command", control: "string", required: true, doc: "Shell command or script path." },
      { key: "padding", label: "Padding", control: "number", doc: "Extra horizontal spacing characters (default 0)." },
      {
        key: "refreshInterval",
        label: "Refresh interval (s)",
        control: "number",
        min: 1,
        integer: true,
        doc: "Also re-run every N seconds, not just on events."
      },
      {
        key: "hideVimModeIndicator",
        label: "Hide vim mode indicator",
        control: "boolean",
        doc: "Suppress the built-in vim indicator when your script renders its own."
      }
    ]
  },
  {
    key: "subagentStatusLine",
    label: "Subagent status line",
    control: "object-form",
    group: "terminal",
    doc: "Status line for subagent sessions.",
    docsUrl: `${DOCS}/statusline#subagent-status-lines`,
    fields: [
      { key: "type", label: "Type", control: "string", required: true, constValue: "command", doc: 'Always "command".' },
      { key: "command", label: "Command", control: "string", required: true, doc: "Shell command for the subagent status line." }
    ]
  },
  {
    key: "spinnerTipsEnabled",
    label: "Spinner tips",
    control: "boolean",
    group: "terminal",
    doc: "Show tips in the spinner while Claude works (default on)."
  },
  {
    key: "spinnerTipsOverride",
    label: "Spinner tips override",
    control: "object-form",
    group: "terminal",
    doc: "Custom spinner tips, merged with or replacing the built-ins.",
    docsUrl: `${DOCS}/settings#available-settings`,
    fields: [
      {
        key: "excludeDefault",
        label: "Exclude defaults",
        control: "boolean",
        doc: "Show only the custom tips instead of merging with built-ins."
      },
      { key: "tips", label: "Tips", control: "string-list", required: true, doc: "Custom tip strings." }
    ]
  },
  {
    key: "spinnerVerbs",
    label: "Spinner verbs",
    control: "object-form",
    group: "terminal",
    doc: "Customize the verbs shown in spinner progress messages.",
    fields: [
      {
        key: "mode",
        label: "Mode",
        control: "enum",
        enumValues: ["append", "replace"],
        doc: "append adds to the default verbs; replace uses only yours."
      },
      { key: "verbs", label: "Verbs", control: "string-list", required: true, doc: "Custom spinner verbs." }
    ]
  },
  {
    key: "terminalProgressBarEnabled",
    label: "Terminal progress bar",
    control: "boolean",
    group: "terminal",
    doc: "Progress bar in supporting terminals (Windows Terminal, iTerm2). Default on."
  },
  {
    key: "showTurnDuration",
    label: "Show turn duration",
    control: "boolean",
    group: "terminal",
    doc: "Show turn duration messages after responses (default on)."
  },
  {
    key: "showThinkingSummaries",
    label: "Show thinking summaries",
    control: "boolean",
    group: "terminal",
    doc: "Show thinking summaries in the transcript view (Ctrl+O); off by default in interactive sessions.",
    docsUrl: `${DOCS}/settings#available-settings`
  },
  {
    key: "showClearContextOnPlanAccept",
    label: "Clear-context on plan accept",
    control: "boolean",
    group: "terminal",
    doc: 'The plan-approval dialog offers a "clear context" option (default off).'
  },
  {
    key: "prefersReducedMotion",
    label: "Reduced motion",
    control: "boolean",
    group: "terminal",
    doc: "Reduce or disable UI animations (spinners, shimmer, flashes) for accessibility."
  },
  {
    key: "voiceEnabled",
    label: "Voice dictation",
    control: "boolean",
    group: "terminal",
    doc: "Push-to-talk voice dictation. Typically written automatically by /voice; requires a Claude.ai account.",
    docsUrl: `${DOCS}/settings#available-settings`,
    machineManaged: true
  },
  {
    key: "defaultShell",
    label: "Default shell for !",
    control: "enum",
    group: "terminal",
    doc: "Shell for input-box ! commands. powershell needs CLAUDE_CODE_USE_POWERSHELL_TOOL=1 with pwsh on PATH.",
    docsUrl: `${DOCS}/settings#available-settings`,
    enumValues: ["bash", "powershell"]
  },
  {
    key: "language",
    label: "Response language",
    control: "string",
    group: "terminal",
    doc: "Preferred response language; also sets voice dictation language and tab title generation.",
    docsUrl: `${DOCS}/settings#available-settings`,
    placeholder: "japanese"
  },

  // ── Sessions & worktrees ─────────────────────────────────────────────────
  {
    key: "cleanupPeriodDays",
    label: "Cleanup period (days)",
    control: "number",
    group: "sessions",
    doc: "Days to retain sessions, orphaned subagent worktrees, tasks, shell snapshots and backups. Minimum 1.",
    docsUrl: `${DOCS}/settings#available-settings`,
    min: 1,
    integer: true
  },
  {
    key: "worktree",
    label: "Worktree sessions",
    control: "object-form",
    group: "sessions",
    doc: "Configuration for --worktree sessions.",
    docsUrl: `${DOCS}/settings#worktree-settings`,
    fields: [
      {
        key: "sparsePaths",
        label: "Sparse paths",
        control: "string-list",
        doc: "Directories checked out per worktree via sparse-checkout (cone mode); faster in large monorepos."
      },
      {
        key: "baseRef",
        label: "Base ref",
        control: "enum",
        enumValues: ["fresh", "head"],
        doc: "fresh branches from origin/<default>; head preserves unpushed local commits."
      },
      {
        key: "bgIsolation",
        label: "Background isolation",
        control: "enum",
        enumValues: ["worktree", "none"],
        doc: "worktree blocks main-checkout edits until EnterWorktree; none lets background jobs edit directly."
      }
    ]
  },
  {
    key: "teammateMode",
    label: "Teammate display",
    control: "enum",
    group: "sessions",
    doc: "How agent-team teammates display; auto picks split panes in tmux/iTerm2, in-process otherwise. Teams are experimental.",
    docsUrl: `${DOCS}/agent-teams`,
    enumValues: ["auto", "in-process", "tmux"]
  },

  // ── Auth & credentials ───────────────────────────────────────────────────
  {
    key: "apiKeyHelper",
    label: "API key helper",
    control: "string",
    group: "auth",
    doc: "Script that outputs authentication values when credentials are needed.",
    docsUrl: `${DOCS}/settings#available-settings`,
    placeholder: "~/bin/claude-api-key.sh"
  },
  {
    key: "awsAuthRefresh",
    label: "AWS auth refresh",
    control: "string",
    group: "auth",
    doc: "Script that refreshes AWS authentication (Bedrock).",
    docsUrl: `${DOCS}/settings#available-settings`
  },
  {
    key: "awsCredentialExport",
    label: "AWS credential export",
    control: "string",
    group: "auth",
    doc: "Script that exports AWS credentials as JSON.",
    docsUrl: `${DOCS}/settings#available-settings`
  },
  {
    key: "otelHeadersHelper",
    label: "OTel headers helper",
    control: "string",
    group: "auth",
    doc: "Script that outputs OpenTelemetry headers."
  },
  {
    key: "forceLoginMethod",
    label: "Force login method",
    control: "enum",
    group: "auth",
    doc: "claudeai for Claude Pro/Max accounts, console for Console billing.",
    enumValues: ["claudeai", "console"]
  },
  {
    key: "forceLoginOrgUUID",
    label: "Force login org UUID",
    control: "string",
    group: "auth",
    doc: "Organization UUID to use for OAuth login.",
    placeholder: "00000000-0000-0000-0000-000000000000"
  },

  // ── Environment variables ────────────────────────────────────────────────
  {
    key: "env",
    label: "Environment variables",
    control: "string-map",
    group: "env",
    doc: "Env vars applied to every session. Many settings dimensions exist only as env vars (timeouts, caching, experiments).",
    docsUrl: `${DOCS}/settings#environment-variables`,
    placeholder: "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
  },

  // ── Updates & diagnostics ────────────────────────────────────────────────
  {
    key: "autoUpdatesChannel",
    label: "Auto-updates channel",
    control: "enum",
    group: "updates",
    doc: "stable trails ~1 week and skips major regressions; latest (default) is the newest release.",
    enumValues: ["stable", "latest"]
  },
  {
    key: "minimumVersion",
    label: "Minimum version",
    control: "string",
    group: "updates",
    doc: "Lowest Claude Code version to stay on; prevents downgrades when switching channels.",
    docsUrl: `${DOCS}/settings#available-settings`,
    placeholder: "2.1.100"
  },
  {
    key: "feedbackSurveyRate",
    label: "Feedback survey rate",
    control: "number",
    group: "updates",
    doc: "Probability (0-1) that the session quality survey appears when eligible.",
    docsUrl: `${DOCS}/settings#available-settings`,
    min: 0,
    max: 1
  },
  {
    key: "disableDeepLinkRegistration",
    label: "Deep-link registration",
    control: "enum",
    group: "updates",
    doc: 'Set to "disable" to stop registering the claude:// protocol handler on startup.',
    docsUrl: `${DOCS}/settings#available-settings`,
    enumValues: ["disable"]
  },

  // ── Enterprise / managed-only ────────────────────────────────────────────
  {
    key: "allowedMcpServers",
    label: "Allowed MCP servers",
    control: "json",
    group: "enterprise",
    doc: "Enterprise allowlist of MCP servers ({serverName} | {serverCommand} | {serverUrl} entries). Empty array = none allowed.",
    docsUrl: `${DOCS}/mcp#restriction-options`,
    managedOnly: true
  },
  {
    key: "deniedMcpServers",
    label: "Denied MCP servers",
    control: "json",
    group: "enterprise",
    doc: "Enterprise denylist of MCP servers; takes precedence over the allowlist.",
    docsUrl: `${DOCS}/mcp#restriction-options`,
    managedOnly: true
  },
  {
    key: "allowManagedMcpServersOnly",
    label: "Managed MCP servers only",
    control: "boolean",
    group: "enterprise",
    doc: "Only the managed-settings MCP allowlist is respected; denylists still merge from all sources.",
    managedOnly: true
  },
  {
    key: "allowManagedHooksOnly",
    label: "Managed hooks only",
    control: "boolean",
    group: "enterprise",
    doc: "Prevent loading user, project and plugin hooks; only managed and SDK hooks run.",
    docsUrl: `${DOCS}/settings#hook-configuration`,
    managedOnly: true
  },
  {
    key: "allowManagedPermissionRulesOnly",
    label: "Managed permission rules only",
    control: "boolean",
    group: "enterprise",
    doc: "User and project settings cannot define allow/ask/deny rules; only managed rules apply.",
    docsUrl: `${DOCS}/settings#permission-settings`,
    managedOnly: true
  },
  {
    key: "allowedChannelPlugins",
    label: "Allowed channel plugins",
    control: "string-list",
    group: "enterprise",
    doc: "Plugin IDs whose MCP servers may advertise channel notifications when channels are enabled.",
    docsUrl: `${DOCS}/mcp`,
    managedOnly: true
  },
  {
    key: "blockedMarketplaces",
    label: "Blocked marketplaces",
    control: "json",
    group: "enterprise",
    doc: "Marketplace sources blocked before download (url, github, git, npm, file, directory, hostPattern, pathPattern entries).",
    managedOnly: true
  },
  {
    key: "strictKnownMarketplaces",
    label: "Marketplace allowlist",
    control: "json",
    group: "enterprise",
    doc: "Marketplaces users can add (exact source matching). Unset = no restriction; empty array = lockdown.",
    docsUrl: `${DOCS}/settings#strictknownmarketplaces`,
    managedOnly: true
  },
  {
    key: "strictPluginOnlyCustomization",
    label: "Plugin-only customization",
    control: "json",
    group: "enterprise",
    doc: 'true locks all four surfaces; an array locks specific ones (["skills","agents","hooks","mcp"]); false is a no-op.',
    docsUrl: `${DOCS}/plugins-reference`,
    managedOnly: true
  },
  {
    key: "pluginTrustMessage",
    label: "Plugin trust message",
    control: "string",
    group: "enterprise",
    doc: "Custom message appended to the plugin trust warning shown before installation.",
    docsUrl: `${DOCS}/settings#plugin-settings`,
    managedOnly: true
  },
  {
    key: "forceRemoteSettingsRefresh",
    label: "Force remote settings refresh",
    control: "boolean",
    group: "enterprise",
    doc: "Block CLI startup until remote managed settings are freshly fetched; fail-closed if the fetch fails.",
    docsUrl: `${DOCS}/server-managed-settings`,
    managedOnly: true
  },
  {
    key: "parentSettingsBehavior",
    label: "Parent settings behavior",
    control: "enum",
    group: "enterprise",
    doc: "How SDK managedSettings merge with inherited settings: first-wins (default) or merge arrays/objects.",
    docsUrl: `${DOCS}/server-managed-settings`,
    enumValues: ["first-wins", "merge"],
    managedOnly: true
  },
  {
    key: "wslInheritsWindowsSettings",
    label: "WSL inherits Windows settings",
    control: "boolean",
    group: "enterprise",
    doc: "WSL reads managed settings from the Windows policy chain too, Windows sources first. Needs admin-written policy.",
    docsUrl: `${DOCS}/settings#available-settings`,
    managedOnly: true
  },
  {
    key: "companyAnnouncements",
    label: "Company announcements",
    control: "string-list",
    group: "enterprise",
    doc: "Announcements shown at startup (one picked at random). Works at any settings level; intended for org deployment."
  }
];

export const KNOWN_KEYS: Set<string> = new Set(KNOWN_SETTINGS.map((s) => s.key));
