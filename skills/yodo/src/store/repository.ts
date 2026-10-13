import * as crypto from "node:crypto";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function normalizeRecordLabel(value?: string): string {
  const normalized = (value || "rec")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "rec";
}

export function validateRecordName(value: string): string {
  const name = value.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `record 名称无效：${JSON.stringify(value)}；须匹配 ${NAME_RE}`,
    );
  }
  return name;
}

export function createRecordName(label?: string, random = crypto.randomBytes(3).toString("hex")): string {
  return validateRecordName(`${normalizeRecordLabel(label)}-${random}`);
}
