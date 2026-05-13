import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const suiFeRoot = packageRoot("@suilend/sui-fe");
const suilendSdkRoot = packageRoot("@suilend/sdk");

const indexPath = suiFeRoot ? join(suiFeRoot, "index.js") : "";
const libIndexPath = suiFeRoot ? join(suiFeRoot, "lib", "index.js") : "";

patchFile(indexPath, (source) =>
  source
    .replaceAll('from "./lib";', 'from "./lib/index.js";')
    .replaceAll('from "./api";', 'from "./lib/api.js";')
    .replaceAll('from "./coin";', 'from "./lib/coin.js";')
    .replaceAll('from "./coinMetadata";', 'from "./lib/coinMetadata.js";')
    .replaceAll('from "./coinType";', 'from "./lib/coinType.js";')
    .replaceAll('from "./constants";', 'from "./lib/constants.js";')
    .replaceAll('from "./format";', 'from "./lib/format.js";')
    .replaceAll('from "./indexedDB";', 'from "./lib/indexedDB.js";')
    .replaceAll('from "./keypair";', 'from "./lib/keypair.js";')
    .replaceAll('from "./ledger";', 'from "./lib/ledger.js";')
    .replaceAll('from "./msafe";', 'from "./lib/msafe.js";')
    .replaceAll('from "./transactions";', 'from "./lib/transactions.js";'),
);

patchFile(libIndexPath, (source) =>
  source
    .replaceAll('from "./api";', 'from "./api.js";')
    .replaceAll('from "./coin";', 'from "./coin.js";')
    .replaceAll('from "./coinMetadata";', 'from "./coinMetadata.js";')
    .replaceAll('from "./coinType";', 'from "./coinType.js";')
    .replaceAll('from "./constants";', 'from "./constants.js";')
    .replaceAll('from "./format";', 'from "./format.js";')
    .replaceAll('from "./indexedDB";', 'from "./indexedDB.js";')
    .replaceAll('from "./keypair";', 'from "./keypair.js";')
    .replaceAll('from "./ledger";', 'from "./ledger.js";')
    .replaceAll('from "./msafe";', 'from "./msafe.js";')
    .replaceAll('from "./transactions";', 'from "./transactions.js";'),
);

const libDir = suiFeRoot ? join(suiFeRoot, "lib") : "";
patchRelativeImports(libDir);
patchRelativeImports(suilendSdkRoot ?? "");
patchLodashCjsInterop(suiFeRoot ? join(suiFeRoot, "lib", "coinMetadata.js") : "", ["chunk"]);
patchLodashCjsInterop(suilendSdkRoot ? join(suilendSdkRoot, "strategies.js") : "", ["cloneDeep"]);
patchLodashCjsInterop(suilendSdkRoot ? join(suilendSdkRoot, "lib", "liquidityMining.js") : "", ["cloneDeep"]);

function patchFile(path, patch) {
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  const patched = patch(source);
  if (patched !== source) writeFileSync(path, patched);
}

function jsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return jsFiles(path);
    return path.endsWith(".js") ? [path] : [];
  });
}

function patchRelativeImports(dir) {
  if (!existsSync(dir)) return;
  for (const file of jsFiles(dir)) {
    patchFile(file, (source) =>
      source
        .replaceAll('from "..";', 'from "../index.js";')
        .replaceAll('from ".";', 'from "./index.js";')
        .replace(/from "(\.{1,2}\/[^"]+)";/g, (match, specifier) => {
          if (specifier.endsWith(".js")) return match;
          const target = resolve(dirname(file), `${specifier}.js`);
          const indexTarget = resolve(dirname(file), specifier, "index.js");
          return existsSync(target) ? `from "${specifier}.js";` : existsSync(indexTarget) ? `from "${specifier}/index.js";` : match;
        }),
    );
  }
}

function patchLodashCjsInterop(path, names) {
  patchFile(path, (source) => {
    const importLine = `import { ${names.join(", ")} } from "lodash";`;
    if (!source.includes(importLine)) return source;
    return source.replace(importLine, `import lodash from "lodash";\nconst { ${names.join(", ")} } = lodash;`);
  });
}

function packageRoot(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}
