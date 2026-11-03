$stageDir = Join-Path $env:TEMP "runbook-prod-stage"
if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
$appStage = Join-Path $stageDir "runbook-portal"
New-Item -ItemType Directory -Path $appStage -Force | Out-Null

Write-Host "Copying production frontend files..."
Copy-Item -Recurse "src" (Join-Path $appStage "src")
Copy-Item -Recurse "public" (Join-Path $appStage "public")
Copy-Item -Recurse "scripts" (Join-Path $appStage "scripts")

Write-Host "Copying production backend files (excluding seed data)..."
$backendStage = Join-Path $appStage "backend"
New-Item -ItemType Directory -Path $backendStage -Force | Out-Null
Copy-Item "backend\server.js" $backendStage
Copy-Item "backend\package.json" $backendStage

Write-Host "Copying configuration files..."
$rootFiles = @(
    ".env.example",
    "index.html",
    "package-lock.json",
    "package.json",
    "pnpm-workspace.yaml",
    "postcss.config.js",
    "README.md",
    "start.sh",
    "tailwind.config.js",
    "vite.config.js"
)
foreach ($f in $rootFiles) {
    if (Test-Path $f) {
        Copy-Item $f $appStage
    }
}

$zipPath1 = Join-Path (Get-Location) "runbook-portal-production.zip"
$zipPath2 = Join-Path (Get-Location) "floder_name.zip"
$zipPath3 = Join-Path (Get-Location) "folder_name.zip"

if (Test-Path $zipPath1) { Remove-Item -Force $zipPath1 }
if (Test-Path $zipPath2) { Remove-Item -Force $zipPath2 }
if (Test-Path $zipPath3) { Remove-Item -Force $zipPath3 }

Write-Host "Compressing files into ZIP archives..."
Compress-Archive -Path "$appStage\*" -DestinationPath $zipPath1
Copy-Item $zipPath1 $zipPath2
Copy-Item $zipPath1 $zipPath3

Remove-Item -Recurse -Force $stageDir
Write-Host "✅ ZIP package successfully created!"
