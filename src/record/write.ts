import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeJsonAtomic, exists } from "../utils/fs.js";
import type {
  RawEvent,
  RawRequest,
  TimelineActionItem,
  TimelineRequestItem,
} from "./types.js";
import { isRawAction } from "./types.js";

export function sanitizeFileNamePart(str: string): string {
  return str.replace(/[^a-zA-Z0-9.-]/g, "_").replace(/_+/g, "_").slice(0, 40);
}

export function semanticRequestBaseName(seq: number, request: RawRequest): string {
  const seqStr = String(seq).padStart(2, "0");
  const method = (request.method || "GET").toUpperCase();
  let host = "unknown";
  let pathname = "";
  try {
    const u = new URL(request.url.bareUrl);
    host = sanitizeFileNamePart(u.hostname);
    pathname = sanitizeFileNamePart(u.pathname.replace(/^\//, ""));
  } catch {
    host = sanitizeFileNamePart(request.url.bareUrl || "url");
  }
  const part = pathname ? `${host}_${pathname}` : host;
  return `${seqStr}_${method}_${part}`;
}

export function cleanRequestJson(request: RawRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    frameUrl: request.frameUrl,
    headers: request.headers,
    ...(request.requestBody !== null && request.requestBody !== undefined
      ? { requestBody: request.requestBody }
      : {}),
    ...(request.requestBodyUnavailableReason
      ? { requestBodyUnavailableReason: request.requestBodyUnavailableReason }
      : {}),
    status: request.status ?? null,
    ...(request.responseHeaders ? { responseHeaders: request.responseHeaders } : {}),
    ...(request.responseBody !== null && request.responseBody !== undefined
      ? { responseBody: request.responseBody }
      : {}),
    ...(request.responseBodyPath ? { responseBodyPath: request.responseBodyPath } : {}),
    ...(request.responseBodyUnavailableReason
      ? { responseBodyUnavailableReason: request.responseBodyUnavailableReason }
      : {}),
    ...(request.errorText ? { errorText: request.errorText } : {}),
    ...(request.late ? { late: true } : {}),
    startedAt: request.startedAt,
    ...(request.endedAt != null ? { endedAt: request.endedAt } : {}),
  };
}

export async function writeSemanticRequestFile(
  recordDir: string,
  seq: number,
  request: RawRequest,
): Promise<string> {
  const baseName = semanticRequestBaseName(seq, request);
  let responseBodyPath = request.responseBodyPath;

  if (responseBodyPath) {
    const oldHtmlPath = path.join(recordDir, responseBodyPath);
    const newHtmlName = `${baseName}.response.html`;
    const newHtmlPath = path.join(recordDir, newHtmlName);
    if (await exists(oldHtmlPath)) {
      if (oldHtmlPath !== newHtmlPath) {
        await fs.rename(oldHtmlPath, newHtmlPath);
      }
      responseBodyPath = newHtmlName;
    }
  }

  const fileName = `${baseName}.json`;
  await writeJsonAtomic(
    path.join(recordDir, fileName),
    cleanRequestJson({ ...request, ...(responseBodyPath ? { responseBodyPath } : {}) }),
  );
  return fileName;
}

export type FlushResult = {
  name: string;
  recordDir: string;
  requestsCount: number;
  timelineFile: string;
};

export async function writeArtifacts(
  recordDir: string,
  timeline: RawEvent[],
  name: string,
): Promise<FlushResult> {
  let requestSeq = 0;
  const lines: string[] = [];

  for (const entry of timeline) {
    if (isRawAction(entry)) {
      const item: TimelineActionItem = {
        t: entry.startedAt,
        type: "action",
        actionType: entry.actionType,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.role ? { role: entry.role } : {}),
      };
      lines.push(JSON.stringify(item));
    } else {
      requestSeq++;
      const fileName = await writeSemanticRequestFile(recordDir, requestSeq, entry);
      const item: TimelineRequestItem = {
        t: entry.startedAt,
        type: "request",
        requestType: entry.requestType,
        method: entry.method,
        url: entry.url.bareUrl,
        file: fileName,
      };
      lines.push(JSON.stringify(item));
    }
  }

  const timelineFile = path.join(recordDir, "timeline.jsonl");
  await fs.writeFile(
    timelineFile,
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    "utf8",
  );

  return {
    name,
    recordDir,
    requestsCount: requestSeq,
    timelineFile,
  };
}

export function formatStopStdout(result: FlushResult): string {
  return JSON.stringify(
    {
      status: "stopped",
      name: result.name,
      recordDir: result.recordDir,
      requestsCount: result.requestsCount,
      timelineFile: result.timelineFile,
      hint: "读 timeline.jsonl 找接口。写 tmp/<probe>.js 试跑；优先走页内 XHR 借 SDK 签名；最多尝试 5 次，学不会即止。",
    },
    null,
    2,
  );
}

export function formatRecordStartStdout(recordDir: string, name: string): string {
  return JSON.stringify(
    {
      status: "recording",
      name,
      recordDir,
      guide: "请在新窗口做一遍。好了告诉我。",
    },
    null,
    2,
  );
}

export function formatIdleStdout(): string {
  return JSON.stringify({ status: "idle" }, null, 2);
}
