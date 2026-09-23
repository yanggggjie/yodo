import { ensureHolder, ensureSessionAndRpc, stopCurrentHolder } from "./cli/spawn.ts";
import { ensureHomeLayout } from "./store/layout.ts";
import { handleDoctor } from "./cli/doctor.ts";
import { CLI_RPC_BUFFER_MS, RECORD_STOP_RPC_MS } from "./utils/constants.ts";

function assertNode24(): void { const major = Number(process.versions.node.split(".")[0]); if (!Number.isFinite(major) || major < 24) throw new Error(`yodo 需要 Node >=24，当前 ${process.version}`); }
function print(value: unknown): void { if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2)); }
async function recordCall(method: "record.start" | "record.stop" | "record.abort", params: Record<string, unknown> | undefined, timeout: number): Promise<void> {
  try { print(await ensureSessionAndRpc(method, params, timeout)); }
  catch (error) {
    const value = error as { data?: { status?: string }; message?: string };
    if (value.data?.status) print({ status: value.data.status, guide: value.message ?? "" });
    else { print({ error: value.message ?? String(error) }); process.exitCode = 1; }
  }
}

export const control = {
  async start(): Promise<void> { assertNode24(); const blocked = await ensureHolder(); if (blocked) print({ status: (blocked.data as { status?: string })?.status, guide: blocked.message }); else print({ status: "ok" }); },
  async stop(): Promise<void> { assertNode24(); await stopCurrentHolder(); print({ status: "ok" }); },
  async init(): Promise<void> { assertNode24(); ensureHomeLayout(); console.log("yodo init ok"); },
  async doctor(): Promise<void> { assertNode24(); handleDoctor(); },
  record: {
    async start(name?: string): Promise<void> { assertNode24(); await recordCall("record.start", name ? { name } : undefined, 15_000); },
    async stop(): Promise<void> { assertNode24(); await recordCall("record.stop", undefined, RECORD_STOP_RPC_MS + CLI_RPC_BUFFER_MS); },
    async abort(): Promise<void> { assertNode24(); await recordCall("record.abort", undefined, 15_000); },
  },
};
