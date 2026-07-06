import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSpy } from "@opentui/core/testing";
import { SearchInput } from "./SearchInput";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;
let onChange: ReturnType<typeof createSpy>;
let onSubmit: ReturnType<typeof createSpy>;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderSearch(value = "") {
  onChange = createSpy();
  onSubmit = createSpy();
  setup = await testRender(
    () => <SearchInput value={value} onChange={onChange} onSubmit={onSubmit} />,
    { width: 40, height: 4 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("SearchInput", () => {
  it("renders search prefix", async () => {
    const frame = await renderSearch();
    expect(frame).toContain("/");
  });

  it("renders placeholder text", async () => {
    const frame = await renderSearch();
    expect(frame).toContain("Search sessions...");
  });

  it("renders current value", async () => {
    const frame = await renderSearch("testquery");
    expect(frame).toContain("testquery");
  });

  it("calls onChange on text input", async () => {
    await renderSearch();
    await setup.mockInput.typeText("a");
    expect(onChange.callCount()).toBeGreaterThan(0);
  });

  it("calls onSubmit on Enter", async () => {
    await renderSearch("test");
    setup.mockInput.pressEnter();
    expect(onSubmit.callCount()).toBeGreaterThan(0);
  });
});
