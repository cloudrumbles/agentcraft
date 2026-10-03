#!/usr/bin/env node
import { runLauncher } from './lib/unix-launcher.mjs';
process.exitCode = await runLauncher('linux');
