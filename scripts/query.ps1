# Read the local print stack without WMI (works even when WMI/RPC is restricted).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PwSpool {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct PRINTER_INFO_2 {
    public string pServerName; public string pPrinterName; public string pShareName;
    public string pPortName; public string pDriverName; public string pComment;
    public string pLocation; public IntPtr pDevMode; public string pSepFile;
    public string pPrintProcessor; public string pDatatype; public string pParameters;
    public IntPtr pSecurityDescriptor; public int Attributes;
    public int Priority; public int DefaultPriority; public int StartTime; public int UntilTime;
    public int Status; public int cJobs; public int AveragePPM;
  }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool EnumPrinters(int Flags, string Name, int Level, IntPtr pPrinterEnum, int cbBuf, out int pcbNeeded, out int pcReturned);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool GetDefaultPrinter(StringBuilder pszBuffer, ref int pcchBuffer);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SetDefaultPrinter(string pszPrinter);
}
'@

function Get-Printers {
  $needed = 0; $returned = 0
  [PwSpool]::EnumPrinters(2, $null, 2, [IntPtr]::Zero, 0, [ref]$needed, [ref]$returned) | Out-Null
  if ($needed -le 0) { return @() }
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($needed)
  try {
    $ok = [PwSpool]::EnumPrinters(2, $null, 2, $buf, $needed, [ref]$needed, [ref]$returned)
    if (-not $ok) { return @() }
    $size = [Runtime.InteropServices.Marshal]::SizeOf([type]'PwSpool+PRINTER_INFO_2')
    $list = @()
    for ($i = 0; $i -lt $returned; $i++) {
      $p = [IntPtr]::Add($buf, $i * $size)
      $info = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type]'PwSpool+PRINTER_INFO_2')
      $list += [pscustomobject]@{
        name   = $info.pPrinterName
        port   = $info.pPortName
        driver = $info.pDriverName
        share  = $info.pShareName
        server = $info.pServerName
      }
    }
    return $list
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}

$printers = @(Get-Printers)
$default = ''
$len = 1024
$sb = New-Object System.Text.StringBuilder $len
if ([PwSpool]::GetDefaultPrinter($sb, [ref]$len)) { $default = $sb.ToString() }

$ports = @()
$portKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\Standard TCP/IP Port\Ports'
if (Test-Path $portKey) {
  foreach ($child in Get-ChildItem $portKey) {
    $v = Get-ItemProperty $child.PSPath
    $ports += [pscustomobject]@{
      name     = $child.PSChildName
      host     = [string]$v.HostName
      number   = [int]$v.PortNumber
      protocol = [int]$v.Protocol
    }
  }
}

$legacy = 0
$winKey = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows'
$wp = Get-ItemProperty $winKey -ErrorAction SilentlyContinue
if ($wp -and $null -ne $wp.LegacyDefaultPrinterMode) { $legacy = [int]$wp.LegacyDefaultPrinterMode }

$spooler = (Get-Service Spooler -ErrorAction SilentlyContinue).Status
if ($null -eq $spooler) { $spooler = 'Unknown' }

$payload = [pscustomobject]@{
  printers            = $printers
  defaultPrinter      = $default
  ports               = $ports
  legacyDefaultMode   = $legacy
  spooler             = [string]$spooler
  user                = [string][Security.Principal.WindowsIdentity]::GetCurrent().Name
  at                  = (Get-Date).ToString('o')
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
