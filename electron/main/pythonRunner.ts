/**
 * 跨平台 Python 定位与环境检测（替代 Windows 专用的 ml/run.ps1）。
 */
import { execFile } from "node:child_process";
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

/** 解析要用的 python 可执行：优先用户配置，回退到能 import open_clip 的解释器。 */
export async function resolvePython(configured: string): Promise<string> {
  const fixed = configured?.trim();
  if (fixed) return fixed;

  // 收集所有候选：先枚举 PATH 里的 python，再加 Windows 常见安装路径
  const candidates: string[] = [];
  for (const name of ["python3", "python"]) {
    try {
      const { stdout } = await pexec("where", [name], { timeout: 5_000 });
      for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        candidates.push(line);
      }
    } catch {
      // where 找不到就跳过
    }
  }

  // 优先找能 import open_clip 的解释器
  for (const cand of candidates) {
    try {
      await pexec(cand, ["-c", "import open_clip"], { timeout: 10_000 });
      return cand;
    } catch {
      // 继续尝试下一个
    }
  }

  // 没找到 open_clip 时回退第一个可用的
  return candidates[0] ?? "python3";
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
