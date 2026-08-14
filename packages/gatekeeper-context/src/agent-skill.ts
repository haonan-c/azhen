import type {
  AgentCatalogEntry, SlashCommandDescriptor,
} from "@gadgets/workshop-shared/gatekeeper";
import type { EnabledCollectionInfo } from "./context-types.js";
import { encodeDocId } from "./context-types.js";

// Generic SKILL.md frontmatter parsing/expansion is shared with other gatekeepers that surface
// Agent Skills (see packages/gatekeeper-ugc-ads); only the collection-scoped catalog/picker
// builders below are specific to the Context Library.
export {
  isSkillManifestPath, parseSkillManifest, buildAgentSkillMessage,
  type SkillManifestMetadata,
} from "@gadgets/workshop-shared/agent-skill";

export type SkillIndexEntry = {
  path: string;
  skillName: string;
  description: string;
};

/** Skills grouped by collection. */
export type CollectionSkills = {
  collection: EnabledCollectionInfo;
  skills: SkillIndexEntry[];
};

type AgentSkillCatalogEntry = AgentCatalogEntry & {kind: "agent-skill"};

/** Build slash command entries for the picker. */
export function buildAgentSkillCommands(
    loaded: CollectionSkills[]): SlashCommandDescriptor[] {
  let commands: SlashCommandDescriptor[] = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      let id = encodeDocId(collection.id, skill.path);
      commands.push({
        id,
        name: skill.skillName,
        description: skill.description,
        resourceLabel: `${collection.title} · ${skill.path}`,
      });
    }
  }
  return commands;
}

/** Build Agent Catalog entries. Their IDs can be passed to ContextLibrary.read(). */
export function buildAgentSkillCatalogEntries(
    loaded: CollectionSkills[]): AgentSkillCatalogEntry[] {
  let entries: AgentSkillCatalogEntry[] = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      entries.push({
        id: encodeDocId(collection.id, skill.path),
        title: skill.skillName,
        description: skill.description,
        kind: "agent-skill",
      });
    }
  }
  return entries.toSorted((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}
