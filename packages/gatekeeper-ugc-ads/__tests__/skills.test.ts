import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UGC Ads skill instructions", () => {
  it("prints Xiaohongshu search results in the same code execution", () => {
    let skill = readFileSync(
      new URL("../vendor/xhs-hotnotes/SKILL.md", import.meta.url), "utf8");
    let examples = [...skill.matchAll(/```javascript\n([\s\S]*?)```/g)]
        .map(match => match[1])
        .filter(example => example.includes("searchXiaohongshuNotes"));

    expect(examples).not.toHaveLength(0);
    for (let example of examples) {
      expect(example).toContain("console.log(JSON.stringify(");
      expect(example).not.toContain("return notes.map");
    }
  });
});
