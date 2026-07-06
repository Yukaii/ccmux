import { describe, it, expect } from "bun:test";
import {
  classifyPaneContent,
  classifyPaneTitle,
  isIdleCommand,
} from "./pane-classify";

describe("classifyPaneTitle", () => {
  it("should detect working from braille spinner chars", () => {
    expect(classifyPaneTitle("⠂ Claude Code")).toBe("working");
    expect(classifyPaneTitle("⠐ Claude Code")).toBe("working");
    expect(classifyPaneTitle("⠿ some title")).toBe("working");
  });

  it("should detect working at braille range boundaries", () => {
    expect(classifyPaneTitle("⠀")).toBe("working"); // U+2800 (lower bound)
    expect(classifyPaneTitle("⣿")).toBe("working"); // U+28FF (upper bound)
  });

  it("should not treat chars adjacent to braille range as working", () => {
    expect(classifyPaneTitle(String.fromCodePoint(0x27ff))).toBe("unknown");
    expect(classifyPaneTitle(String.fromCodePoint(0x2900))).toBe("unknown");
  });

  it("should detect not_working from ✳ prefix", () => {
    expect(classifyPaneTitle("✳ Claude Code")).toBe("not_working");
    expect(classifyPaneTitle("✳")).toBe("not_working");
  });

  it("should return unknown for other titles", () => {
    expect(classifyPaneTitle("web-app")).toBe("unknown");
    expect(classifyPaneTitle("")).toBe("unknown");
    expect(classifyPaneTitle(null)).toBe("unknown");
  });
});

describe("isIdleCommand", () => {
  it("should detect shell commands as idle", () => {
    expect(isIdleCommand("zsh")).toBe(true);
    expect(isIdleCommand("bash")).toBe(true);
    expect(isIdleCommand("fish")).toBe(true);
    expect(isIdleCommand("sh")).toBe(true);
    expect(isIdleCommand("dash")).toBe(true);
    expect(isIdleCommand("-zsh")).toBe(true);
    expect(isIdleCommand("-bash")).toBe(true);
    expect(isIdleCommand("ksh")).toBe(true);
  });

  it("should detect editors as idle", () => {
    expect(isIdleCommand("nvim")).toBe(true);
    expect(isIdleCommand("vim")).toBe(true);
    expect(isIdleCommand("vi")).toBe(true);
  });

  it("should not detect other commands as idle", () => {
    expect(isIdleCommand("2.1.38")).toBe(false);
    expect(isIdleCommand("claude")).toBe(false);
    expect(isIdleCommand("node")).toBe(false);
    expect(isIdleCommand(null)).toBe(false);
  });
});

describe("classifyPaneContent", () => {
  it("should detect plan_approval when content contains plan path", () => {
    const content = `  Read /Users/test/.claude/plans/abc123.md
  Do you want to approve this plan?`;
    expect(classifyPaneContent(content)).toEqual({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
  });

  it("should detect Claude question menus as waiting", () => {
    const content = `What would you like to work on in FlashJump today?
  1. Bug fix
Enter to select · ↑/↓ to navigate · Esc to cancel`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "question",
      pendingTool: null,
    });
  });

  it("should detect Claude permission prompts as waiting", () => {
    const content = `Permission rule Bash(git push:*) requires confirmation for this command.
/permissions to update rules

Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend · ctrl+e to explain`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "permission",
      pendingTool: null,
    });
  });

  it("should detect Claude AskUserQuestion menus as waiting", () => {
    const content = `☐ Git push

It looks like the git push --dry-run was rejected at the permission prompt. Would you like me to try again?

❯ 1. Try again
    Attempt git push --dry-run again
  2. Skip
    Don't push, we're done
  3. Type something.
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "question",
      pendingTool: null,
    });
  });

  it("should return active when content has no plan path", () => {
    const content = `  ● Allow Bash: bun run typecheck
  Yes  No`;
    expect(classifyPaneContent(content)).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });

  it("should return active for working session output", () => {
    const content = `  Reading file src/daemon/index.ts
  Analyzing code patterns...`;
    expect(classifyPaneContent(content)).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });

  it("should return active for empty content", () => {
    expect(classifyPaneContent("")).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });
});
