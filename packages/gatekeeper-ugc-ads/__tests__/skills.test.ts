import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSkill(name: string): string {
  return readFileSync(
    new URL(`../vendor/${name}/SKILL.md`, import.meta.url), "utf8");
}

describe("UGC Ads skill instructions", () => {
  it("prints Xiaohongshu search results in the same code execution", () => {
    for (let name of ["xhs-hotnotes", "space-xhs-hotspot"]) {
      let examples = [...readSkill(name).matchAll(/```javascript\n([\s\S]*?)```/g)]
          .map(match => match[1])
          .filter(example => example.includes("searchXiaohongshuNotes"));

      expect(examples, name).not.toHaveLength(0);
      for (let example of examples) {
        expect(example, name).toContain("console.log(JSON.stringify(");
        expect(example, name).not.toContain("return notes.map");
      }
    }
  });

  it("loads the routed skill before Ask UGC Ads executes it", () => {
    let skill = readSkill("ask-ugc-ads");

    expect(skill).toContain('read("space-xhs-hotspot")');
    expect(skill).toContain("console.log(");
    expect(skill).toContain("不需要用户再次输入斜杠命令");
  });
});
