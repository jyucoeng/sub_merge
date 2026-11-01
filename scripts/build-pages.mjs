// 为 Cloudflare Pages 打包：Pages 的「高级模式」认 _worker.js（ESM，导出 default { fetch }）。
// src/index.js 是单文件、无 import，所以这里只做一次复制并加抬头注释。
import fs from "node:fs";
import path from "node:path";

const out = "dist-pages";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const source = fs.readFileSync("src/index.js", "utf8");
const banner = `// sub-worker Pages build (_worker.js)
// 部署：wrangler pages deploy dist-pages --project-name sub-merge
// 绑定：Pages 项目 -> Settings -> Bindings -> D1 database，变量名必须是 DB
// 变量：Settings -> Variables and Secrets 里配 ADMIN_PASSWORD / SUB_TOKEN / REPORT_TOKEN
// 建表：部署后 POST /api/v1/admin/schema（Bearer SUB_TOKEN）

`;
fs.writeFileSync(path.join(out, "_worker.js"), banner + source);
console.log(`dist-pages/_worker.js generated (${(banner + source).length} B)`);
