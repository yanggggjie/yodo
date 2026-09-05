// yodo 入口。纯 JS：先做 Node 版本门（老 Node 无法 strip .ts，会 parse 崩），
// 通过后再进 TS 主流程。SKILL 指针指向本文件：node ~/.yodo/src/yodo.js <verb>
const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(
    `yodo 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`,
  );
  process.exit(1);
}

await import("./cli/index.ts");
