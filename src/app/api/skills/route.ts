import { NextResponse } from "next/server";
import { listWorkspaceSkills } from "@/lib/ai/skills";

export const runtime = "nodejs";

export async function GET() {
  try {
    const skills = await listWorkspaceSkills();
    return NextResponse.json({
      skills: skills.map((skill) => ({
        id: skill.id,
        title: skill.title,
        summary: skill.summary,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
