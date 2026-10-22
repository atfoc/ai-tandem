# Installs the desktop app that scripts/build-app.sh made for Windows: copies
# bin\windows-<arch>\AI Whiteboard (the unpacked folder, AI Whiteboard.exe inside) into
# %LOCALAPPDATA%\Programs\AI Whiteboard, which needs no administrator, and makes the Start Menu
# shortcut %APPDATA%\Microsoft\Windows\Start Menu\Programs\AI Whiteboard.lnk. Without that build it
# says which one to make and installs nothing, leaving a previous install as it is.
# Windows PowerShell 5.1 and PowerShell 7. Started by scripts/install-app.sh in Git Bash, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-app.ps1
$ErrorActionPreference = 'Stop'

function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot

# The operating system's processor, not PROCESSOR_ARCHITECTURE, which says x86 or AMD64 to an
# emulated process.
$osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($osArch) {
  'X64'   { $arch = 'x64'; $otherArch = 'arm64' }
  'Arm64' { $arch = 'arm64'; $otherArch = 'x64' }
  default { Fail "Cannot install: this computer's processor ($osArch) is not one the app is built for." }
}

$src = Join-Path $root "bin\windows-$arch\AI Whiteboard"
if (-not (Test-Path -LiteralPath (Join-Path $src 'AI Whiteboard.exe') -PathType Leaf)) {
  [Console]::Error.WriteLine("Nothing installed: the Windows $arch build is missing (this computer's processor is $arch).")
  [Console]::Error.WriteLine("Make it with: scripts/build-app.sh --os windows --arch $arch (on a Linux computer or a Mac)")
  $otherSrc = Join-Path $root "bin\windows-$otherArch\AI Whiteboard"
  if (Test-Path -LiteralPath (Join-Path $otherSrc 'AI Whiteboard.exe') -PathType Leaf) {
    [Console]::Error.WriteLine("Found, but not for this processor: bin\windows-$otherArch\AI Whiteboard")
  }
  exit 1
}

if (-not $env:LOCALAPPDATA) { Fail 'Cannot install: LOCALAPPDATA is not set.' }
$programs = Join-Path $env:LOCALAPPDATA 'Programs'
$dest = Join-Path $programs 'AI Whiteboard'
$new = Join-Path $programs 'AI Whiteboard.new'
$old = Join-Path $programs 'AI Whiteboard.old'
$serverJson = Join-Path $env:USERPROFILE '.ai-whiteboard\server.json'

New-Item -ItemType Directory -Force -Path $programs | Out-Null

# A folder left by an earlier run must be gone before the swap: Move-Item into a name that is a
# folder moves the install inside it, as a subfolder. One that cannot be removed ends the run here,
# before anything is copied or moved.
foreach ($leftover in @($new, $old)) {
  if (Test-Path -LiteralPath $leftover) {
    Remove-Item -LiteralPath $leftover -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $leftover) {
      Fail "Nothing installed: $leftover, left by an earlier install, cannot be removed (a file in it may be in use). Quit AI Whiteboard, delete the folder, and run this again."
    }
  }
}

# Copy next to the old install first: a copy that fails leaves the old install as it was.
try {
  New-Item -ItemType Directory -Path $new | Out-Null
  Get-ChildItem -LiteralPath $src -Force | Copy-Item -Destination $new -Recurse -Force
} catch {
  Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
  Fail "Nothing installed: copying the build failed ($($_.Exception.Message)). A previous install is untouched."
}

# Put the old install aside by renaming its folder, which fails as a whole while any of its files
# is in use, instead of deleting it file by file and leaving half of it.
$hadOld = Test-Path -LiteralPath $dest
if ($hadOld) {
  try {
    Move-Item -LiteralPath $dest -Destination $old
  } catch {
    Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
    $stop = '"' + (Join-Path $dest 'ai-whiteboard.exe') + '" stop'
    $message = "Nothing installed: the previous install in $dest is in use."
    if (Test-Path -LiteralPath $serverJson) {
      $message += " A server that AI Whiteboard started is probably still running from it ($serverJson exists)."
    }
    $message += "`n" + "Quit AI Whiteboard's window (also from the tray or Task Manager), and stop the server it started with:" + "`n"
    $message += "  $stop" + "`n"
    $message += "(this ends running agent chats), then run this again."
    Fail $message
  }
}
try {
  Move-Item -LiteralPath $new -Destination $dest
} catch {
  $reason = $_.Exception.Message
  Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
  $state = 'Nothing is installed.'
  if ($hadOld) {
    if (Test-Path -LiteralPath $dest) {
      $state = "Something else is in $dest, so the previous install was not put back: it is in $old."
    } else {
      try { Move-Item -LiteralPath $old -Destination $dest } catch { }
      if (Test-Path -LiteralPath $dest) {
        $state = 'The previous install is back.'
      } else {
        $state = "The previous install could not be put back: it is in $old."
      }
    }
  }
  Fail "Nothing installed: could not put the new build in place ($reason). $state"
}
$oldLeft = ''
if ($hadOld) {
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $old) { $oldLeft = $old }
}

# The Start Menu shortcut.
$exe = Join-Path $dest 'AI Whiteboard.exe'
$lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AI Whiteboard.lnk'
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $lnkPath) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = "$exe,0"
  $lnk.Save()
} catch {
  Fail "AI Whiteboard is in $dest, but the Start Menu shortcut could not be made ($($_.Exception.Message))."
}
Write-Host "Installed $dest"
if ($oldLeft) { Write-Host "The previous install could not be deleted and is left in $oldLeft; the next install removes it." }

# A server started by an older build keeps running it until it stops: opening the app never
# restarts it, since that would end the running agent chats. server.json exists only while a
# server runs.
if (Test-Path -LiteralPath $serverJson) {
  Write-Host 'A server is running from the previous build. AI Whiteboard will offer to restart it on'
  Write-Host 'this one (Restart server, in the section This computer of the sidebar), or restart it now with:'
  Write-Host ('  "' + (Join-Path $dest 'ai-whiteboard.exe') + '" relaunch')
}
