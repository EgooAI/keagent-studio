import fs from "node:fs";
import path from "node:path";
import type { CommentObservation } from "@keagent/shared-types";
import { atomicJSON } from "../publishing/files";

export class ObservationRecorder {
  constructor(readonly directory: string) {}

  save(record: CommentObservation) {
    atomicJSON(path.join(this.directory, record.id + ".json"), record);
  }

  get(id: string, active: boolean): CommentObservation | undefined {
    if (!/^[a-f0-9]{32}$/.test(id)) return;
    const file = path.join(this.directory, id + ".json");
    if (!fs.existsSync(file)) return;
    const record: CommentObservation = JSON.parse(
      fs.readFileSync(file, "utf8"),
    );
    if ((record.state === "queued" || record.state === "running") && !active) {
      Object.assign(record, {
        state: "stopped",
        endedAt: new Date().toISOString(),
        errorCode: "INTERRUPTED",
        reason: "上次观察因应用退出而中断",
      });
      this.save(record);
    }
    return record;
  }

  list(active: ReadonlySet<string>) {
    if (!fs.existsSync(this.directory)) return [];
    return fs
      .readdirSync(this.directory)
      .filter((file) => /^[a-f0-9]{32}\.json$/.test(file))
      .map((file) => file.slice(0, -5))
      .map((id) => this.get(id, active.has(id))!)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
