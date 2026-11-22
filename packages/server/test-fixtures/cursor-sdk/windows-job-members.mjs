import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PaseoProofJob {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, int size, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static long[] Members(string name) {
    IntPtr job = OpenJobObject(4, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int size = 8 + IntPtr.Size * 256;
    IntPtr data = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, data, size, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      int count = Marshal.ReadInt32(data, 4);
      long[] members = new long[count];
      for (int i = 0; i < count; i++) members[i] = Marshal.ReadIntPtr(data, 8 + IntPtr.Size*i).ToInt64();
      return members;
    } finally {
      Marshal.FreeHGlobal(data);
      CloseHandle(job);
    }
  }
}`;

export async function windowsJobMembers(generation) {
  if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error("Invalid fixture Job identity");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${source}
'@
ConvertTo-Json -Compress -InputObject @([PaseoProofJob]::Members('Local\\PaseoOwner-${generation}'))
`;
  const executable = join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await exec(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 4_000, windowsHide: true },
  );
  return JSON.parse(stdout.trim());
}
