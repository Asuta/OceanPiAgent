import { buildSkillsPrompt, getWorkspaceSkillsByIds } from "./skills";
import { registerBeforePromptBuildHook } from "./runtime-hooks";

registerBeforePromptBuildHook(async ({ settings }) => {
  if (!settings.enabledSkillIds.length) {
    return;
  }

  const skills = await getWorkspaceSkillsByIds(settings.enabledSkillIds);
  if (skills.length === 0) {
    return;
  }

  return {
    appendSystemContext: buildSkillsPrompt(skills),
  };
});
