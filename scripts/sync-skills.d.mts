export function renderGenerated(packId: string, skillName: string, relativeFile: string, content: string): string;
export function stripMarkerLine(content: string): string;
export function writeSkillsTree(options?: { packsDir?: string; outDir?: string }): { skills: number; files: number };
export function run(options?: { write?: boolean; packsDir?: string; outDir?: string }): {
  failures: string[];
  packSkills: number;
  files?: number;
};
