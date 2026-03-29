import * as esbuild from "esbuild";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, "src/background.ts")],
  outfile: join(dist, "background.js"),
  format: "esm",
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "src/content.ts")],
  outfile: join(dist, "content.js"),
  format: "iife",
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "src/sidepanel/sidepanel.ts")],
  outfile: join(dist, "sidepanel.js"),
  format: "iife",
});

await copyFile(join(root, "public/manifest.json"), join(dist, "manifest.json"));
await copyFile(join(root, "src/sidepanel/sidepanel.html"), join(dist, "sidepanel.html"));

for (const stale of ["popup.html", "popup.js"]) {
  const p = join(dist, stale);
  if (existsSync(p)) await unlink(p);
}

const logoSrc = join(root, "../../logo.png");
if (existsSync(logoSrc)) {
  await copyFile(logoSrc, join(dist, "logo.png"));
} else {
  console.warn("logo.png not found at ../../logo.png — add nexus3.0/logo.png for branding.");
}

console.log("Extension built to dist/ — load unpacked from Chrome → Extensions.");
