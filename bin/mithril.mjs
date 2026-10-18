#!/usr/bin/env node
// The `mithril` command. Mithril is TypeScript run directly (there is no build
// step), so this registers the tsx loader and then loads the real entry point.
// It runs in this process, so the terminal, signals and exit codes behave
// exactly as they would for any other program.
import { register } from "tsx/esm/api";

register();
await import("../src/index.ts");
