# 美学分消融 + backbone 公平对比脚本（第 2/3 步验证用）
#
# 一条命令跑完：先预抽美学分缓存，再在「关 dedup 全样本」同口径下逐个配置训练，
# 每个配置的完整日志单独存 ml\ablation_<配置>.log，方便回贴对比。
#
# 用法（项目根目录 D:\data\accio\douyin_Playwright 下）：
#   .\ml\run_ablation.ps1
#
# 注意：
#   - 会覆盖 ml\model\aesthetic_clf.joblib（每个配置重训一次）。跑完后用想要的配置
#     重训一次才能恢复线上识图模型。
#   - 关 dedup 是为了同样本集公平对比，不会重新引入泄漏（防泄漏靠 GroupKFold）。

$ErrorActionPreference = "Stop"

# --- 复用 run.ps1 的找 Python 逻辑（装了依赖的那个）---
function Find-Python {
    $preInstall = Join-Path $env:APPDATA "Accio\pre-install"
    if (Test-Path $preInstall) {
        $cand = Get-ChildItem $preInstall -Directory |
            ForEach-Object { Join-Path $_.FullName "python\python.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($cand) { return $cand }
    }
    $sys = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($sys) { return $sys }
    throw "找不到可用的 Python"
}

$py = Find-Python
Write-Host "[ablation] 使用 Python: $py" -ForegroundColor Cyan
$env:PYTHONIOENCODING = "utf-8"

# --- 0) 预抽美学分缓存（只加载 CLIP ViT-L/14，避免和 backbone 大模型同时占显存）---
Write-Host "`n==== [0/5] 预抽美学分缓存 ====" -ForegroundColor Yellow
& $py "ml\aesthetic.py" "--precompute"

# --- 消融配置（全部 --no-dedup 同口径）---
#   aes-laion          : 仅美学分 1 维 —— 诊断有没有信号（关键）
#   clip-b32           : ViT-B-32 基线
#   clip-b32+aes-laion : backbone + 美学分 —— 看增量
#   siglip2-l          : 顺带补第 2 步 backbone 公平对比
$configs = @("aes-laion", "clip-b32", "clip-b32+aes-laion", "siglip2-l")

$i = 1
foreach ($cfg in $configs) {
    $tag = $cfg -replace '[+]', '_'
    $log = "ml\ablation_$tag.log"
    Write-Host "`n==== [$i/5] EMBED_BACKBONE=$cfg  (--no-dedup) -> $log ====" -ForegroundColor Yellow
    $env:EMBED_BACKBONE = $cfg
    & $py "ml\train_singleimage.py" "--no-dedup" 2>&1 | Tee-Object -FilePath $log
    $i++
}

Write-Host "`n==== 全部完成 ====" -ForegroundColor Green
Write-Host "各配置日志：ml\ablation_aes-laion.log / ablation_clip-b32.log / ablation_clip-b32_aes-laion.log / ablation_siglip2-l.log"
Write-Host "回贴每个日志里的『分组CV acc + 混淆矩阵』即可。"
Write-Host "提醒：线上模型已被最后一个配置($($configs[-1]))覆盖，定了配置后请重训恢复。" -ForegroundColor DarkYellow
