import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it, vi } from "vitest";
import {
  getBundledSkillCatalogEntries,
  resolveBundledContent,
} from "../src/bundled-skills";
import { UgcAdsSession } from "../src/ugc-ads";
import { OfficialAccountInteractionRateLimiter } from "../src/tikhub-api";

describe("UGC Ads bundled skill discovery", () => {
  it("resolves a catalog id directly through the session read contract", () => {
    let entry = getBundledSkillCatalogEntries()
        .find(candidate => candidate.id === "space-xhs-hotspot");

    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("agent-skill");
    expect(entry?.description).not.toContain("read(");
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

  it("keeps the enabled official-account command discoverable and readable by Session", async () => {
    let matches = getBundledSkillCatalogEntries()
        .filter(candidate => candidate.id === "gzh-explosive-content-detector");
    let entry = matches[0];
    let authorizeObservation = vi.fn<(observation: {
      title: string;
      description: string;
    }) => Promise<void>>(async () => {});
    let approvalQueue = {
      async beginBillableOperation() {
        return {
          async getOperationId() { return "test-operation"; },
          async markStarted() {},
          async complete() {},
          [Symbol.dispose]() {},
        };
      },
      authorizeObservation,
      [Symbol.dispose]: vi.fn<() => void>(),
    } as unknown as RpcStub<ApprovalQueue>;
    let session = new UgcAdsSession(
      approvalQueue, "", {} as BrowserRun, new OfficialAccountInteractionRateLimiter());

    try {
      expect(matches).toHaveLength(1);
      expect(entry).toBeDefined();
      expect(entry?.id).toBe("gzh-explosive-content-detector");
      expect(entry?.kind).toBe("agent-skill");
      expect(entry?.description).toContain("公众号热门选题");
      expect(entry?.description).toContain("1～5 个");
      expect(entry?.description).toContain("30 天");
      await expect(session.read(entry!.id)).resolves.toEqual({
        id: "gzh-explosive-content-detector",
        content: expect.stringContaining("# 公众号热门选题"),
      });
      expect(authorizeObservation).toHaveBeenCalledOnce();
    } finally {
      session[Symbol.dispose]();
    }
  });

  it("catalogs bare domain phrases as official-account topic research", () => {
    let entry = getBundledSkillCatalogEntries()
        .find(candidate => candidate.id === "gzh-explosive-content-detector");

    expect(entry?.description).toContain("即使用户只输入");
    expect(entry?.description).toContain("裸领域/主题短语");
    expect(entry?.description).toContain("软件著作权");
    expect(entry?.description).toContain("AI Agent");
    expect(entry?.description)
        .toContain("默认匹配本 Skill 并进入公众号热门选题研究");
  });

  it("keeps the legacy deep WeChat HTML report explicitly unavailable", () => {
    let legacy = getBundledSkillCatalogEntries()
        .find(candidate => candidate.id === "baokuan-article-analysis");

    expect(legacy).toBeDefined();
    expect(legacy?.description).toContain("本部署不可用");
    expect(resolveBundledContent("baokuan-article-analysis")?.content)
        .toContain("不要执行下面的脚本");
  });

});
