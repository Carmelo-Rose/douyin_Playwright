import path from "node:path";
import ExcelJS from "exceljs";
import fs from "fs-extra";
import type { ProductRecord } from "./types.js";

export async function exportProductsToXlsx(products: ProductRecord[], outputDir: string, keyword: string): Promise<string> {
  await fs.ensureDir(outputDir);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "douyin_playwright";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("products");
  worksheet.columns = [
    { header: "商品ID", key: "productId", width: 24 },
    { header: "商品名", key: "title", width: 48 },
    { header: "价格", key: "price", width: 14 },
    { header: "销量或热度", key: "salesOrHeat", width: 18 },
    { header: "店铺", key: "shopName", width: 24 },
    { header: "商品链接", key: "productUrl", width: 60 },
    { header: "图片链接", key: "imageUrl", width: 60 },
    { header: "来源", key: "source", width: 10 },
    { header: "抓取时间", key: "capturedAt", width: 24 },
    { header: "原始片段", key: "rawSnippet", width: 80 },
  ];

  worksheet.addRows(products);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  const filename = `douyin-products-${sanitizeFilename(keyword)}-${formatTimestamp(new Date())}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(outputPath);

  return outputPath;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "keyword";
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
