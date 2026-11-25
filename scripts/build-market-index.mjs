import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const defaultBaseUrl = "https://raw.githubusercontent.com/chefzejia/seal/main/market/";

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const LANGUAGE_ID_RE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER_RE = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  "u",
);
const MAX_PUBLISH_TIMESTAMP = 1e11;

function parseSemver(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Invalid SemVer version: ${JSON.stringify(version)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemverDesc(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  if (a.patch !== b.patch) return b.patch - a.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return -1;
  if (b.prerelease.length === 0) return 1;
  const maxLen = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < maxLen; i++) {
    const ap = a.prerelease[i];
    const bp = b.prerelease[i];
    if (ap === undefined) return 1;
    if (bp === undefined) return -1;
    if (ap === bp) continue;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) return Number(bp) - Number(ap);
    if (aNum !== bNum) return aNum ? 1 : -1;
    return ap < bp ? 1 : -1;
  }
  return 0;
}

function findLatestArtifact() {
  const explicit = process.env.SEAL_DSH_ARTIFACT?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`SEAL_DSH_ARTIFACT does not exist: ${resolved}`);
    }
    return resolved;
  }
  if (!fs.existsSync(distDir)) {
    throw new Error("dist/ directory does not exist; run npm run build:dsh first");
  }
  const candidates = [];
  for (const name of fs.readdirSync(distDir)) {
    const match = /^seal-dsh-(.+)\.tgz$/.exec(name);
    if (!match) continue;
    const version = match[1];
    if (!SEMVER_RE.test(version)) continue;
    candidates.push({ version, file: path.join(distDir, name) });
  }
  if (candidates.length === 0) {
    throw new Error("No dist/seal-dsh-*.tgz artifact found; run npm run build:dsh first");
  }
  candidates.sort((a, b) => compareSemverDesc(a.version, b.version));
  return candidates[0].file;
}

function validateHttpUrl(value, field, allowFragmentOrQuery = false) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field} must use https: or http:`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${field} must not contain credentials`);
  }
  if (!allowFragmentOrQuery && (url.href.includes("?") || url.href.includes("#"))) {
    throw new Error(`${field} must not contain query or fragment`);
  }
  return url;
}

