import * as fs from "node:fs";
import * as path from "node:path";
import { ACTIVE_RECORD_DIR, RECORD_DIR, RECORD_MAX_MS } from "../utils/constants.js";
import { createLogger } from "../utils/logger.js";
import { ensureHomeLayout } from "../store/layout.js";
import {
  claimActive,
  releaseActive,
  sweepDeadActive,
  validateRecordName,
} from "../store/repository.js";
import type { CdpBrowser, CdpContext, RawCdpConnection } from "../browser/index.js";
import { setDiscoverTargets, setIgnoreCertificateErrors, setPageAutoAttach } from "../browser/index.js";
import {
  ActiveRecordStore,
  closeTrackedWindows,
  RecordWindowTracker,
  startCdpNetworkRecorder,
  startInjectEvents,
  type CdpNetworkRecorder,
  type InjectRecorder,
} from "./collect.js";
import { loadAdblockEngine, processTimelinePipeline } from "./pipeline.js";
import {
  formatIdleStdout,
  formatRecordStartStdout,
  formatStopStdout,
  writeArtifacts,
} from "./write.js";

const logger = createLogger("record");

let networkRecorder: CdpNetworkRecorder | null = null;
let injectRecorder: InjectRecorder | null = null;
let active: ActiveRecordStore | null = null;
let windowTracker: RecordWindowTracker | null = null;
let recordRaw: RawCdpConnection | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;
let finishing: Promise<string> | null = null;
let adblockEngine: Awaited<ReturnType<typeof loadAdblockEngine>> | undefined;

function nowId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function generatedName(): string {
  return `rec-${nowId()}`;
}

function normalizeGoal(goal?: string): string | undefined {
  const value = goal?.trim();
  if (!value) return undefined;
  if (value.length > 500) throw new Error("--goal 最多 500 个字符");
  return value;
}

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
  _context: CdpContext,
  options: { name?: string; goal?: string },
): Promise<string> {
  if (active) throw new Error(`record ${active.name} 仍在进行`);
  ensureHomeLayout();
  await sweepDeadActive();
  const name = validateRecordName(options.name?.trim() || generatedName());
  const goal = normalizeGoal(options.goal);
  await claimActive(name);
  const recordDir = path.join(ACTIVE_RECORD_DIR, name);
  active = new ActiveRecordStore(name, goal, Date.now(), recordDir);
  const tracker = new RecordWindowTracker();
  windowTracker = tracker;
  recordRaw = browser.raw;

  try {
    const raw = browser.raw;
    const bornRes = (await raw.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    })) as { targetId: string };
    const bornTargetId = bornRes.targetId;

    let winId: number | undefined;
    try {
      const win = (await raw.send("Browser.getWindowForTarget", {
        targetId: bornTargetId,
      })) as { windowId?: number };
      winId = win?.windowId;
    } catch {
      /* ignore */
    }

    if (winId !== undefined) {
      tracker.initWindow(bornTargetId, winId);
    } else {
      tracker.activeTargets.add(bornTargetId);
    }

    networkRecorder = await startCdpNetworkRecorder(raw, active, tracker);
    adblockEngine = await loadAdblockEngine();

    injectRecorder = startInjectEvents(
      raw,
      active,
      tracker,
      networkRecorder.sessionToTarget,
    );

    await networkRecorder.attachTarget(bornTargetId);

    maxTimer = setTimeout(() => {
      logger.info(`record timeout ${RECORD_MAX_MS}ms`);
      void finishRecord("stop");
    }, RECORD_MAX_MS);
    maxTimer.unref?.();

    logger.info(`recording ${name}`);
    return formatRecordStartStdout(recordDir, active.name);
  } catch (error) {
    await stopRecorders().catch(() => {});
    await closeRecordWindows().catch(() => {});
    await setDiscoverTargets(browser.raw, false).catch(() => {});
    await setPageAutoAttach(browser.raw, false).catch(() => {});
    await setIgnoreCertificateErrors(browser.raw, false).catch(() => {});
    await releaseActive(name).catch(() => {});
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
    await stopRecorders();
    await closeRecordWindows();
    if (recordRaw) await setIgnoreCertificateErrors(recordRaw, false);
  } finally {
    current.deactivate();
    active = null;
    windowTracker = null;
    recordRaw = null;
  }

  if (reason === "abort") {
    current.events.length = 0;
    await releaseActive(current.name);
    logger.info(`aborted ${current.name}`);
    return JSON.stringify({ status: "aborted", name: current.name }, null, 2);
  }

  try {
    const processed = processTimelinePipeline(current.events, adblockEngine);
    logger.info(`pipeline ${current.events.length} → ${processed.length}`);
    const flushResult = await writeArtifacts(current.recordDir, processed, current.name);
    const finalDir = path.join(RECORD_DIR, current.name);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(current.recordDir, finalDir);
    await releaseActive(current.name);
    flushResult.recordDir = finalDir;
    flushResult.timelineFile = path.join(finalDir, "timeline.jsonl");
    logger.info(`archived ${current.name} requests=${flushResult.requestsCount}`);
    current.events.length = 0;
    return formatStopStdout(flushResult);
  } catch (error) {
    if (reason === "disconnect") {
      await releaseActive(current.name).catch(() => {});
      logger.warn(`disconnect flush failed for ${current.name}`, error);
      return JSON.stringify(
        { status: "interrupted", name: current.name },
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
