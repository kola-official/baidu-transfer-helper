import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;

const commonManifest = {
  manifest_version: 3,
  name: "百度网盘批量转存助手（跨浏览器版）",
  version,
  description: "自动递归拆分并转存超过数量限制的百度网盘分享目录，支持自定义保存目录。",
  action: { default_popup: "popup.html", default_title: "百度网盘批量转存" },
  icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
  permissions: ["storage", "cookies", "declarativeNetRequestWithHostAccess"],
  host_permissions: ["https://pan.baidu.com/*"]
};

const manifests = {
  chromium: { ...commonManifest, background: { service_worker: "background.js" } },
  firefox: {
    ...commonManifest,
    background: { scripts: ["core.js", "background.js"] },
    browser_specific_settings: { gecko: { id: "baidu-pan-transfer@example.local", strict_min_version: "128.0" } }
  }
};

await fs.rm(dist, { recursive: true, force: true });
for (const [target, manifest] of Object.entries(manifests)) {
  const targetDir = path.join(dist, target);
  await fs.mkdir(path.join(targetDir, "icons"), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(src, "core.js"), path.join(targetDir, "core.js")),
    fs.copyFile(path.join(src, "background.js"), path.join(targetDir, "background.js")),
    fs.copyFile(path.join(src, "popup.html"), path.join(targetDir, "popup.html")),
    fs.copyFile(path.join(src, "popup.css"), path.join(targetDir, "popup.css")),
    fs.copyFile(path.join(src, "popup.js"), path.join(targetDir, "popup.js")),
    ...[16, 32, 48, 128].map((size) => fs.copyFile(path.join(src, "icons", `icon${size}.png`), path.join(targetDir, "icons", `icon${size}.png`)))
  ]);
  await fs.writeFile(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Chromium service workers only load one entry file; prepend the shared core.
const chromiumBackground = `${await fs.readFile(path.join(src, "core.js"), "utf8")}\n${await fs.readFile(path.join(src, "background.js"), "utf8")}`;
await fs.writeFile(path.join(dist, "chromium", "background.js"), chromiumBackground);

const metadata = `// ==UserScript==
// @name         百度网盘批量转存助手（跨浏览器版）
// @namespace    https://github.com/kola-official/baidu-transfer-helper
// @version      ${version}
// @description  自动递归拆分并转存超过数量限制的百度网盘分享目录
// @match        https://pan.baidu.com/*
// @grant        GM.cookie
// @grant        GM_cookie
// @run-at       document-idle
// ==/UserScript==`;
const userscript = `${metadata}\n\n${await fs.readFile(path.join(src, "core.js"), "utf8")}\n\n${await fs.readFile(path.join(src, "userscript.js"), "utf8")}`;
await fs.mkdir(path.join(dist, "userscript"), { recursive: true });
await fs.writeFile(path.join(dist, "userscript", "baidu-transfer-helper.user.js"), userscript);
console.log(`Built Chromium, Firefox and userscript packages (v${version}).`);
