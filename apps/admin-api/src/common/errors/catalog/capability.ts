import type { ErrorCodeDef } from "../error-code-def";

/** LANG-ERR-01 · 能力注册域错误码分片（ADR-040 capability 注册表）。 */
export const CAPABILITY_CODES = {
  CAPABILITY_NOT_FOUND: {
    status: 404,
    zh: "能力不存在",
    en: "Capability not found",
  },
} as const satisfies Record<string, ErrorCodeDef>;
