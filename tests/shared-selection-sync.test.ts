import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ homes: vi.fn(), active: vi.fn(), state: vi.fn(), reconcile: vi.fn(), leaks: vi.fn() }));
vi.mock("@/lib/homes-migration", () => ({ readHomesState: mocks.homes }));
vi.mock("@/lib/active-composition", () => ({ resolveActiveComposition: mocks.active }));
vi.mock("@/lib/home-ownership", async importOriginal => ({ ...await importOriginal<object>(), readSharedState: mocks.state }));
vi.mock("@/lib/shared-fittings", () => ({ reconcileShared: mocks.reconcile }));
vi.mock("@/lib/home-leaks", () => ({ checkHomeLeaks: mocks.leaks }));
import { reconcileSavedSharing } from "@/lib/shared-selection-sync";
import type { Composition } from "@/lib/types";
const composition = { id: "default", selections: { memory: [{ id: "basic-memory", config: {}, shared: ["claude-code"] }] } } as Composition;
beforeEach(() => { vi.clearAllMocks(); mocks.homes.mockResolvedValue({ version: 2 }); mocks.active.mockResolvedValue({ id: "default" }); mocks.state.mockResolvedValue({ byRuntime: { "claude-code": [], codex: [], gemini: [] } }); });
describe("sharing saved selection reconciliation", () => {
  it("reconciles a migrated active composition then checks leaks", async () => { await reconcileSavedSharing(composition); expect(mocks.reconcile).toHaveBeenCalledWith(composition); expect(mocks.leaks).toHaveBeenCalledOnce(); });
  it("leaves legacy and inactive homes alone", async () => { mocks.homes.mockResolvedValueOnce(null); await reconcileSavedSharing(composition); mocks.active.mockResolvedValue({ id: "other" }); await reconcileSavedSharing(composition); expect(mocks.reconcile).not.toHaveBeenCalled(); });
  it("does not reinstall unchanged sharing", async () => { mocks.state.mockResolvedValue({ byRuntime: { "claude-code": ["basic-memory"], codex: [], gemini: [] } }); await reconcileSavedSharing(composition); expect(mocks.reconcile).not.toHaveBeenCalled(); });
  it("surfaces setup failures so the unchanged desired selection can retry", async () => { mocks.reconcile.mockRejectedValueOnce(new Error("setup failed")); await expect(reconcileSavedSharing(composition)).rejects.toThrow("setup failed"); await reconcileSavedSharing(composition); expect(mocks.reconcile).toHaveBeenCalledTimes(2); });
});
