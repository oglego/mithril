import path from "node:path";
import { existsSync } from "node:fs";

export function resolveProjectRoot(): string {
  const configuredRoot = process.env.MITHRIL_PROJECT_ROOT;
  if (configuredRoot && configuredRoot.trim().length > 0) {
    return path.resolve(configuredRoot);
  }

  let current = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(current, "package.json")) || existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

// Shared across onboarding (chat models) and the RAG pipeline (embedding
// model) so both download into the same place. Resolve from the active
// project root instead of the ambient working directory, which can differ
// when the app is launched from a parent folder or when tests override the
// root via MITHRIL_PROJECT_ROOT.
export function getModelsDir(): string {
  return path.join(resolveProjectRoot(), "models");
}

export const MODELS_DIR = getModelsDir();
