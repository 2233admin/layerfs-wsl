<#
Installs omp-layerfs on Windows:
  1. an Arch Linux WSL distro (created when missing; systemd on),
  2. inside it, install/distro-setup.sh: Docker, LayerFS, images, the bridge and the page,
  3. this checkout as a user-scoped OMP plugin (omp plugin link).
Run again to resume or repair; finished steps are skipped.

  powershell -ExecutionPolicy Bypass -File install\install.ps1 [-Distro layerfs-lab] [-Location D:\wsl\layerfs-lab] [-FromSource] [-NoPlugin]

-Distro other than layerfs-lab: /layerfs init takes it as its last argument and writes it
into the folder's .omp/layerfs.json, which every later call follows.
-FromSource builds the LayerFS core bundle (a release cargo build, tens of minutes)
instead of downloading this repository's release asset.
-SharedNetworkOk: start this distro's dockerd although docker0 exists, after stopping the
dockerd of the other WSL distro that made it (all WSL 2 distros share one network).
#>
param(
	[string]$Distro = "layerfs-lab",
	[string]$Location,
	[switch]$FromSource,
	[switch]$NoPlugin,
	[switch]$SharedNetworkOk
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$env:WSL_UTF8 = "1"   # wsl.exe prints UTF-8 instead of UTF-16

function Invoke-Wsl {
	& wsl.exe @args
	if ($LASTEXITCODE -ne 0) { throw "wsl.exe $($args -join ' ') exited $LASTEXITCODE" }
}

$have = @(wsl.exe --list --quiet) | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($have -notcontains $Distro) {
	if (-not $Location) { $Location = Join-Path $env:USERPROFILE "wsl\$Distro" }
	Write-Host "== creating WSL distro $Distro (Arch Linux) at $Location"
	Invoke-Wsl --install archlinux --name $Distro --location $Location --no-launch --web-download
}

$pid1 = (wsl.exe -d $Distro -u root --exec cat /proc/1/comm | Out-String).Trim()
if ($pid1 -ne "systemd") {
	Write-Host "== turning systemd on in $Distro"
	Invoke-Wsl -d $Distro -u root --exec sh -c "grep -qx 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf"
	Invoke-Wsl --terminate $Distro
}

$linuxRepo = (wsl.exe -d $Distro -u root --exec wslpath -a $repo | Out-String).Trim()
$setup = @("-d", $Distro, "-u", "root", "--exec", "bash", "$linuxRepo/install/distro-setup.sh")
if ($FromSource) { $setup += "--from-source" }
if ($SharedNetworkOk) { $setup += "--shared-network-ok" }
Invoke-Wsl @setup

if (-not $NoPlugin) {
	Write-Host "== linking $repo as the OMP plugin omp-layerfs"
	& omp plugin link $repo
	if ($LASTEXITCODE -ne 0) { throw "omp plugin link exited $LASTEXITCODE" }
}
$distroArg = if ($Distro -ne "layerfs-lab") { " $Distro" } else { "" }
Write-Host "done. In OMP, bind a folder to a new project with:"
Write-Host "  /layerfs init hello omp-lfs-rust-sandbox:2 /root/omp-layerfs/fixtures/hello$distroArg"
