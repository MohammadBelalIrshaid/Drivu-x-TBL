import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(projectRoot, "dist-pages");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(resolve(projectRoot, "public"), outputDirectory, { recursive: true });
await copyFile(
  resolve(projectRoot, "src", "worker.js"),
  resolve(outputDirectory, "_worker.js"),
);
await writeFile(
  resolve(outputDirectory, "_routes.json"),
  `${JSON.stringify(
    { version: 1, include: ["/api/*"], exclude: [] },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("Built the Cloudflare Pages bundle in dist-pages.");
