import ExcelJS from "exceljs";

/**
 * Loads the "内娱艺人带货等级清单" into a name -> tier map, used to confirm a post
 * is about a real (commercially relevant) celebrity and to surface their 带货等级.
 *
 * Sheet layout: each data row = one tier (col 1, e.g. "S+级男艺人") followed by a
 * long comma/、separated name list (merged across the remaining columns).
 */
export interface CelebMatch {
  name: string;
  tier: string;
}

export async function loadCelebList(filePath: string): Promise<Map<string, string>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const worksheet = workbook.worksheets[0];
  const map = new Map<string, string>();
  if (!worksheet) {
    return map;
  }

  for (let r = 2; r <= worksheet.rowCount; r += 1) {
    const row = worksheet.getRow(r);
    const tier = cellText(row.getCell(1)).trim();

    // The name list sits in a merged cell, so every other column returns the same
    // (long) string — just grab the longest one.
    let names = "";
    row.eachCell((cell, col) => {
      if (col === 1) {
        return;
      }
      const text = cellText(cell);
      if (text.length > names.length) {
        names = text;
      }
    });

    for (const name of splitNames(names)) {
      if (!map.has(name)) {
        map.set(name, tier);
      }
    }
  }

  return map;
}

// Return the longest listed name that appears in the text (longest = most specific,
// avoids a 2-char partial winning over the real 3-4 char name).
export function matchCeleb(text: string, celebs: Map<string, string>): CelebMatch | null {
  let best: CelebMatch | null = null;
  for (const [name, tier] of celebs) {
    if (text.includes(name) && (!best || name.length > best.name.length)) {
      best = { name, tier };
    }
  }
  return best;
}

function splitNames(raw: string): string[] {
  return raw
    .split(/[，,、；;\n\r\t /]+/)
    .map((s) => s.replace(/^[。·．、，,\s]+|[。·．、，,\s]+$/g, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 12);
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) {
    return "";
  }
  if (typeof value === "object" && "richText" in value) {
    return (value as { richText: { text: string }[] }).richText.map((p) => p.text).join("");
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text: unknown }).text ?? "");
  }
  return String(value);
}
