// ベースイメージが digest で固定されているかの検査（SO-SC-02、D-50）
// apps/*/Dockerfileの FROM と compose.yaml の image: が、@sha256:<64桁> つきか、前の段の名前であること。
// ARG の既定値は FROM の中で展開してから確かめる。使い方：node .github/scripts/check-image-digests.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const DIGEST = /@sha256:[0-9a-f]{64}$/;

const dockerfiles = readdirSync(join(root, "apps"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join("apps", d.name, "Dockerfile"))
  .filter((f) => existsSync(join(root, f)));

const problems = [];
let checked = 0;

for (const file of dockerfiles) {
  const args = new Map();
  const stages = new Set();
  readFileSync(join(root, file), "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/i.exec(line);
      if (arg) {
        args.set(arg[1], arg[2]);
        return;
      }
      const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (!from) return;
      const written = from[1];
      const image = written.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => args.get(name) ?? "");
      checked += 1;
      if (!stages.has(image.toLowerCase()) && image !== "scratch" && !DIGEST.test(image)) {
        problems.push(`${file}:${i + 1} FROM ${written}${written === image ? "" : `（= ${image || "空"}）`}`);
      }
      if (from[2]) stages.add(from[2].toLowerCase());
    });
}

const compose = "compose.yaml";
if (existsSync(join(root, compose))) {
  readFileSync(join(root, compose), "utf8")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const m = /^\s*image:\s*["']?([^"'\s#]+)/.exec(raw);
      if (!m) return;
      checked += 1;
      if (!DIGEST.test(m[1])) problems.push(`${compose}:${i + 1} image: ${m[1]}`);
    });
}

if (problems.length > 0) {
  process.stderr.write(`digest で固定されていないイメージがある（${problems.length}件）\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`イメージの digest の固定：OK（${checked} か所）\n`);
