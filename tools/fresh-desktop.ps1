# Verity - open a fresh Windows virtual desktop.
#
# This sends the same chord Explorer itself listens for (Win+Ctrl+D), then reads
# the desktop list out of the registry and prints the count before and after - so
# you can see that it happened instead of trusting a keystroke.
#
# It runs in your own session and needs no administrator rights. It is fully
# reversible: Ctrl+Win+F4 removes the desktop you are on, and Ctrl+Win+Left/Right
# moves between the ones you have. Your windows are not touched.
#
# Pair it with a profile so the copy you run here keeps its own data:
#
#   npm run desktop:new
#   npm start -- --profile=fresh

[CmdletBinding()]
param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops'

# The desktop list is a sequence of 16-byte GUIDs; its length is the count. This
# is read rather than assumed, so the script reports the truth either way.
function Get-DesktopCount {
  try {
    $ids = (Get-ItemProperty -Path $key -Name VirtualDesktopIDs -ErrorAction Stop).VirtualDesktopIDs
    if (-not $ids) { return 0 }
    return [int]($ids.Length / 16)
  } catch {
    return 0
  }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class VerityKeys
{
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    // Press every key in order, then release them in reverse: Win, Ctrl, D.
    public static void Chord(byte[] keys)
    {
        foreach (byte key in keys) keybd_event(key, 0, 0, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 2, UIntPtr.Zero);
    }
}
'@

$before = Get-DesktopCount
[VerityKeys]::Chord(@(0x5B, 0x11, 0x44))   # LWin, Ctrl, D
Start-Sleep -Milliseconds 900
$after = Get-DesktopCount

if (-not $Quiet) {
  Write-Host "virtual desktops: $before -> $after"
}

if ($after -gt $before) {
  Write-Host 'A new desktop is now in front of you. Ctrl+Win+Left goes back.'
  exit 0
}

Write-Warning 'The desktop count did not change. Try the chord by hand: Ctrl+Win+D.'
exit 1
