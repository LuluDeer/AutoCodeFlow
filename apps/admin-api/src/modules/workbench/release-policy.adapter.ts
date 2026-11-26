/**
 * ADR-045：发布审批的当前策略指纹端口适配。
 * 四项策略键与 agent.controller.ts 的 phrase 路径（:934-948）逐字同口径，
 * 保证 request 时的指纹与 consume 时的当前指纹可比——策略变更使旧审批失效。
 */
import type { ConfigService } from "@nestjs/config";
import {
  computeApprovalPolicyFingerprint,
  type ApprovalPolicySnapshot,
} from "../agent/runtime/agent-approvals.service";
import type { ReleasePolicyPort } from "./release-approval.service";

const readBool = (
  config: ConfigService,
  key: string,
  fallback: boolean,
): boolean => {
  const raw = config.get<string | number | boolean | null | undefined>(key);
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return fallback;
};

export function releasePolicyAdapter(config: ConfigService): ReleasePolicyPort {
  return {
    currentFingerprint(): string | null {
      try {
        const snapshot: ApprovalPolicySnapshot = {
          writeRequiresApproval: readBool(
            config,
            "agent.policy.writeRequiresApproval",
            false,
          ),
          dangerousRequiresApproval: readBool(
            config,
            "agent.policy.dangerousRequiresApproval",
            true,
          ),
          allowDangerous: readBool(
            config,
            "agent.policy.allowDangerous",
            false,
          ),
          executableSourceGate: readBool(
            config,
            "agent.policy.executableSourceGate",
            true,
          ),
        };
        return computeApprovalPolicyFingerprint(snapshot);
      } catch {
        return null; // fail-closed：读不到策略就不发布
      }
    },
  };
}
