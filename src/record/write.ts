import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RESPONSE_SPLIT_BYTES } from "../utils/constants.js";
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
  const method = request.late ? "late" : (request.method || "GET").toUpperCase();
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
    ...(request.late ? { late: true } : {}),
    ...(request.late || !request.method ? {} : { method: request.method }),
    url: request.url,
    frameUrl: request.frameUrl,
    headers: request.headers,
    ...(request.requestBody !== null && request.requestBody !== undefined
      ? { requestBody: request.requestBody }
      : {}),
    ...(request.requestBodyUnavailableReason
      ? { requestBodyUnavailableReason: request.requestBodyUnavailableReason }
      : {}),
    ...(request.late ? {} : { status: request.status ?? null }),
    ...(request.responseHeaders ? { responseHeaders: request.responseHeaders } : {}),
    ...(request.responseBodyPath
      ? { responseBodyPath: request.responseBodyPath }
      : request.responseBody !== null && request.responseBody !== undefined
        ? { responseBody: request.responseBody }
        : {}),
    ...(request.responseBodyUnavailableReason
      ? { responseBodyUnavailableReason: request.responseBodyUnavailableReason }
      : {}),
    ...(request.errorText ? { errorText: request.errorText } : {}),
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
  let responseBody = request.responseBody;

  if (!responseBodyPath && responseBody !== null && responseBody !== undefined) {
    const raw =
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    if (Buffer.byteLength(raw) > RESPONSE_SPLIT_BYTES) {
      const html =
        request.requestType === "mainDoc" || request.requestType === "doc";
      const ext = html ? ".html" : ".json";
      const peeled = `${baseName}.response${ext}`;
      await fs.writeFile(path.join(recordDir, peeled), raw, "utf8");
      responseBodyPath = peeled;
      responseBody = null;
    }
  }

  if (responseBodyPath) {
    const oldPath = path.join(recordDir, responseBodyPath);
    const ext = path.extname(responseBodyPath) || ".html";
    const newName = `${baseName}.response${ext}`;
    const newPath = path.join(recordDir, newName);
    if (await exists(oldPath)) {
      if (oldPath !== newPath) await fs.rename(oldPath, newPath);
      responseBodyPath = newName;
    } else if (await exists(newPath)) {
      responseBodyPath = newName;
    } else {
      responseBodyPath = undefined;
    }
  }

  const fileName = `${baseName}.json`;
  await writeJsonAtomic(
    path.join(recordDir, fileName),
    cleanRequestJson({
      ...request,
      responseBody: responseBodyPath ? null : responseBody,
      ...(responseBodyPath ? { responseBodyPath } : {}),
    }),
  );
  return fileName;
}

export type FlushResult = {
  name: string;
  recordDir: string;
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
        ...(entry.method ? { method: entry.method } : {}),
        url: entry.url.bareUrl,
        file: fileName,
      };
      lines.push(JSON.stringify(item));
    }
  }

  await fs.writeFile(
    path.join(recordDir, "timeline.jsonl"),
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    "utf8",
  );

  return { name, recordDir };
}

export function formatStopStdout(result: FlushResult): string {
  return JSON.stringify(
    {
      status: "stopped",
      name: result.name,
      recordDir: result.recordDir,
    },
    null,
    2,
  );
}

export function formatRecordStartStdout(name: string): string {
  return JSON.stringify(
    {
      status: "recording",
      name,
      guide: "请在新窗口做一遍。好了告诉我。",
    },
    null,
    2,
  );
}

export function formatIdleStdout(): string {
  return JSON.stringify({ status: "idle" }, null, 2);
}
