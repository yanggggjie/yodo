import * as fs from "node:fs";
import * as path from "node:path";
import { RECORDING_DIR, RECORD_DIR, RECORD_MAX_MS } from "../utils/constants.ts";
import { createLogger } from "../utils/logger.ts";
import { ensureHomeLayout } from "../store/layout.ts";
import { createRecordName } from "../store/repository.ts";
import type { CdpBrowser, CdpContext, RawCdpConnection } from "../browser/index.ts";
import {
  ActiveRecordStore,
  closeTrackedWindows,
  RecordWindowTracker,
  startCdpNetworkRecorder,
  startInjectEvents,
  type CdpNetworkRecorder,
  type InjectRecorder,
} from "./collect.ts";
import { loadAdblockEngine, runPipeline } from "./pipeline.ts";
import { saveRaw } from "../dev/raw.ts";
import {
  formatIdleStdout,
  formatRecordStartStdout,
  formatStopStdout,
  writeArtifacts,
} from "./write.ts";
import { DomRecordStore, pagesMissingScript } from "./dom.ts";

const logger = createLogger("record");

let networkRecorder: CdpNetworkRecorder | null = null;
let injectRecorder: InjectRecorder | null = null;
let domStore: DomRecordStore | null = null;
let active: ActiveRecordStore | null = null;
let windowTracker: RecordWindowTracker | null = null;
let recordRaw: RawCdpConnection | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;
let finishing: Promise<string> | null = null;
let adblockEngine: Awaited<ReturnType<typeof loadAdblockEngine>> | undefined;

function clearMaxTimer(): void {
  if (maxTimer) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
}

async function closeRecordWindows(): Promise<void> {
  const raw = recordRaw;
  const tracker = windowTracker;
  if (!raw || !tracker) return;
  await closeTrackedWindows(raw, tracker);
}

async function stopRecorders(): Promise<void> {
  await networkRecorder?.stop();
  networkRecorder = null;
  await injectRecorder?.stop();
  injectRecorder = null;
}

export function liveRecordName(): string | null {
  return active?.name ?? null;
}

export async function startRecord(
  browser: CdpBrowser,
  context: CdpContext,
  options: { name?: string },
): Promise<string> {
  if (active) throw new Error(`record ${active.name} 仍在进行`);
  ensureHomeLayout();
  let name = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = createRecordName(options.name);
    if (!fs.existsSync(path.join(RECORD_DIR, candidate))) {
      name = candidate;
      break;
    }
  }
  if (!name) throw new Error("无法生成唯一 record name");
  const recordDir = path.join(RECORDING_DIR, name);
  fs.mkdirSync(recordDir, { recursive: true });
  active = new ActiveRecordStore(name, Date.now(), recordDir);
  const tracker = new RecordWindowTracker();
  windowTracker = tracker;
  recordRaw = browser.raw;

  try {
    const raw = browser.raw;
    const { page, windowId } = await context.openRecordWindow();
    const bornTargetId = page.targetId;
    tracker.initWindow(bornTargetId, windowId);

    networkRecorder = await startCdpNetworkRecorder(raw, active, tracker);
    domStore = new DomRecordStore();
    adblockEngine = await loadAdblockEngine();

    injectRecorder = startInjectEvents(
      raw,
      active,
      tracker,
      domStore,
    );

    await networkRecorder.attachTarget(bornTargetId);

    maxTimer = setTimeout(() => {
      logger.info(`record timeout ${RECORD_MAX_MS}ms`);
      void finishRecord("stop");
    }, RECORD_MAX_MS);
    maxTimer.unref?.();

    logger.info(`recording ${name}`);
    return formatRecordStartStdout(active.name);
  } catch (error) {
    await stopRecorders().catch(() => {});
    await closeRecordWindows().catch(() => {});
    clearMaxTimer();
    active = null;
    windowTracker = null;
    recordRaw = null;
    throw error;
  }
}

async function doFinish(reason: "stop" | "abort" | "disconnect"): Promise<string> {
  if (!active) return formatIdleStdout();
  const current = active;
  clearMaxTimer();
  try {
    if (reason !== "abort" && domStore) {
    }
    await stopRecorders();
    domStore?.deactivate();
    await closeRecordWindows();
  } finally {
    current.deactivate();
    active = null;
    windowTracker = null;
    recordRaw = null;
  }

  if (reason === "abort") {
    fs.rmSync(current.recordDir, { recursive: true, force: true });
    current.events.length = 0;
    domStore = null;
    logger.info(`aborted ${current.name}`);
    return JSON.stringify({ status: "aborted", name: current.name }, null, 2);
  }

  try {
    saveRaw(current.name, current.events, domStore?.events ?? []);
    const { events: processed, stages } = runPipeline(current.events, adblockEngine);
    logger.info(`pipeline ${current.events.length} → ${processed.length}`, { data: { stages } });
    const domEvents = domStore?.events ?? [];
    const flushResult = await writeArtifacts(current.recordDir, processed, domEvents, current.name);
    const missing = domStore ? pagesMissingScript(current.events, domStore.ready) : [];
    if (missing.length) {
      flushResult.warnings = missing.map((origin) => `${origin} 的页面脚本没有生效，这个页面的点击、输入、滚动没有录到；请重新录制这一步`);
    }
    const finalDir = path.join(RECORD_DIR, current.name);
    if (fs.existsSync(finalDir)) throw new Error(`record 已存在：${current.name}`);
    fs.renameSync(current.recordDir, finalDir);
    flushResult.recordDir = finalDir;
    logger.info(`archived ${current.name}`);
    current.events.length = 0;
    domStore = null;
    return formatStopStdout(flushResult);
  } catch (error) {
    if (reason === "disconnect") {
      logger.warn(`disconnect flush failed for ${current.name}`, error);
      return JSON.stringify(
        { status: "aborted", name: current.name },
        null,
        2,
      );
    }
    throw error;
  }
}

export async function finishRecord(
  reason: "stop" | "abort" | "disconnect",
): Promise<string> {
  if (finishing) {
    await finishing;
    return active ? finishing : formatIdleStdout();
  }
  if (!active) return formatIdleStdout();
  finishing = doFinish(reason);
  try {
    return await finishing;
  } finally {
    finishing = null;
  }
}
