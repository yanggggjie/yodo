import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件编译后位于 `dist/utils/`。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 编译产物根：`dist/`。 */
export const DIST_ROOT = path.join(HERE, "..");

/** 包根：含 `package.json`、`templates/`、`skills/`。 */
export const PKG_ROOT = path.join(HERE, "..", "..");
