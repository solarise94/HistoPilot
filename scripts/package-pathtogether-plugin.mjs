import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const source = join(root, "integrations", "pathtogether");
const release = join(root, "release");
const staging = join(release, "histopilot");
const archive = join(release, `histopilot-pathtogether-plugin-${pkg.version}.tar.gz`);

await mkdir(release, { recursive: true });
await rm(staging, { recursive: true, force: true });
await cp(source, staging, { recursive: true });

const manifestPath = join(staging, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.pluginVersion = pkg.version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const tar = spawnSync("tar", ["-czf", archive, "-C", release, "histopilot"], {
  stdio: "inherit",
});
if (tar.status !== 0) process.exit(tar.status ?? 1);
process.stdout.write(`${archive}\n`);
