#!/usr/bin/env node

// Bundles test/unit/*.test.ts with esbuild and runs them with the Node test runner.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const esbuild = (await import(os.arch() === 'x64' ? 'esbuild' : 'esbuild-wasm')).default;

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-server-unit-'));

try {
    const entryPoints = fs.readdirSync(testDirectory)
            .filter(name => name.endsWith('.test.ts'))
            .map(name => path.join(testDirectory, name));

    await esbuild.build({
        entryPoints,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        outdir: outputDirectory,
        outExtension: { '.js': '.mjs' },
        logLevel: 'warning',
    });

    const bundles = fs.readdirSync(outputDirectory).map(name => path.join(outputDirectory, name));
    const result = spawnSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
} finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
}
