export interface ModelInfo {
  name: string;
  size: string;
  license: string;
  url: string;
  filename: string;
}

export const MODEL_CATALOG: ModelInfo[] = [
  { name: "Qwen3.5 0.8B (Q8_0)", size: "1.6 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-0.8B-Q8_0.llamafile",
    filename: "Qwen3.5-0.8B-Q8_0.llamafile" },
  { name: "Qwen3.5 2B (Q8_0)", size: "3.2 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-2B-Q8_0.llamafile",
    filename: "Qwen3.5-2B-Q8_0.llamafile" },
  { name: "Ministral 3 3B Instruct (Q4_K_M)", size: "3.4 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Ministral-3-3B-Instruct-2512-Q4_K_M.llamafile",
    filename: "Ministral-3-3B-Instruct-2512-Q4_K_M.llamafile" },
  { name: "Qwen3.5 4B (Q5_K_S)", size: "4.1 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-4B-Q5_K_S.llamafile",
    filename: "Qwen3.5-4B-Q5_K_S.llamafile" },
  { name: "LLaVA v1.6 Mistral 7B (Q4_K_M)", size: "5.3 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/llava-v1.6-mistral-7b-Q4_K_M.llamafile",
    filename: "llava-v1.6-mistral-7b-Q4_K_M.llamafile" },
  { name: "Apertus 8B Instruct 2509", size: "5.9 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Apertus-8B-Instruct-2509.llamafile",
    filename: "Apertus-8B-Instruct-2509.llamafile" },
  { name: "Qwen3.5 9B (Q5_K_S)", size: "7.4 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-9B-Q5_K_S.llamafile",
    filename: "Qwen3.5-9B-Q5_K_S.llamafile" },
  { name: "gpt-oss 20B (mxfp4)", size: "12 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/gpt-oss-20b-mxfp4.llamafile",
    filename: "gpt-oss-20b-mxfp4.llamafile" },
  { name: "Qwen3.5 27B (Q5_K_S)", size: "19 GB", license: "Apache 2.0",
    url: "https://huggingface.co/mozilla-ai/llamafile_0.10/resolve/main/Qwen3.5-27B-Q5_K_S.llamafile",
    filename: "Qwen3.5-27B-Q5_K_S.llamafile" },
];