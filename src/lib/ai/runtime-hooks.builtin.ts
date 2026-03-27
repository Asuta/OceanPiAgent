import { buildProjectContextPrompt } from "./project-context";
import { buildSkillsCatalogPrompt, getWorkspaceSkillsByIds } from "./skills";
import { registerBeforePromptBuildHook } from "./runtime-hooks";

registerBeforePromptBuildHook(async ({ settings }) => {
  const appendBlocks: string[] = [];

  if (settings.enabledSkillIds.length) {
    const skills = await getWorkspaceSkillsByIds(settings.enabledSkillIds);
    if (skills.length > 0) {
      appendBlocks.push(buildSkillsCatalogPrompt(skills));
    }
  }

  const projectContextPrompt = await buildProjectContextPrompt();
  if (projectContextPrompt) {
    appendBlocks.push(projectContextPrompt);
  }

  if (appendBlocks.length === 0) {
    return;
  }

  return {
    appendSystemContext: appendBlocks.join("\n\n"),
  };
});
