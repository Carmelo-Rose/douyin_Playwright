/**
 * 跨平台 Python 定位与环境检测（替代 Windows 专用的 ml/run.ps1）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** 各 backbone 的特征维度（用于和已训练模型的 feature_dim 比对）。 */
const BACKBONE_DIM: Record<string, number> = {
  "clip-b32": 512,
  "siglip2-l": 1024,
  "dinov2-l": 1024,
};

/** backbone 字符串支持 "a+b" 拼接，维度相加。未知部分计 0。 */
export function backboneDim(backbone: string): number {
  return backbone
    .split("+")
    .map((p) => BACKBONE_DIM[p.trim()] ?? 0)
    .reduce((a, b) => a + b, 0);
}

const IS_WIN = process.platform === "win32";

/**
 * 推导 Accio 内置 Python 路径。
 * Accio 把 node/python 放在同级目录：.../pre-install/<hash>/node/node(.exe) 与 .../python/python(.exe)。
 * 通过环境变量 ACCIO_NODE_BIN 拿到 node 路径，回溯到 pre-install 根再拼出 python。
 * 这条候选不依赖 PATH，可解决"内置 python 不在 PATH 首位/不在 PATH"的问题。
 */
function builtinPythonCandidates(): string[] {
  const out: string[] = [];
  const exe = IS_WIN ? "python.exe" : "python3";
  const exeAlt = IS_WIN ? "python3.exe" : "python";

  // ACCIO_NODE_BIN: .../pre-install/<hash>/node/node(.exe) → 同级 python 目录
  const nodeBin = process.env.ACCIO_NODE_BIN?.trim();
  if (nodeBin) {
    const preInstallRoot = path.dirname(path.dirname(nodeBin)); // 去掉 node/node.exe 两层
    for (const name of [exe, exeAlt]) {
      out.push(path.join(preInstallRoot, "python", name));
    }
  }
  return out.filter((p) => existsSync(p));
}

/** 跨平台枚举 PATH 上的 python（Windows: where；其余: which -a）。去重。 */
async function listPathPythons(): Promise<string[]> {
  const finder = IS_WIN ? "where" : "which";
  const names = IS_WIN ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const out = new Set<string>();
  for (const name of names) {
    try {
      const args = IS_WIN ? [name] : ["-a", name];
      const { stdout } = await pexec(finder, args, { timeout: 5_000 });
      for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        out.add(line);
      }
    } catch {
      // finder 找不到该名字就跳过
    }
  }
  return [...out];
}

let cachedPython: string | undefined;

/** 解析要用的 python 可执行：优先用户配置，回退到能 import open_clip 的解释器（结果缓存）。 */
export async function resolvePython(configured: string): Promise<string> {
  const fixed = configured?.trim();
  if (fixed) return fixed;

  if (cachedPython) return cachedPython;

  // 候选顺序：内置 python（不在 PATH 也能命中） → PATH 上的 python，整体去重
  const ordered = [...builtinPythonCandidates(), ...(await listPathPythons())];
  const candidates = [...new Set(ordered)];

  // 优先找能 import open_clip 的解释器
  for (const cand of candidates) {
    try {
      await pexec(cand, ["-c", "import open_clip"], { timeout: 15_000 });
      cachedPython = cand;
      return cand;
    } catch {
      // 继续尝试下一个
    }
  }

  // 没找到 open_clip 时回退第一个可用候选（不缓存：留待依赖装好后重试能重新命中）
  return candidates[0] ?? (IS_WIN ? "python" : "python3");
}

/** 清除已缓存的 python 解析结果（装完依赖或用户改配置后调用，强制下次重新探测）。 */
export function clearPythonCache(): void {
  cachedPython = undefined;
}

const DETECT_SNIPPET = `
import json, sys
mods = ["torch", "open_clip", "sklearn", "joblib", "PIL", "torchvision", "numpy"]
missing = []
for m in mods:
    try:
        __import__(m)
    except Exception:
        missing.append(m)
print(json.dumps({"py": sys.version.split()[0], "missing": missing}))
`.trim();

export interface PythonProbe {
  pythonVersion: string;
  missing: string[];
  error?: string;
}

/** 跑一段探针脚本，报告 python 版本和缺失依赖。 */
export async function probePython(python: string, cwd: string, env: NodeJS.ProcessEnv): Promise<PythonProbe> {
  try {
    const { stdout } = await pexec(python, ["-c", DETECT_SNIPPET], { cwd, env, timeout: 60_000 });
    const line = stdout.trim().split(/\r?\n/).pop() ?? "{}";
    const parsed = JSON.parse(line) as { py: string; missing: string[] };
    return { pythonVersion: parsed.py, missing: parsed.missing };
  } catch (e) {
    return { pythonVersion: "", missing: [], error: e instanceof Error ? e.message : String(e) };
  }
}
