# 个性化审美管线 - PowerShell 启动脚本
# 自动定位装好依赖的 Python（避免用错没装库的系统 Python）
#
# 用法（在项目根目录 D:\data\accio\douyin_Playwright 下）：
#   .\ml\run.ps1 predict  -Input "图片文件夹" -SortTo "结果文件夹"
#   .\ml\run.ps1 merge    -From  "结果文件夹"
#   .\ml\run.ps1 train
#   .\ml\run.ps1 extract  -Input "output\xxx.xlsx" -Out "ml\data\to_predict" -MaxNotes 30

param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet("predict", "merge", "train", "extract")]
    [string]$Action,

    [string]$InputPath,
    [string]$SortTo,
    [string]$From,
    [string]$Out = "ml\data\to_predict",
    [int]$MaxNotes = 0,
    [int]$ImgsPerNote = 0,
    [double]$Threshold = 0.75,
    [string]$Csv = ""
)

$ErrorActionPreference = "Stop"

# --- 定位装好依赖的 Python ---
function Find-Python {
    # 1) Accio 内置 Python（带依赖），路径含哈希目录，自动搜索
    $preInstall = Join-Path $env:APPDATA "Accio\pre-install"
    if (Test-Path $preInstall) {
        $cand = Get-ChildItem $preInstall -Directory |
            ForEach-Object { Join-Path $_.FullName "python\python.exe" } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if ($cand) { return $cand }
    }
    # 2) 回退：系统 python（可能没装依赖，会提示）
    $sys = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($sys) { return $sys }
    throw "找不到可用的 Python"
}

$py = Find-Python
Write-Host "[run] 使用 Python: $py" -ForegroundColor Cyan

$env:PYTHONIOENCODING = "utf-8"

switch ($Action) {
    "predict" {
        if (-not $InputPath) { throw "predict 需要 -Input" }
        $args = @("ml\predict.py", "--input", $InputPath, "--threshold", $Threshold)
        if ($SortTo) { $args += @("--sort-to", $SortTo) }
        if ($Csv)    { $args += @("--csv", $Csv) }
        & $py @args
    }
    "merge" {
        if (-not $From) { throw "merge 需要 -From" }
        & $py "ml\merge_feedback.py" "--from" $From
    }
    "train" {
        & $py "ml\train_singleimage.py"
    }
    "extract" {
        if (-not $InputPath) { throw "extract 需要 -Input" }
        $args = @("ml\extract_images_only.py", "--input", $InputPath, "--out", $Out, "--imgs-per-note", $ImgsPerNote)
        if ($MaxNotes -gt 0) { $args += @("--max-notes", $MaxNotes) }
        & $py @args
    }
}
