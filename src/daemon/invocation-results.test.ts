import { describe, it, expect, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import {
  invocationResultPath,
  readInvocationResult,
  writeInvocationResult,
} from "./invocation-results";

// Real /tmp round-trip, cleaned up per id. The ids are deterministic so
// each test owns its own file and they can run in any order.
const ids: string[] = [];

function freshId(suffix: string): string {
  const id = `inv_results${suffix}`;
  ids.push(id);
  return id;
}

afterEach(async () => {
  await Promise.all(
    ids
      .splice(0)
      .map((id) =>
        rm(invocationResultPath(id), { force: true }).catch(() => {}),
      ),
  );
});

describe("invocation result store", () => {
  it("round-trips written output", async () => {
    const id = freshId("rt");
    await writeInvocationResult(id, "the full output\nsecond line");
    expect(await readInvocationResult(id)).toBe("the full output\nsecond line");
  });

  it("returns null (clean miss) when the file was never written", async () => {
    // Reap-tolerant contract: a gone file is a clean miss, never a throw.
    const id = freshId("missing");
    expect(await readInvocationResult(id)).toBeNull();
  });

  it("returns null after the file is reaped", async () => {
    const id = freshId("reaped");
    await writeInvocationResult(id, "x");
    expect(await readInvocationResult(id)).toBe("x");
    await rm(invocationResultPath(id), { force: true });
    expect(await readInvocationResult(id)).toBeNull();
  });

  it("derives a stable, separator-free path from the id", () => {
    // The id reaches a filesystem path on both write and read; the path
    // helper is the single source of truth so the two sides can't diverge.
    const path = invocationResultPath("inv_abc123");
    expect(path).toContain("inv_abc123");
    expect(path).not.toContain("/inv_abc123/");
  });

  it("stores results in a private 0700 directory (closes the symlink vector)", () => {
    // A deterministic /tmp path lets a co-tenant pre-plant a symlink the
    // daemon would follow on write. Results live in a mkdtemp 0700 dir
    // instead, which only the daemon user can traverse.
    const dir = dirname(invocationResultPath("inv_modecheck"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("truncates an oversized result and marks it", async () => {
    // Cap the stored output so a runaway agent can't OOM the daemon on
    // read-back. The marker survives the read-side cap.
    const id = freshId("big");
    const huge = "x".repeat(6 * 1024 * 1024);
    await writeInvocationResult(id, huge);
    const out = await readInvocationResult(id);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(huge.length);
    expect(out).toContain("truncated");
  });
});
