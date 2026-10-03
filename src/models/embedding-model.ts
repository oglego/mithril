// Unlike the chat models in models.ts, this isn't something the user picks —
// RAG needs exactly one embedding model, so we fix the choice and download
// it automatically the first time --docs is used. Keeps the "no config
// before first run" promise: the only thing the user supplies is a path.
export const EMBEDDING_MODEL = {
  name: "mxbai-embed-large-v1 (f16)",
  size: "699 MB",
  url: "https://huggingface.co/Mozilla/mxbai-embed-large-v1-llamafile/resolve/main/mxbai-embed-large-v1-f16.llamafile",
  filename: "mxbai-embed-large-v1-f16.llamafile",
  queryPrefix: "Represent this sentence for searching relevant passages: ",
};

