import * as fs from "fs";
import * as path from "path";

/**
 * W-22 regression guard. auth.controller's @Throttle limit is resolved at
 * DECORATOR-EVAL time (class definition), which runs when app.module first
 * enters the import graph. ConfigModule's dotenv load happens later (module
 * lifecycle), so a `.env`-only value is invisible to the decorator unless
 * main.ts preloads `.env` BEFORE app.module is imported. That preload +
 * dynamic-import is the whole fix; if someone "tidies" main.ts back to a
 * static `import { AppModule } from "./app.module"` at the top, the fix
 * silently reverts and `.env`-configured login throttling breaks again
 * (this is what the 29-case e2e hit as cascading 429s).
 *
 * ARCH-27: the raw `process.env.LOGIN_THROTTLE_LIMIT` read was consolidated
 * into src/config/env.ts's getEnvVar() (the only sanctioned escape hatch);
 * the eval-time semantics — and therefore this guard — are unchanged.
 *
 * Static source assertions cheaply pin the two invariants that make the fix
 * work, in the same spirit as the install.sh byte-identity guard.
 */
describe("main.ts env-preload ordering (W-22 guard)", () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "main.ts"),
    "utf8",
  );
  // strip line+block comments so an explanatory comment mentioning the banned
  // static import doesn't false-trip the guard
  const code = mainSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("does NOT statically import app.module (must stay dynamic, after preload)", () => {
    expect(code).not.toMatch(
      /import\s+(type\s+)?\{[^}]*\bAppModule\b[^}]*\}\s+from\s+["']\.\/app\.module["']/,
    );
    expect(code).toMatch(/await import\(["']\.\/app\.module["']\)/);
  });

  it("loads the .env file via dotenv before NestFactory.create", () => {
    const preloadAt = code.indexOf("loadEnvFile(");
    const createAt = code.indexOf("NestFactory.create");
    expect(preloadAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(preloadAt);
    // preload must target a .env path, not a bare config()
    expect(code).toMatch(/loadEnvFile\(\s*\{\s*path:/);
  });

  it("auth.controller still resolves the throttle limit at decorator-eval time via the env.ts util (couple the guard to the site it protects)", () => {
    const authSrc = fs.readFileSync(
      path.join(__dirname, "..", "modules", "auth", "auth.controller.ts"),
      "utf8",
    );
    // ARCH-27: 直读已收口为 getEnvVar（全仓唯一直读通道），但求值期语义
    // 不变 —— 仍依赖 main.ts 在 import app.module 前预载 .env。
    expect(authSrc).toMatch(/getEnvVar\(\s*["']LOGIN_THROTTLE_LIMIT["']\s*\)/);
    // 禁止回退到裸 process.env 直读（W-22 死配置模式）。
    expect(authSrc).not.toMatch(/process\.env\.LOGIN_THROTTLE_LIMIT/);
  });
});
