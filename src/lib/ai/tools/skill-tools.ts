import { z } from "zod";
import { getWorkspaceSkillById } from "@/lib/ai/skills";
import { createStructuredOutput, skillReadArgsSchema, type ToolDefinition } from "./shared";

export const skillTools = {
  skill_read: {
    name: "skill_read",
    displayName: "Skill Read",
    description:
      "Read the full SKILL.md for one enabled workspace skill after the injected skill catalog shows it is the best match.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        skillId: { type: "string", description: "The skill id from the injected <available_skills> catalog." },
      },
      required: ["skillId"],
    },
    validate: (value: unknown) => skillReadArgsSchema.parse(value),
    execute: async (value: unknown) => {
      const args = value as z.infer<typeof skillReadArgsSchema>;
      const skill = await getWorkspaceSkillById(args.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${args.skillId}`);
      }

      return createStructuredOutput({
        id: skill.id,
        name: skill.name,
        title: skill.title,
        description: skill.description,
        summary: skill.summary,
        sourcePath: `skills/${skill.id}/SKILL.md`,
        prompt: skill.prompt,
      });
    },
  } satisfies ToolDefinition<unknown>,
};
