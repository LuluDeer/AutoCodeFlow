# 生成类型（ARCH-23）

`api-types.ts` 由 openapi-typescript 从 `apps/admin-api/openapi.json` 生成，**勿手改**。

再生成（仓库根目录）：

```bash
npm run openapi:export        # admin-api 导出 openapi.json（需 DB+Redis）
npm run gen:api-types         # 生成 src/types/generated/api-types.ts
```

CI `api-types-drift` job 校验两者与库内版本逐字节一致——改了 API 契约（DTO/控制器装饰器）而没重新导出+生成时，CI 变红。

消费形态（openapi-typescript v7 风格）：

```ts
import type { components } from "@/types/generated/api-types";
type TaskRow = components["schemas"]["TaskDto"];
```

手写 interface（src/api/*.ts）渐进替换，不在 ARCH-23 本轮交付面。
