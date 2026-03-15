const readline = require("readline");
const path = require("path");
const { waitForExit } = require("./src/common");

const BG_DIR = path.join(process.cwd(), "bg");
const BESTDORI_DIR = path.join(BG_DIR, "bestdori");
const SEKAI_DIR = path.join(BG_DIR, "sekai");

// 主流程
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("背景图批量下载工具\n");
  console.log("请选择下载源:");
  console.log("  1. Bestdori (BanG Dream!)");
  console.log("  2. Sekai (Project Sekai)");
  console.log("  3. 全部下载\n");

  const choice = await new Promise((resolve) => rl.question("请输入选项 (1/2/3): ", resolve));
  rl.close();

  const selected = choice.trim();

  if (!["1", "2", "3"].includes(selected)) {
    console.log("无效的选项，请输入 1、2 或 3");
    return;
  }

  if (selected === "1" || selected === "3") {
    console.log("\nBestdori 背景图下载\n");
    const bestdori = require("./src/bestdori");
    await bestdori.run(BESTDORI_DIR);
  }

  if (selected === "2" || selected === "3") {
    console.log("\nSekai 背景图下载\n");
    const sekai = require("./src/sekai");
    await sekai.run(SEKAI_DIR);
  }
}

main()
  .catch((err) => {
    console.error("\n发生错误:", err.message);
  })
  .finally(() => waitForExit().then(() => process.exit()));
