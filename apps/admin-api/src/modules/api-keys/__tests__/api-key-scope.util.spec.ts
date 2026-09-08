import { ApiKeyScope } from "../entities/api-key.entity";
import {
  TRIGGER_PATHS,
  isTaskTriggerPath,
  scopeAllows,
} from "../api-key-scope.util";

/**
 * AUTH-03: scope enforcement matrix — pure decision layer.
 * readonly = all reads; trigger = reads + POST task trigger; manage = all.
 */
describe("AUTH-03 api-key-scope.util", () => {
  describe("isTaskTriggerPath", () => {
    it("matches tasks/<id>/trigger for uuid/numeric ids", () => {
      expect(isTaskTriggerPath("tasks/abc-123/trigger")).toBe(true);
      expect(isTaskTriggerPath("tasks/42/trigger")).toBe(true);
    });

    it("rejects non-trigger and lookalike paths", () => {
      expect(isTaskTriggerPath("tasks/abc-123/pause")).toBe(false);
      expect(isTaskTriggerPath("tasks/batch/trigger")).toBe(false);
      expect(isTaskTriggerPath("tasks/trigger")).toBe(false);
      expect(isTaskTriggerPath("tasks/abc/trigger/extra")).toBe(false);
      expect(isTaskTriggerPath("api-keys")).toBe(false);
    });
  });

  describe("readonly scope", () => {
    const scope: ApiKeyScope = "readonly";
    it.each([
      ["GET", "tasks"],
      ["GET", "tasks/abc/executions"],
      ["HEAD", "metrics"],
      ["OPTIONS", "anything"],
    ])("allows %s %s", (method, path) => {
      expect(scopeAllows(scope, { method, path }).allowed).toBe(true);
    });

    it("blocks every write with a scope-naming 403 message", () => {
      const cases: Array<[string, string]> = [
        ["POST", "tasks/abc/trigger"],
        ["POST", "tasks"],
        ["PUT", "config/foo"],
        ["PATCH", "tasks/abc"],
        ["DELETE", "api-keys/3"],
      ];
      for (const [method, path] of cases) {
        const v = scopeAllows(scope, { method, path });
        expect(v.allowed).toBe(false);
        expect(v.reason).toContain("readonly");
      }
    });
  });

  describe("trigger scope", () => {
    const scope: ApiKeyScope = "trigger";
    it("allows POST tasks/<id>/trigger and batch/trigger", () => {
      expect(scopeAllows(scope, { method: "POST", path: "tasks/abc-1/trigger" }).allowed).toBe(true);
      for (const p of TRIGGER_PATHS) {
        expect(scopeAllows(scope, { method: "POST", path: p }).allowed).toBe(true);
      }
    });

    it("allows reads", () => {
      expect(scopeAllows(scope, { method: "GET", path: "tasks" }).allowed).toBe(true);
    });

    it("blocks other writes with a manage-naming message", () => {
      const cases: Array<[string, string]> = [
        ["POST", "tasks"],
        ["POST", "task-templates"],
        ["PUT", "config/foo"],
        ["DELETE", "tasks/abc"],
        ["POST", "tasks/batch/pause"],
      ];
      for (const [method, path] of cases) {
        const v = scopeAllows(scope, { method, path });
        expect(v.allowed).toBe(false);
        expect(v.reason).toContain("trigger");
        expect(v.reason).toContain("manage");
      }
    });
  });

  describe("manage scope", () => {
    const scope: ApiKeyScope = "manage";
    it("allows all writes (JWT-only surfaces are excluded at guard level, not here)", () => {
      const cases: Array<[string, string]> = [
        ["POST", "tasks"],
        ["DELETE", "tasks/abc"],
        ["PUT", "config/foo"],
        ["PATCH", "executors/1"],
        ["POST", "tasks/abc/trigger"],
      ];
      for (const [method, path] of cases) {
        expect(scopeAllows(scope, { method, path }).allowed).toBe(true);
      }
    });

    it("still allows reads", () => {
      expect(scopeAllows(scope, { method: "GET", path: "metrics" }).allowed).toBe(true);
    });
  });

  it("normalizes leading/trailing slashes and case of method", () => {
    expect(scopeAllows("readonly", { method: "post", path: "/tasks/1/trigger/" }).allowed).toBe(false);
    expect(scopeAllows("trigger", { method: "post", path: "/tasks/1/trigger/" }).allowed).toBe(true);
  });
});
