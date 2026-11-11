// Bundles each scanners/<name>/main.ts into build/scanners/<name>/index.mjs for the images.
// Run by the Dockerfiles; also works on a laptop: node scripts/package_scanners.mjs [name ...]
// Unlike the Lambdas, the AWS SDK is bundled: the scanner images do not ship it.
import { build } from "esbuild";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const srcDir = resolve("scanners");
const outDir = resolve("build/scanners");

const all = readdirSync(srcDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(srcDir, d.name, "main.ts")))
  .map((d) => d.name);
const names = process.argv.length > 2 ? process.argv.slice(2) : all;

for (const name of names) {
  if (!all.includes(name)) {
    console.error(`Unknown scanner "${name}". Known: ${all.join(", ")}`);
    process.exit(1);
  }
  rmSync(join(outDir, name), { recursive: true, force: true });
  await build({
    entryPoints: [join(srcDir, name, "main.ts")],
    outfile: join(outDir, name, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Some bundled CommonJS packages call require(); give them one.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`built scanner ${name}`);
}
