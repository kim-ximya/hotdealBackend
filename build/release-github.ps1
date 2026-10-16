param([ValidateSet('Inspect', 'MakePublic', 'Stage', 'Publish', 'Verify')][string]$Phase = 'Inspect')
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
$repository = 'kim-ximya/hotdealBackend'
$tag = "v$version"
$commit = (git -C $projectRoot rev-parse HEAD).Trim()
$api = "https://api.github.com/repos/$repository"
# Authentication stays in memory and is never included in app files or output.
$credentialLines = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
if ($LASTEXITCODE -ne 0) { throw '저장된 GitHub 인증정보를 사용할 수 없습니다.' }
$credential = @{}
foreach ($line in $credentialLines) {
  if ($line -match '^([^=]+)=(.*)$') { $credential[$Matches[1]] = $Matches[2] }
}
if (-not $credential.password) { throw 'GitHub 인증정보가 없습니다.' }
$headers = @{ Authorization = "Bearer $($credential.password)"; Accept = 'application/vnd.github+json';
  'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'HotdealCollector-release' }
function Request([string]$Method, [string]$Uri, $Payload) {
  $parameters = @{ Method = $Method; Uri = $Uri; Headers = $headers; TimeoutSec = 30 }
  if ($null -ne $Payload) {
    $parameters.ContentType = 'application/json; charset=utf-8'
    $parameters.Body = [System.Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 10 -Compress))
  }
  Invoke-RestMethod @parameters
}
function FindRelease {
  @(Request 'Get' "$api/releases?per_page=100" $null) | Where-Object { $_.tag_name -eq $tag }
}
try {
  $repo = Request 'Get' $api $null
  if ($repo.full_name -ne $repository -or -not $repo.permissions.push) { throw '대상 저장소 쓰기 권한이 없습니다.' }
  if ($Phase -eq 'MakePublic') {
    if (-not $repo.permissions.admin) { throw '저장소 공개 전환 관리자 권한이 없습니다.' }
    if ($repo.private) { $repo = Request 'Patch' $api @{ visibility = 'public' } }
    if ($repo.private -or $repo.visibility -ne 'public') { throw '저장소 공개 전환을 확인하지 못했습니다.' }
    [pscustomobject]@{ repository = $repo.full_name; visibility = $repo.visibility; url = $repo.html_url } | ConvertTo-Json
    exit
  }
  if (git -C $projectRoot status --porcelain --untracked-files=normal) { throw '소스 변경을 먼저 커밋하세요.' }
  $remote = Request 'Get' "$api/commits/$commit" $null
  if ($remote.sha -ne $commit) { throw '릴리즈 소스 커밋을 먼저 푸시하세요.' }
  $assets = @(
    @{ Name = "HotdealCollector-Setup-$version-x64.exe"; File = Join-Path $projectRoot "release/HotdealCollector-Setup-$version-x64.exe"; Type = 'application/octet-stream' },
    @{ Name = "HotdealCollector-Setup-$version-x64.exe.blockmap"; File = Join-Path $projectRoot "release/HotdealCollector-Setup-$version-x64.exe.blockmap"; Type = 'application/octet-stream' },
    @{ Name = 'latest.yml'; File = Join-Path $projectRoot 'release/latest.yml'; Type = 'text/yaml' },
    @{ Name = 'SHA256SUMS.txt'; File = Join-Path $projectRoot 'release/SHA256SUMS.txt'; Type = 'text/plain' },
    @{ Name = 'HotdealCollector-User-Guide-ko.md'; File = Join-Path $projectRoot 'docs/release-1.1.md'; Type = 'text/markdown' }
  )
  node (Join-Path $projectRoot 'build/checksums.cjs')
  if ($LASTEXITCODE -ne 0) { throw '릴리즈 파일 검증에 실패했습니다.' }
  $release = FindRelease | Select-Object -First 1
  if ($Phase -eq 'Inspect') {
    [pscustomobject]@{ repository = $repo.full_name; private = $repo.private; version = $version; commit = $commit;
      existingRelease = $release.html_url; draft = $release.draft; assets = $assets.Name } | ConvertTo-Json -Depth 5
    exit
  }
  if ($repo.private) { throw '토큰 없는 자동 업데이트를 위해 저장소를 먼저 공개해야 합니다.' }
  if ($Phase -eq 'Stage') {
    if (-not $release) {
      $release = Request 'Post' "$api/releases" @{ tag_name = $tag; target_commitish = $commit;
        name = "핫딜 수집 관리자 $version"; body = Get-Content -LiteralPath (Join-Path $projectRoot 'docs/release-notes-1.1.md') -Raw;
        draft = $true; prerelease = $false }
    }
    if (-not $release.draft -or $release.target_commitish -ne $commit) { throw '다른 소스 또는 이미 게시된 릴리즈는 변경하지 않습니다.' }
    $uploadBase = $release.upload_url.Split('{')[0]
    if (-not $uploadBase.StartsWith("https://uploads.github.com/repos/$repository/releases/")) { throw '업로드 주소가 다릅니다.' }
    foreach ($asset in $assets) {
      if ($release.assets | Where-Object { $_.name -eq $asset.Name }) { continue }
      Write-Output "업로드 시작: $($asset.Name)"
      $uploaded = Invoke-RestMethod -Method Post -Uri "$($uploadBase)?name=$([Uri]::EscapeDataString($asset.Name))" `
        -Headers $headers -InFile $asset.File -ContentType $asset.Type -TimeoutSec 300
      if ($uploaded.state -ne 'uploaded' -or $uploaded.size -ne (Get-Item -LiteralPath $asset.File).Length) { throw "업로드 확인 실패: $($asset.Name)" }
      Write-Output "업로드 완료: $($uploaded.name) ($($uploaded.size) bytes)"
    }
    $release = Request 'Get' "$api/releases/$($release.id)" $null
  }
  if (-not $release) { throw '릴리즈가 없습니다.' }
  if ($release.target_commitish -ne $commit) { throw '릴리즈 소스 커밋이 다릅니다.' }
  foreach ($asset in $assets) {
    $remoteAsset = @($release.assets | Where-Object { $_.name -eq $asset.Name -and $_.state -eq 'uploaded' })
    if ($remoteAsset.Count -ne 1 -or $remoteAsset[0].size -ne (Get-Item -LiteralPath $asset.File).Length) { throw "첨부 파일 확인 실패: $($asset.Name)" }
    $digest = 'sha256:' + (Get-FileHash -LiteralPath $asset.File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($remoteAsset[0].digest -ne $digest) { throw "GitHub 체크섬 확인 실패: $($asset.Name)" }
  }
  if ($Phase -eq 'Publish') {
    if (-not $release.draft) { throw '이미 게시된 릴리즈입니다.' }
    $release = Request 'Patch' "$api/releases/$($release.id)" @{ draft = $false; make_latest = 'true' }
  }
  [pscustomobject]@{ url = $release.html_url; tag = $release.tag_name; draft = $release.draft; publishedAt = $release.published_at;
    assets = @($release.assets | Select-Object name, size, digest, browser_download_url) } | ConvertTo-Json -Depth 5
} catch {
  Write-Error "릴리즈 작업 실패: $($_.Exception.Message)"
  exit 1
} finally {
  $headers.Clear(); $credential.Clear(); $credentialLines = $null
}
