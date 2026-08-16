import { describe, expect, it } from "vitest";
import { homePromptFromSearch, marketingPageRequestedFromSearch } from "./homePrompt";
import { MAX_GATEKEEPER_APP_PROMPT_LENGTH } from "./gatekeeperAppNavigation";

describe("homePromptFromSearch", () => {
  it("returns a trimmed prompt for one-time composer seeding", () => {
    expect(homePromptFromSearch("  Build a morning brief.  ")).toBe("Build a morning brief.");
  });

  it("ignores non-text, empty, and oversized search values", () => {
    expect(homePromptFromSearch(42)).toBeUndefined();
    expect(homePromptFromSearch("   ")).toBeUndefined();
    expect(homePromptFromSearch("x".repeat(MAX_GATEKEEPER_APP_PROMPT_LENGTH + 1))).toBeUndefined();
  });
});

describe("marketingPageRequestedFromSearch", () => {
  it("accepts only the boolean and serialized true values", () => {
    expect(marketingPageRequestedFromSearch(true)).toBe(true);
    expect(marketingPageRequestedFromSearch("true")).toBe(true);
    expect(marketingPageRequestedFromSearch(false)).toBe(false);
    expect(marketingPageRequestedFromSearch("false")).toBe(false);
    expect(marketingPageRequestedFromSearch(undefined)).toBe(false);
  });
});
