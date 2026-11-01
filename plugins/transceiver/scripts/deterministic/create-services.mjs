import { createProjectPolicy } from "../project-policy.mjs";
import { createProjectTools } from "./project-tools.mjs";
import { createGitTools } from "./git-tools.mjs";

// Host initialization only. Never expose either parameter in a tool schema.
export async function createDeterministicServices({ configPath,
  gitExecutable = process.env.TRANSCEIVER_GIT_EXECUTABLE } = {}) {
  if (typeof gitExecutable !== "string" || !gitExecutable.trim()) {
    throw new Error("Set TRANSCEIVER_GIT_EXECUTABLE to a trusted absolute native Git path (Windows: mingw*/bin/git.exe). PATH fallback is disabled.");
  }
  const policy = await createProjectPolicy({ configPath });
  const fileTools = createProjectTools({ policy });
  let gitTools;
  try { gitTools = await createGitTools({ policy, gitExecutable }); }
  catch (error) {
    throw new Error(`Cannot initialize TRANSCEIVER_GIT_EXECUTABLE: ${error.message}`, { cause: error });
  }
  return Object.freeze({ fileTools, gitTools });
}
