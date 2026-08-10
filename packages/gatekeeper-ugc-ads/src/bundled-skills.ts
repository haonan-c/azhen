import type { AgentCatalogEntry } from "@gadgets/workshop-shared/gatekeeper";
import { UGC_ADS_DOCS, UGC_ADS_SKILLS } from "./generated/skills.js";

/** One Agent Catalog entry for a bundled UGC Ads Skill. */
export type BundledSkillCatalogEntry =
  AgentCatalogEntry & {kind: "agent-skill"};

/** Builds actionable Agent Catalog entries whose ids can be passed directly to read(). */
export function getBundledSkillCatalogEntries(): BundledSkillCatalogEntry[] {
  return UGC_ADS_SKILLS.map(skill => ({
    id: skill.name,
    title: skill.name,
    description: skill.description,
    kind: "agent-skill",
  }));
}

/** Resolves an Agent Catalog id or vendor-relative document path to bundled content. */
export function resolveBundledContent(id: string): { id: string; content: string } | null {
  let doc = UGC_ADS_DOCS.find(entry => entry.id === id);
  let skill = UGC_ADS_SKILLS.find(entry => entry.name === id || entry.path === id);
  let content = doc?.content ?? skill?.content;
  return content === undefined ? null : { id, content };
}
