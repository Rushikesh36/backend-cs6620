// Bundles every lambdas/<name>/handler.ts into build/lambdas/<name>/index.mjs.
// Terraform zips those folders. Run with: npm run build
// Optional: node scripts/package.mjs [lambdasDir] [outDir]  (used by tests)
import { build } from "esbuild";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const srcDir = resolve(process.argv[2] ?? "lambdas");
const outDir = resolve(process.argv[3] ?? "build/lambdas");

// Keep the build clean so deleted Lambdas do not linger in the zips.
rmSync(outDir, { recursive: true, force: true });

const names = existsSync(srcDir)
  ? readdirSync(srcDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(srcDir, d.name, "handler.ts")))
      .map((d) => d.name)
  : [];

if (names.length === 0) {
  console.log(`No Lambdas found in ${srcDir} (looking for <name>/handler.ts).`);
  process.exit(0);
}

for (const name of names) {
  await build({
    entryPoints: [join(srcDir, name, "handler.ts")],
    outfile: join(outDir, name, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // The nodejs22.x Lambda runtime already ships AWS SDK v3.
    external: ["@aws-sdk/*"],
    // Some bundled CommonJS packages call require(); give them one.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`built ${name}`);
}
