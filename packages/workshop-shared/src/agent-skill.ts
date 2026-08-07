// Parsing and expansion helpers for Agent Skills (SKILL.md documents), shared by any gatekeeper
// that surfaces such documents as slash commands. See gatekeeper-context/src/agent-skill.ts for the
// Context Library's collection-scoped catalog/picker builders on top of these.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const AGENT_SKILL_NAME_MAX_LENGTH = 64;

/** Fields read from a SKILL.md document's YAML frontmatter. */
export type SkillManifestMetadata = {
  name: string;
  description: string;
};

const SkillFrontmatterSchema = z.object({
  name: z.string()
      .min(1, "Skill name is required.")
      .max(AGENT_SKILL_NAME_MAX_LENGTH, "Skill name must be at most 64 characters.")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          "Skill name must use lowercase letters, numbers, and single hyphens."),
  description: z.string()
      .transform(value => value.trim())
      .pipe(z.string()
          .min(1, "Skill description is required.")
          .max(1024, "Skill description must be at most 1024 characters.")),
}).passthrough();

/** Checks whether the last path segment is exactly `SKILL.md`. */
export function isSkillManifestPath(path: string): boolean {
  return path.split("/").at(-1) === "SKILL.md";
}

function isFrontmatterFence(line: string): boolean {
  return line.startsWith("---") && line.slice(3).trim() === "";
}

function readFrontmatterYaml(source: string): string {
  let text = source.startsWith("﻿") ? source.slice(1) : source;
  let lines = text.split(/\r?\n/);
  if (!isFrontmatterFence(lines[0] ?? "")) {
    throw new Error("Skill manifest must start with YAML frontmatter.");
  }

  let end = lines.findIndex((line, index) => index > 0 && isFrontmatterFence(line));
  if (end < 0) {
    throw new Error("Skill manifest frontmatter is not closed.");
  }
  return lines.slice(1, end).join("\n");
}

function parseFrontmatter(source: string): unknown {
  let yaml = readFrontmatterYaml(source);
  try {
    return parseYaml(yaml);
  } catch {
    throw new Error("Skill frontmatter is not valid YAML.");
  }
}

function formatFrontmatterError(error: z.ZodError): string {
  let issue = error.issues[0];
  if (issue?.path[0] === "name" && issue.code === "invalid_type") return "Skill name is required.";
  if (issue?.path[0] === "description" && issue.code === "invalid_type") {
    return "Skill description is required.";
  }
  if (issue?.path.length === 0 && issue.code === "invalid_type") {
    return "Skill frontmatter must be a mapping.";
  }
  return issue?.message ?? "Skill frontmatter is invalid.";
}

/**
 * Reads and validates a SKILL.md document's frontmatter. `path` must end in `SKILL.md`; `source` is
 * the document's full text. Throws with a human-readable message if the path or frontmatter is
 * invalid. Unknown frontmatter fields are ignored (passthrough), so callers may support additional
 * fields without this validator rejecting them.
 */
export function parseSkillManifest(path: string, source: string): SkillManifestMetadata {
  if (!isSkillManifestPath(path)) {
    throw new Error("Skill manifest filename must be SKILL.md.");
  }
  let result = SkillFrontmatterSchema.safeParse(parseFrontmatter(source));
  if (!result.success) throw new Error(formatFrontmatterError(result.error));

  return {
    name: result.data.name,
    description: result.data.description,
  };
}

/**
 * Expands a SKILL.md document's body into the chat message a slash-command invocation inserts.
 * `content` is the document's full text (frontmatter included); `args` is the unparsed text the
 * user typed after the command. `$ARGUMENT` occurrences in `content` are substituted with `args`;
 * if `content` has no `$ARGUMENT` placeholder and `args` is non-empty, `args` is appended after the
 * expansion instead.
 */
export function buildAgentSkillMessage(content: string, args: string): string {
  let usesArgument = /\$ARGUMENT(?![A-Za-z0-9_[])/.test(content);
  let expanded = content.replace(/\$ARGUMENT(?![A-Za-z0-9_[])/g, () => args);
  let message = `<agent_skill>\n${expanded}\n</agent_skill>`;
  return !usesArgument && args ? `${message}\n\nARGUMENT: ${args}` : message;
}
