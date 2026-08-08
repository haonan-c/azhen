import { describe, expect, it } from "vitest";
import {
  getBundledSkillCatalogEntries,
  resolveBundledContent,
} from "../src/bundled-skills";

describe("UGC Ads bundled skill discovery", () => {
  it("resolves a catalog id directly through the session read contract", () => {
    let entry = getBundledSkillCatalogEntries()
        .find(candidate => candidate.id === "space-xhs-hotspot");

    expect(entry).toBeDefined();
    expect(entry?.description).toContain('read("space-xhs-hotspot")');
    expect(resolveBundledContent(entry!.id)?.content)
        .toContain("name: space-xhs-hotspot");
  });

  it("keeps vendor-relative skill paths readable", () => {
    let byName = resolveBundledContent("space-xhs-hotspot");
    let byPath = resolveBundledContent("space-xhs-hotspot/SKILL.md");

    expect(byPath).toEqual({
      id: "space-xhs-hotspot/SKILL.md",
      content: byName?.content,
    });
  });
});
