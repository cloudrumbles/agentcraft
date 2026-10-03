#!/usr/bin/env node
// Keep the original macOS entry point; Linux uses the same tested Unix launcher.
import { runLauncher } from './lib/unix-launcher.mjs';
process.exitCode = await runLauncher('darwin');
