const { XMLParser } = require("fast-xml-parser");
const path = require("path");
const { httpClient, colorize, createProgressBar, downloadAll } = require("./common");

// Sekai 配置
const BASE_URL = "https://storage.sekai.best/sekai-jp-assets";
const PREFIX = "scenario/background/";
const MAX_KEYS = 500;
const SCAN_CONCURRENCY = 10;

const parser = new XMLParser({
  isArray: (name) => ["CommonPrefixes", "Contents"].includes(name),
});

// 从服务器拉文件列表
async function listObjects(prefix, continuationToken, delimiter = "/", startAfter) {
  const params = {
    "list-type": "2",
    "max-keys": MAX_KEYS,
    prefix,
  };
  if (delimiter) {
    params.delimiter = delimiter;
  }
  if (continuationToken) {
    params["continuation-token"] = continuationToken;
  }
  if (startAfter) {
    params["start-after"] = startAfter;
  }

  const response = await httpClient.get(`${BASE_URL}/`, {
    params,
    responseType: "text",
  });

  return parser.parse(response.data).ListBucketResult;
}

// 拿到所有背景图文件夹
async function getAllSubDirs(prefix) {
  const dirs = [];
  let startAfter = undefined;

  do {
    const result = await listObjects(prefix, undefined, "/", startAfter);
    const pageDirs = [];

    if (result.CommonPrefixes) {
      for (const cp of result.CommonPrefixes) {
        const dirName = path.basename(cp.Prefix.slice(0, -1));
        if (dirName.startsWith("bg")) {
          dirs.push(cp.Prefix);
          pageDirs.push(cp.Prefix);
        }
      }
    }

    const isTruncated = String(result.IsTruncated) === "true";
    startAfter =
      isTruncated && pageDirs.length > 0
        ? pageDirs[pageDirs.length - 1]
        : undefined;
  } while (startAfter);

  return dirs;
}

// 拿到一个文件夹里的所有 PNG 文件
async function getPngFilesInDir(prefix) {
  const files = [];
  let token = undefined;

  do {
    const result = await listObjects(prefix, token);
    if (result.Contents) {
      for (const content of result.Contents) {
        if (content.Key.endsWith(".png")) {
          files.push({
            key: content.Key,
            size: Number(content.Size),
          });
        }
      }
    }
    token = result.NextContinuationToken;
  } while (token);

  return files;
}

// 文件重名了就加个序号，比如 xxx(2).png
function addDuplicateSuffix(fileName, index) {
  const parsed = path.parse(fileName);
  return `${parsed.name}(${index})${parsed.ext}`;
}

// 给所有重名文件分配不重复的名字
function assignFileNames(files) {
  const reservedNames = new Set(files.map((fileInfo) => path.basename(fileInfo.key)));
  const generatedNames = new Set();
  const groups = new Map();

  for (const fileInfo of files) {
    const fileName = path.basename(fileInfo.key);
    if (!groups.has(fileName)) {
      groups.set(fileName, []);
    }
    groups.get(fileName).push(fileInfo);
  }

  for (const [fileName, group] of groups) {
    group.sort((a, b) => a.key.localeCompare(b.key));
    group[0].file = fileName;

    let suffix = 2;
    for (let i = 1; i < group.length; i++) {
      let nextFileName = addDuplicateSuffix(fileName, suffix);
      while (
        reservedNames.has(nextFileName) ||
        generatedNames.has(nextFileName)
      ) {
        suffix++;
        nextFileName = addDuplicateSuffix(fileName, suffix);
      }
      group[i].file = nextFileName;
      generatedNames.add(nextFileName);
      suffix++;
    }
  }

  return files;
}

// 扫描所有背景图文件
async function getAllPngFiles() {
  console.log("[1/2] 正在获取背景图目录列表...");
  const subDirs = await getAllSubDirs(PREFIX);
  console.log(`   找到 ${subDirs.length} 个子目录`);

  console.log("[2/2] 正在并发扫描每个目录中的 PNG 文件...");
  const allFiles = [];
  let scanned = 0;
  const total = subDirs.length;

  const scanBar = createProgressBar(`${colorize(36, "   扫描: {bar}")} ${colorize(33, "{percentage}%")} | ${colorize(33, "{value}/{total}")} | 已找到 ${colorize(32, "{found}")} 个 PNG 文件 | 用时 ${colorize(35, "{duration_formatted}")} | 剩余 ${colorize(36, "{eta_formatted}")}`);

  const pool = [];
  let dirIndex = 0;

  if (total > 0) {
    scanBar.start(total, 0, { found: 0 });
  }

  // 取下一个文件夹去扫描
  function nextScan() {
    if (dirIndex >= total) return Promise.resolve();
    const currentDir = subDirs[dirIndex++];

    return getPngFilesInDir(currentDir).then((files) => {
      allFiles.push(...files);
      scanned++;
      if (total > 0) {
        scanBar.update(scanned, { found: allFiles.length });
      }
      return nextScan();
    });
  }

  for (let i = 0; i < Math.min(SCAN_CONCURRENCY, total); i++) {
    pool.push(nextScan());
  }
  await Promise.all(pool);

  if (total > 0) {
    scanBar.stop();
  }

  return assignFileNames(allFiles);
}

// Sekai 下载主流程
async function run(outputDir) {
  const allFiles = await getAllPngFiles();
  console.log(`\n共找到 ${allFiles.length} 个 PNG 文件`);

  // 把文件信息转成下载任务
  const fileTasks = allFiles.map((f) => ({
    url: `${BASE_URL}/${f.key}`,
    filePath: path.join(outputDir, f.file),
    remoteSize: f.size,
  }));

  console.log(`下载目录: ${outputDir}`);
  console.log("\n开始下载...\n");

  const startTime = Date.now();
  const result = await downloadAll(fileTasks);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n下载完成!");
  console.log(`耗时: ${elapsed}s`);
  console.log(`成功下载: ${result.downloaded}`);
  console.log(`已跳过: ${result.skipped} (已存在 ${result.skippedExisting})`);
  console.log(`下载失败: ${result.failed}`);

  if (result.failedFiles.length > 0) {
    console.log("\n失败文件列表:");
    for (const f of result.failedFiles) {
      console.log(`  - ${f.file}: ${f.error}`);
    }
  }
}

module.exports = { run };
