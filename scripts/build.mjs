import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
for (const [name, directory] of [
  ["scramjet", "@mercuryworkshop/scramjet"],
  ["bare-mux", "@mercuryworkshop/bare-mux"],
]) {
  const destination = resolve("public/vendor", name);
  await mkdir(destination, { recursive: true });
  for (const file of await readdir(`node_modules/${directory}/dist`)) {
    if (/\.(?:js|mjs|wasm)$/.test(file))
      await copyFile(
        `node_modules/${directory}/dist/${file}`,
        `${destination}/${file}`,
      );
  }
  await copyFile(
    `node_modules/${directory}/LICENSE`,
    `${destination}/LICENSE.txt`,
  );
}
await build({
  entryPoints: ["client/bridge.js", "client/transport.js"],
  outdir: "public",
  bundle: true,
  format: "esm",
  target: "chrome110",
  minify: true,
});
await copyFile("client/sw.js", "public/sw.js");
const wasm = await readFile(
  "node_modules/@mercuryworkshop/scramjet/dist/scramjet.wasm.wasm",
);
// Scramjet 1.1.0 requests the same WASM URL as both a binary fetch and a script.
await writeFile(
  "public/vendor/scramjet/wasm.js",
  `self.WASM=${JSON.stringify(wasm.toString("base64"))};`,
);
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const runtimePackages = new Set();
async function collect(name) {
  if (runtimePackages.has(name)) return;
  runtimePackages.add(name);
  const pkg = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  );
  for (const dependency of Object.keys(pkg.dependencies || {}))
    await collect(dependency);
}
await collect("@mercuryworkshop/scramjet");
const notices = [];
for (const name of [...runtimePackages].sort()) {
  const directory = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
  notices.push(
    `\n===== ${name} ${pkg.version} =====\n${pkg.repository?.url || pkg.homepage || ""}\n`,
  );
  for (const file of await readdir(directory)) {
    if (/^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(file)) {
      notices.push(await readFile(`${directory}/${file}`, "utf8"));
    }
  }
}
await writeFile("public/vendor/THIRD_PARTY_NOTICES.txt", notices.join("\n"));
await writeFile(
  "public/vendor/versions.json",
  JSON.stringify(
    Object.fromEntries(
      Object.entries(lock.packages)
        .filter(([name]) => name.startsWith("node_modules/@mercuryworkshop/"))
        .map(([name, item]) => [
          name.slice(13),
          { version: item.version, integrity: item.integrity },
        ]),
    ),
    null,
    2,
  ),
);
console.log(
  "Built local browser runtime assets and transport. No external CDN is required.",
);
