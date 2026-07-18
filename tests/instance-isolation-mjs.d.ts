declare module "*/kanban-loop/lib/resolved-model.mjs" {
  export function kanbanModelFile(root?: string): string;
}

declare module "*/kanban-loop/lib/discover.mjs" {
  export function listSkills(home?: string): Array<{ name: string; description: string }>;
}

declare module "*/improver/lib/skill-telemetry.mjs" {
  export function scanSkillTelemetry(opts?: {
    projectsDir?: string;
    now?: string | null;
    caps?: Record<string, number>;
  }): {
    bySkill: Record<string, any>;
    scanned: { files: number; lines: number; dropped: { files: number; lines: number; bytes: number } };
  };
}

declare module "*/power-default/scripts/server.mjs" {
  export function hostPowerActionsDisabled(env?: Record<string, string | undefined>): boolean;
}

declare module "@garrison/claude-pty" {
  export function enumerateCommands(opts?: {
    cwd?: string;
    home?: string;
    claudeHome?: string;
  }): Array<{ name: string; description: string; source: string; argumentHint?: string }>;
}

declare module "*/dev-env/scripts/tmux.mjs" {
  export const TMUX_SESSION_PREFIX: string;
  export const TMUX_SOCKET_PATH: string | null;
  export function tmuxSessionName(ptyId: string): string;
  export function attachOrCreateArgs(opts: {
    name: string;
    cwd: string;
    cols: number;
    rows: number;
    createCommand: string;
  }): string[];
}

declare module "*/scripts/repoint-scheduler-jobs.mjs" {
  export function rewriteJobCommands(
    jobs: Array<Record<string, unknown>>,
    fromPrefix: string,
    toPrefix: string
  ): {
    jobs: Array<Record<string, unknown>>;
    plan: Array<{
      id: string;
      changed: boolean;
      before: string | null;
      after: string | null;
    }>;
    changed: number;
    from: string;
    to: string;
  };
}
