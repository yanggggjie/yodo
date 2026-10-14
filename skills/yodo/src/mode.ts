/**
 * daemon 当前在做什么：run、录制操作（start/stop/abort 正在执行）、录制进行中，或空闲。
 * "忙不忙"和 RUN_BUSY 的 reason、提示文字只在这里定义；SDK 靠 reason 决定要不要等。
 */
export type ModeKind = "idle" | "run" | "record-op" | "record";

/** reason 对应 SDK 的等待规则：run、record-op 会等，record（录制进行中）不会很快结束，直接失败。 */
export type Busy = { reason: "run" | "record" | "record-op"; message: string };

export class Mode<Conn> {
  private run: Conn | null = null;
  private recordOp = false;
  private readonly liveRecord: () => string | null;

  /** liveRecord：正在进行的录制名，由录制模块提供，这里不重复保存。 */
  constructor(liveRecord: () => string | null) {
    this.liveRecord = liveRecord;
  }

  kind(): ModeKind {
    if (this.run) return "run";
    if (this.recordOp) return "record-op";
    return this.liveRecord() ? "record" : "idle";
  }

  /** 发起当前 run 的连接；没有 run 时为 null。 */
  runConn(): Conn | null {
    return this.run;
  }

  tryBeginRun(conn: Conn): Busy | null {
    if (this.run) return { reason: "run", message: "已有 task 正在运行，请等它结束后重试" };
    const record = this.liveRecord();
    if (record) return { reason: "record", message: `录制 ${record} 正在进行，请先 record stop 或 record abort` };
    if (this.recordOp) return { reason: "record-op", message: "录制操作正在进行，请稍后重试" };
    this.run = conn;
    return null;
  }

  /** 只有发起 run 的连接才能结束它；返回是否真的结束了。 */
  endRun(conn: Conn): boolean {
    if (this.run !== conn) return false;
    this.run = null;
    return true;
  }

  tryBeginRecordStart(): Busy | null {
    if (this.run) return { reason: "run", message: "已有 task 正在运行，请等它结束后再 record start" };
    return this.beginRecordOp();
  }

  /** stop、abort：录制本来就在进行，只需要和其它录制操作互斥。 */
  tryBeginRecordFinish(): Busy | null {
    return this.beginRecordOp();
  }

  endRecordOp(): void {
    this.recordOp = false;
  }

  private beginRecordOp(): Busy | null {
    if (this.recordOp) return { reason: "record-op", message: "录制操作正在进行，请稍后重试" };
    this.recordOp = true;
    return null;
  }
}
