/** Bundles the TypeScript test harness with esbuild and runs it in node. */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "continuum-test-"));
const outExt = ".mjs";
try {
  await build({
    entryPoints: ["test/run.ts", "test/planner-run.ts"],
    outdir: dir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outExtension: { ".js": outExt },
    logLevel: "error",
  });
  await import(pathToFileURL(join(dir, "planner-run" + outExt)).href);
  await import(pathToFileURL(join(dir, "run" + outExt)).href);
  await import(pathToFileURL(join(process.cwd(), "test/worklet-run.mjs")).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
