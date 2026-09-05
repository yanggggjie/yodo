/**
 * task 的统一入口：一处 import 拿到 yodo SDK + 常用 helper。
 * 位于 ~/.yodo/task/_common/；task 用 `import { yodo, pageForOrigin, serializeUrl } from "../task/_common/yodo.js"`。
 */
export { yodo } from "../../src/sdk.ts";
export { pageForOrigin } from "./page-for-origin.js";
export { serializeUrl, parseUrl } from "./url.js";