function validateLocalizedText(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a localized text object`);
  }
  if (typeof value.en !== "string" || !value.en.trim()) {
    throw new Error(`${field}.en must be a non-empty string`);
  }
  for (const [lang, text] of Object.entries(value)) {
    if (!LANGUAGE_ID_RE.test(lang)) {
      throw new Error(`${field}.${lang} must use lowercase language id`);
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`${field}.${lang} must be a non-empty string`);
    }
  }
}

export function validateFormat1Index(index, indexUrl) {
  validateHttpUrl(indexUrl, "indexUrl");
  const base = new URL(indexUrl);
  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    throw new Error("$ must be an object");
  }
  if (index.format !== 1) throw new Error("$.format must be 1");
  validateLocalizedText(index.title, "$.title");
  if (index.description !== undefined) {
    validateLocalizedText(index.description, "$.description");
  }
  if (typeof index.metadata !== "object" || index.metadata === null || Array.isArray(index.metadata)) {
    throw new Error("$.metadata must be an object");
  }
  const categories = index.metadata.categories ?? {};
  const labels = index.metadata.labels ?? {};
  const sortKeys = index.metadata.sortKeys ?? {};
  for (const [id, decl] of Object.entries(categories)) {
    if (!id) throw new Error("$.metadata.categories must not have empty id");
    validateLocalizedText(decl?.title, `$.metadata.categories.${id}.title`);
  }
  for (const [id, decl] of Object.entries(labels)) {
    if (!id) throw new Error("$.metadata.labels must not have empty id");
    validateLocalizedText(decl?.title, `$.metadata.labels.${id}.title`);
  }
  for (const [id, decl] of Object.entries(sortKeys)) {
    if (!id) throw new Error("$.metadata.sortKeys must not have empty id");
    if (decl?.order !== "asc" && decl?.order !== "desc") {
      throw new Error(`$.metadata.sortKeys.${id}.order must be "asc" or "desc"`);
    }
    validateLocalizedText(decl?.title, `$.metadata.sortKeys.${id}.title`);
  }
  if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
    throw new Error("$.plugins must be a non-empty array");
  }
  const pluginNames = new Set();
  for (let i = 0; i < index.plugins.length; i++) {
    const p = index.plugins[i];
    const prefix = `$.plugins[${i}]`;
    if (typeof p?.name !== "string" || p.name.length > 214 || !PACKAGE_NAME_RE.test(p.name)) {
      throw new Error(`${prefix}.name must be a valid npm package name`);
    }
    if (pluginNames.has(p.name)) throw new Error(`${prefix}.name duplicates ${p.name}`);
    pluginNames.add(p.name);
    if (p.title !== undefined) validateLocalizedText(p.title, `${prefix}.title`);
    if (p.description !== undefined) validateLocalizedText(p.description, `${prefix}.description`);
    if (p.icon !== undefined) {
      if (typeof p.icon !== "string" || !p.icon.trim()) {
        throw new Error(`${prefix}.icon must be a non-empty string`);
      }
      const resolvedIcon = new URL(p.icon, base);
      if (resolvedIcon.protocol !== "https:" && resolvedIcon.origin !== base.origin) {
        throw new Error(`${prefix}.icon must resolve to https or index origin`);
      }
    }
    if (p.author !== undefined && (typeof p.author !== "string" || !p.author.trim())) {
      throw new Error(`${prefix}.author must be a non-empty string`);
    }
    if (p.homepage !== undefined) validateHttpUrl(p.homepage, `${prefix}.homepage`, true);
    if (p.repository !== undefined) {
      validateHttpUrl(p.repository?.url, `${prefix}.repository.url`);
    }
    if (p.metadata?.category !== undefined && !Object.hasOwn(categories, p.metadata.category)) {
      throw new Error(`${prefix}.metadata.category references undeclared id`);
    }
    if (p.metadata?.labels !== undefined) {
      if (!Array.isArray(p.metadata.labels)) throw new Error(`${prefix}.metadata.labels must be array`);
      if (new Set(p.metadata.labels).size !== p.metadata.labels.length) {
        throw new Error(`${prefix}.metadata.labels must not repeat a label`);
      }
      for (const labelId of p.metadata.labels) {
        if (!Object.hasOwn(labels, labelId)) {
          throw new Error(`${prefix}.metadata.labels references undeclared id ${labelId}`);
        }
      }
    }
    if (p.metadata?.sortKeys !== undefined) {
      for (const [k, v] of Object.entries(p.metadata.sortKeys)) {
        if (!Object.hasOwn(sortKeys, k)) {
          throw new Error(`${prefix}.metadata.sortKeys.${k} is undeclared`);
        }
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new Error(`${prefix}.metadata.sortKeys.${k} must be a finite number`);
        }
      }
    }
    if (!Array.isArray(p.versions) || p.versions.length === 0) {
      throw new Error(`${prefix}.versions must be a non-empty array`);
    }
    const seenVersions = new Set();
    for (let vIdx = 0; vIdx < p.versions.length; vIdx++) {
      const ver = p.versions[vIdx];
      const vPrefix = `${prefix}.versions[${vIdx}]`;
      if (typeof ver?.version !== "string" || !SEMVER_RE.test(ver.version)) {
        throw new Error(`${vPrefix}.version must be exact SemVer`);
      }
      if (seenVersions.has(ver.version)) {
        throw new Error(`${vPrefix}.version duplicates ${ver.version}`);
      }
      seenVersions.add(ver.version);
      if (
        typeof ver.publishTimestamp !== "number" ||
        !Number.isInteger(ver.publishTimestamp) ||
        ver.publishTimestamp < 0 ||
        ver.publishTimestamp >= MAX_PUBLISH_TIMESTAMP
      ) {
        throw new Error(`${vPrefix}.publishTimestamp must be an integer Unix seconds in [0, 10^11)`);
      }
      if (ver.source?.type !== "npm") {
        throw new Error(`${vPrefix}.source.type must be "npm"`);
      }
      if (ver.source.registry !== undefined) {
        validateHttpUrl(ver.source.registry, `${vPrefix}.source.registry`);
      }
      if (ver.engines?.dsh !== undefined) {
        if (typeof ver.engines.dsh !== "string" || !ver.engines.dsh.trim() || ver.engines.dsh.startsWith("workspace:")) {
          throw new Error(`${vPrefix}.engines.dsh is invalid`);
        }
      }
    }
  }
}

export function buildMarketIndex() {
  const artifact = findLatestArtifact();
  const outDir = path.resolve(process.env.SEAL_MARKET_OUT_DIR?.trim() || path.join(root, "market"));
  const rawBaseUrl = process.env.SEAL_MARKET_BASE_URL?.trim() || defaultBaseUrl;
  const baseUrl = rawBaseUrl.endsWith("/") ? rawBaseUrl : `${rawBaseUrl}/`;
  validateHttpUrl(baseUrl, "SEAL_MARKET_BASE_URL");
  const indexUrl = new URL("index.json", baseUrl).href;

  const rawRegistry = process.env.SEAL_NPM_REGISTRY?.trim() || undefined;
  const registry = rawRegistry !== undefined ? validateHttpUrl(rawRegistry, "SEAL_NPM_REGISTRY").href : undefined;

  const rawTs = process.env.SEAL_MARKET_PUBLISH_TIMESTAMP?.trim();
  const publishTimestamp = rawTs ? Number(rawTs) : Math.floor(Date.now() / 1000);
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    throw new Error(`Invalid SEAL_MARKET_PUBLISH_TIMESTAMP: ${rawTs}`);
  }

  fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, ".tmp/seal-market-"));
  try {
    execFileSync("tar", ["-xzf", artifact, "-C", scratch], { stdio: "pipe" });
    const pkgDir = path.join(scratch, "package");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const zhLocale = JSON.parse(fs.readFileSync(path.join(pkgDir, "locale/zh.json"), "utf8"));
    const enLocale = JSON.parse(fs.readFileSync(path.join(pkgDir, "locale/en.json"), "utf8"));
    const iconSvg = fs.readFileSync(path.join(pkgDir, "icon.svg"), "utf8");

    const indexPath = path.join(outDir, "index.json");
    const existingVersions = [];
    if (fs.existsSync(indexPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        const match = Array.isArray(existing?.plugins)
          ? existing.plugins.find((item) => item?.name === pkg.name)
          : null;
        if (Array.isArray(match?.versions)) {
          for (const entry of match.versions) {
            if (entry?.version && entry.version !== pkg.version) {
              existingVersions.push(entry);
            }
          }
        }
      } catch {
        // Ignore unreadable prior index; regenerate cleanly.
      }
    }

    const currentVersion = {
      version: pkg.version,
      publishTimestamp,
      source: {
        type: "npm",
        ...(registry ? { registry } : {}),
      },
      engines: {
        ...(pkg.engines?.dsh ? { dsh: pkg.engines.dsh } : {}),
      },
    };

    const versions = [currentVersion, ...existingVersions].sort((a, b) =>
      compareSemverDesc(a.version, b.version),
    );
    const newestTimestamp = Math.max(
      ...versions.map((v) => (Number.isInteger(v.publishTimestamp) ? v.publishTimestamp : 0)),
    );

    const repoUrl =
      typeof pkg.repository?.url === "string"
        ? pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")
        : "https://github.com/chefzejia/seal";

    const index = {
      format: 1,
      title: {
        en: "Seal Plugin Index",
        zh: "Seal 插件索引",
      },
      description: {
        en: "Official Seal plugin index for DeepSeek Harness — evidence-backed Word/Office assembly and deterministic verification.",
        zh: "DeepSeek Harness 官方 Seal 插件索引——证据驱动 Word/Office 文档装配与确定性核验工作台。",
      },
      metadata: {
        categories: {
          "office-documents": {
            title: { en: "Office & Documents", zh: "办公与文档" },
          },
        },
        labels: {
          "local-first": {
            title: { en: "Local-First", zh: "本地优先" },
          },
          "verified-workflow": {
            title: { en: "Deterministic Verification", zh: "确定性验算" },
          },
        },
        sortKeys: {
          updated: {
            title: { en: "Recently Updated", zh: "最近更新" },
            order: "desc",
          },
        },
      },
      plugins: [
        {
          name: pkg.name,
          title: {
            en: enLocale.meta?.title || "Seal",
            zh: zhLocale.meta?.title || "Seal",
          },
          description: {
            en: enLocale.meta?.description || pkg.description,
            zh: zhLocale.meta?.description || pkg.description,
          },
          icon: "./icon.svg",
          author: pkg.author || "Seal Team",
          homepage: pkg.homepage || "https://github.com/chefzejia/seal#readme",
          repository: {
            url: repoUrl,
          },
          metadata: {
            category: "office-documents",
            keywords: Array.isArray(pkg.keywords)
              ? pkg.keywords
              : ["dsh", "deepseek-harness", "seal", "docx", "office", "knowledge-base", "bidding"],
            labels: ["local-first", "verified-workflow"],
            sortKeys: {
              updated: newestTimestamp,
            },
          },
          versions,
        },
      ],
    };

    validateFormat1Index(index, indexUrl);

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "icon.svg"), iconSvg, "utf8");
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
    return { indexPath, iconPath: path.join(outDir, "icon.svg"), index, artifact };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildMarketIndex();
  console.log(result.indexPath);
}
