import path from "node:path";

// Shared across onboarding (chat models) and the RAG pipeline (embedding
// model) so both download into the same place.
export const MODELS_DIR = path.join(process.cwd(), "models");
