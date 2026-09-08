import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件位于 `<src>/utils/`。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 源码根：`<src>`，含 `holder.ts`、`templates/`；依赖在同目录 `node_modules/`（setup 安装）。 */
export const SRC_ROOT = path.join(HERE, "..");
