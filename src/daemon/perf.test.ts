import { describe, it, expect } from "bun:test";
import { DaemonPerf } from "./perf";

describe("DaemonPerf", () => {
  it("is a no-op when CCMUX_PERF is not set", () => {
    // All calls should succeed without errors
    DaemonPerf.incMarkerReads();
    DaemonPerf.incMarkerBatchReads();
    DaemonPerf.incSubprocessSpawn("test");
    DaemonPerf.incPaneCapture();
    DaemonPerf.incFindIterations(10);

    expect(DaemonPerf.scanStart()).toBe(0);
    DaemonPerf.scanEnd(0);

    expect(DaemonPerf.markerCleanupStart()).toBe(0);
    DaemonPerf.markerCleanupEnd(0);

    expect(DaemonPerf.paneCaptureStart()).toBe(0);
    DaemonPerf.paneCaptureEnd(0);

    DaemonPerf.startReporter(5);
    DaemonPerf.report();
  });
});
