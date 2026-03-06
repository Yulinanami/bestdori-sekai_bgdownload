const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { pipeline } = require("stream/promises");

// 配置
const BASE_URL = "https://storage.sekai.best/sekai-jp-assets";
const PREFIX = "scenario/background/";
const OUTPUT_DIR = path.join(process.cwd(), "downloads");
const CONCURRENCY = 8; // 并发下载数
const MAX_RETRIES = 5; // 最大重试次数
const MAX_KEYS = 500; // 每次 API 请求返回的最大数量
const REQUEST_TIMEOUT = 30000; // 单次请求超时时间
const RETRY_CONCURRENCY = Math.max(3, Math.floor(CONCURRENCY / 3)); // 收尾重试并发数

const httpClient = axios.create({
  timeout: REQUEST_TIMEOUT,
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: CONCURRENCY,
    maxFreeSockets: CONCURRENCY,
  }),
});

// 命令行参数：--limit <数量> 限制下载数量（用于测试）
const limitArg = process.argv.indexOf("--limit");
const DOWNLOAD_LIMIT =
  limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

const parser = new XMLParser({
  isArray: (name) => ["CommonPrefixes", "Contents"].includes(name),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用 S3 ListObjectsV2 API 获取目录内容
 */
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

/**
 * 获取指定前缀下的所有子目录（使用 start-after 分页，避开源站 continuation-token 缺陷）
 */
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

/**
 * 获取指定目录下的所有 PNG 文件
 */
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

function addDuplicateSuffix(fileName, index) {
  const parsed = path.parse(fileName);
  return `${parsed.name}(${index})${parsed.ext}`;
}

function assignFileNames(files) {
  const reservedNames = new Set(
    files.map((fileInfo) => path.basename(fileInfo.key)),
  );
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

/**
 * 获取所有背景图 PNG 文件列表（并发扫描目录）
 */
async function getAllPngFiles() {
  console.log("[1/3] 正在获取背景图目录列表...");
  const subDirs = await getAllSubDirs(PREFIX);
  console.log(`   找到 ${subDirs.length} 个子目录`);

  console.log("[2/3] 正在并发扫描每个目录中的 PNG 文件...");
  const allFiles = [];
  let scanned = 0;
  const total = subDirs.length;
  const SCAN_CONCURRENCY = 10; // 目录扫描并发数

  function printScanProgress() {
    process.stdout.write(
      `\r   已扫描 ${scanned}/${total} 个目录，找到 ${allFiles.length} 个 PNG 文件`,
    );
  }

  const pool = [];
  let dirIndex = 0;

  function nextScan() {
    if (dirIndex >= total) return Promise.resolve();
    const currentDir = subDirs[dirIndex++];

    return getPngFilesInDir(currentDir).then((files) => {
      allFiles.push(...files);
      scanned++;
      if (scanned % 20 === 0 || scanned === total) {
        printScanProgress();
      }
      return nextScan();
    });
  }

  for (let i = 0; i < Math.min(SCAN_CONCURRENCY, total); i++) {
    pool.push(nextScan());
  }
  await Promise.all(pool);

  printScanProgress();
  console.log(""); // 换行

  return assignFileNames(allFiles);
}

// 下载逻辑

/**
 * 下载单个文件（支持重试）
 */
async function downloadFile(fileInfo, retries = 0) {
  const fileName = fileInfo.file;
  const filePath = path.join(OUTPUT_DIR, fileName);
  const tmpPath = filePath + ".tmp";

  // 跳过已下载的文件
  if (fs.existsSync(filePath)) {
    const localSize = fs.statSync(filePath).size;
    if (localSize === fileInfo.size) {
      return {
        status: "skipped",
        file: fileName,
        localSize,
        size: fileInfo.size,
      };
    }
  }

  try {
    const url = `${BASE_URL}/${fileInfo.key}`;
    const response = await httpClient.get(url, { responseType: "stream" });

    // 使用临时文件写入，完成后再重命名（避免部分下载的文件）
    const writer = fs.createWriteStream(tmpPath);
    await pipeline(response.data, writer);
    fs.renameSync(tmpPath, filePath);

    return { status: "downloaded" };
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (unlinkErr) {}
    }

    if (retries < MAX_RETRIES) {
      // 等待一段时间后重试
      await sleep(1000 * (retries + 1) + Math.floor(Math.random() * 500));
      return downloadFile(fileInfo, retries + 1);
    }

    return {
      status: "failed",
      file: fileName,
      key: fileInfo.key,
      size: fileInfo.size,
      error: err.message,
    };
  }
}

async function retryFailedFiles(failedFiles) {
  if (failedFiles.length === 0) {
    return { downloaded: 0, skipped: 0, skippedFiles: [], failedFiles: [] };
  }

  await sleep(2000);

  let downloaded = 0;
  let skipped = 0;
  const skippedFiles = [];
  const remainingFailedFiles = [];
  const pool = [];
  let index = 0;

  function next() {
    if (index >= failedFiles.length) return Promise.resolve();
    const currentFile = failedFiles[index++];

    return downloadFile(currentFile).then((result) => {
      if (result.status === "downloaded") downloaded++;
      else if (result.status === "skipped") {
        skipped++;
        skippedFiles.push(result);
      }
      else remainingFailedFiles.push(result);
      return next();
    });
  }

  for (let i = 0; i < Math.min(RETRY_CONCURRENCY, failedFiles.length); i++) {
    pool.push(next());
  }

  await Promise.all(pool);

  return { downloaded, skipped, skippedFiles, failedFiles: remainingFailedFiles };
}

/**
 * 并发控制的批量下载
 */
async function downloadAll(fileKeys) {
  let completed = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const total = fileKeys.length;
  const skippedFiles = [];
  let failedFiles = [];

  function printProgress() {
    process.stdout.write(
      `\r  进度: ${completed}/${total} | 下载: ${downloaded} | 跳过: ${skipped} | 失败: ${failed}`,
    );
  }

  // 使用简单的并发池
  const pool = [];
  let index = 0;

  function next() {
    if (index >= total) return Promise.resolve();
    const currentIndex = index++;
    const fileInfo = fileKeys[currentIndex];

    return downloadFile(fileInfo).then((result) => {
      completed++;
      if (result.status === "downloaded") downloaded++;
      else if (result.status === "skipped") {
        skipped++;
        skippedFiles.push(result);
      }
      else if (result.status === "failed") {
        failed++;
        failedFiles.push(result);
      }
      printProgress();
      return next();
    });
  }

  // 启动并发下载
  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
    pool.push(next());
  }

  await Promise.all(pool);

  if (failedFiles.length > 0) {
    const retryResult = await retryFailedFiles(failedFiles);
    downloaded += retryResult.downloaded;
    skipped += retryResult.skipped;
    skippedFiles.push(...retryResult.skippedFiles);
    failedFiles = retryResult.failedFiles;
    failed = failedFiles.length;
    printProgress();
  }

  console.log(""); // 换行

  return { downloaded, skipped, skippedFiles, failed, failedFiles };
}

// 主流程

async function main() {
  console.log("========================================");
  console.log("  Sekai 背景图批量下载工具");
  console.log("========================================\n");

  // 1. 创建输出目录
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 2. 获取所有 PNG 文件列表
  const allFiles = await getAllPngFiles();
  console.log(`\n共找到 ${allFiles.length} 个 PNG 文件`);

  // 3. 应用数量限制
  const filesToDownload =
    DOWNLOAD_LIMIT < Infinity ? allFiles.slice(0, DOWNLOAD_LIMIT) : allFiles;

  if (DOWNLOAD_LIMIT < Infinity) {
    console.log(`[注意] 限制下载数量: ${DOWNLOAD_LIMIT}`);
  }

  console.log(`下载目录: ${OUTPUT_DIR}`);
  console.log(`并发数: ${CONCURRENCY}\n`);

  // 4. 开始下载
  console.log("开始下载...\n");
  const startTime = Date.now();
  const result = await downloadAll(filesToDownload);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. 输出结果
  console.log("\n========================================");
  console.log("  下载完成!");
  console.log("========================================");
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  成功下载: ${result.downloaded}`);
  console.log(`  已跳过: ${result.skipped}`);
  console.log(`  下载失败: ${result.failed}`);

  if (result.skippedFiles.length > 0) {
    console.log("\n已跳过文件列表:");
    for (const file of result.skippedFiles) {
      console.log(
        `  - ${file.file} (本地: ${file.localSize} bytes, 远端: ${file.size} bytes)`,
      );
    }
  }

  if (result.failedFiles.length > 0) {
    console.log("\n失败文件列表:");
    for (const f of result.failedFiles) {
      console.log(`  - ${f.file}: ${f.error}`);
    }
  }
}

function waitForExit() {
  return new Promise((resolve) => {
    console.log("\n按回车键退出...");
    process.stdin.once("data", resolve);
  });
}

main()
  .catch((err) => {
    console.error("\n发生错误:", err.message);
  })
  .finally(() => waitForExit().then(() => process.exit()));
