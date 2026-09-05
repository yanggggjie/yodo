import { ensureHomeLayout } from "../store/layout.ts";

/** 建立 ~/.yodo 数据目录（task/tmp/record/session + templates）。幂等。 */
export async function handleInit(): Promise<void> {
  ensureHomeLayout();
  console.log("yodo init ok");
}
