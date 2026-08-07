import type { SlashCommandDescriptor } from "@gadgets/workshop-shared/gatekeeper";
import type { EnabledCollectionInfo } from "./context-types.js";
import { encodeDocId } from "./context-types.js";

// Generic SKILL.md frontmatter parsing/expansion is shared with other gatekeepers that surface
// Agent Skills (see packages/gatekeeper-creator-buddy); only the collection-scoped catalog/picker
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

// Skills grouped by collection.
export type CollectionSkills = {
  collection: EnabledCollectionInfo;
  skills: SkillIndexEntry[];
};

// Build slash command entries for the picker.
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

// Build Agent Catalog entries. Their IDs can be passed to ContextLibrary.read().
export function buildAgentSkillCatalogEntries(
    loaded: CollectionSkills[]): Array<{id: string, title: string, description: string}> {
  let entries: Array<{id: string, title: string, description: string}> = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      entries.push({
        id: encodeDocId(collection.id, skill.path),
        title: skill.skillName,
        description: `Agent Skill. Read with env[N].read(id) and ` +
          `console.log(document.content). ${skill.description}`,
      });
    }
  }
  return entries.toSorted((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}
