using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// The anonymous, noninheritable handle stays exclusively in this monitor.
public static class PaseoOwnedJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct AccountingAndIo { public Accounting Basic; public IoCounters Io; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes
    {
        public uint Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedLength;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out AccountingAndIo data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryLimits(IntPtr job, int kind, out ExtendedLimits data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string file, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryProcessList(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);

    public sealed class MemberDiagnostic
    {
        public uint pid;
        public string image, startedUtc, error;
        public bool membershipVerified;
    }

    public sealed class Receipt
    {
        public bool complete, timedOut, terminated, cancelled;
        public uint primaryPid, exitCode = 259, activeProcesses, totalProcesses;
        public long elapsedMs, cpuMilliseconds;
        public ulong readBytes, writeBytes, peakJobMemoryBytes;
        public string error;
        public long primaryExitObservedMs = -1;
        public MemberDiagnostic[] remainingProcesses = Array.Empty<MemberDiagnostic>();
        public string processDiagnosticError;
        public bool buildSucceededWithTelemetryCleanup;
        public string allowedBuildTelemetry;
        public uint telemetryTotalBefore, telemetryTotalVerified, telemetryActiveBefore, telemetryActiveVerified;
    }

    static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static bool Valid(IntPtr handle) { return handle != IntPtr.Zero && handle != new IntPtr(-1); }

    // Windows CRT quoting, including empty arguments, embedded quotes and trailing slashes.
    public static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static AccountingAndIo Inspect(IntPtr job)
    {
        AccountingAndIo data;
        Check(QueryInformationJobObject(job, 8, out data, (uint)Marshal.SizeOf<AccountingAndIo>(), IntPtr.Zero), "Query job accounting");
        return data;
    }

    // Read-only diagnostics. Ownership and termination always use the Job handle,
    // never these recyclable PIDs. Bound allocation even for a broken install.
    static void DiagnoseMembers(IntPtr job, Receipt receipt, List<Process> held)
    {
        const int capacity = 256;
        int bytes = 8 + capacity * IntPtr.Size;
        IntPtr buffer = Marshal.AllocHGlobal(bytes);
        try
        {
            Check(QueryProcessList(job, 3, buffer, (uint)bytes, IntPtr.Zero), "Query bounded Job members");
            int count = Marshal.ReadInt32(buffer, 4);
            if (count < 0 || count > capacity || Marshal.ReadInt32(buffer) != count)
                throw new InvalidOperationException("Incomplete Job member list");
            receipt.remainingProcesses = new MemberDiagnostic[count];
            for (int i = 0; i < count; i++)
            {
                uint pid = checked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                var item = new MemberDiagnostic { pid = pid };
                receipt.remainingProcesses[i] = item;
                try
                {
                    var member = Process.GetProcessById(checked((int)pid));
                    held.Add(member);
                    IntPtr handle = member.Handle;
                    bool belongs;
                    Check(IsProcessInJob(handle, job, out belongs), "Verify diagnostic process membership");
                    if (!belongs) throw new InvalidOperationException("Process no longer belongs to Job");
                    item.membershipVerified = true;
                    item.startedUtc = member.StartTime.ToUniversalTime().ToString("O");
                    item.image = member.MainModule.FileName;
                    if (WaitForSingleObject(handle, 0) != 258) throw new InvalidOperationException("Member exited during verification");
                }
                catch (Exception error) { item.error = error.Message; }
            }
        }
        catch (Exception error) { receipt.processDiagnosticError = error.Message; }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // Pure classification; final accounting catches births racing with termination.
    public static bool IsBuildTelemetryCleanup(Receipt receipt)
    {
        if (!receipt.complete || !receipt.terminated || receipt.timedOut || receipt.cancelled || receipt.exitCode != 0 ||
            receipt.error != null || receipt.processDiagnosticError != null ||
            String.IsNullOrEmpty(receipt.allowedBuildTelemetry) || receipt.activeProcesses != 0 ||
            receipt.telemetryActiveBefore == 0 || receipt.telemetryActiveBefore != receipt.telemetryActiveVerified ||
            receipt.remainingProcesses.Length != receipt.telemetryActiveBefore ||
            receipt.telemetryTotalBefore != receipt.telemetryTotalVerified || receipt.totalProcesses != receipt.telemetryTotalBefore)
            return false;
        var seen = new HashSet<uint>();
        foreach (var member in receipt.remainingProcesses)
            if (!seen.Add(member.pid) || !member.membershipVerified || member.error != null ||
                String.IsNullOrEmpty(member.startedUtc) ||
                !String.Equals(member.image, receipt.allowedBuildTelemetry, StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    public static Receipt Run(string executable, string[] arguments, string directory, string log, int timeoutSeconds, string nsisInstallDirectory)
    {
        return Run(executable, arguments, directory, log, timeoutSeconds, nsisInstallDirectory, null, null);
    }

    public static Receipt Run(string executable, string[] arguments, string directory, string log, int timeoutSeconds, string nsisInstallDirectory, string startReceipt, string startIdentity)
    {
        return Run(executable, arguments, directory, log, timeoutSeconds, nsisInstallDirectory, startReceipt, startIdentity, null);
    }

    public static Receipt Run(string executable, string[] arguments, string directory, string log, int timeoutSeconds, string nsisInstallDirectory, string startReceipt, string startIdentity, string allowedBuildTelemetry)
    {
        return Run(executable, arguments, directory, log, timeoutSeconds, nsisInstallDirectory, startReceipt, startIdentity, allowedBuildTelemetry, null);
    }

    public static Receipt Run(string executable, string[] arguments, string directory, string log, int timeoutSeconds, string nsisInstallDirectory, string startReceipt, string startIdentity, string allowedBuildTelemetry, string receiptFile)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8)
            throw new InvalidOperationException("A native 64-bit Windows monitor is required");
        if (!Path.IsPathRooted(executable) || !File.Exists(executable) || !Directory.Exists(directory))
            throw new InvalidOperationException("Exact executable and working directory required");
        if (timeoutSeconds < 1 || timeoutSeconds > 1800) throw new ArgumentOutOfRangeException("timeoutSeconds");
        if (String.IsNullOrEmpty(nsisInstallDirectory)) nsisInstallDirectory = null;
        if (nsisInstallDirectory != null && (!Path.IsPathRooted(nsisInstallDirectory) || nsisInstallDirectory.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0))
            throw new InvalidOperationException("NSIS installation directory must be an absolute unquoted path");
        if (!String.IsNullOrEmpty(allowedBuildTelemetry) &&
            (!Path.IsPathRooted(allowedBuildTelemetry) || !File.Exists(allowedBuildTelemetry) ||
             !String.Equals(Path.GetFileName(allowedBuildTelemetry), "VCTIP.EXE", StringComparison.OrdinalIgnoreCase) || nsisInstallDirectory != null))
            throw new InvalidOperationException("Exact build telemetry executable required");
        var receipt = new Receipt { allowedBuildTelemetry = allowedBuildTelemetry };
        if (receiptFile != null && (!Path.IsPathRooted(receiptFile) || File.Exists(receiptFile)))
            throw new InvalidOperationException("Fresh absolute receipt path required");
        var held = new List<Process>();
        var clock = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero, output = IntPtr.Zero, input = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool assigned = false;
        int cancelled = 0;
        ConsoleCancelEventHandler handler = (sender, args) => {
            Interlocked.Exchange(ref cancelled, 1);
            args.Cancel = true;
        };
        Console.CancelKeyPress += handler;
        try
        {
            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(Valid(job), "Create anonymous job");
            Check(SetHandleInformation(job, 1, 0), "Make job handle noninheritable");
            uint handleFlags;
            Check(GetHandleInformation(job, out handleFlags), "Read job handle flags");
            if ((handleFlags & 1) != 0) throw new InvalidOperationException("Job handle is inheritable");
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is enabled.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()), "Set kill-on-close");
            var security = new SecurityAttributes { Length = (uint)Marshal.SizeOf<SecurityAttributes>(), Inherit = true };
            output = CreateFileW(log, 0x40000000, 3, ref security, 1, 0x80, IntPtr.Zero);
            Check(Valid(output), "Create fresh child log");
            input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            Check(Valid(input), "Open null input");
            var startup = new StartupInfo { Size = (uint)Marshal.SizeOf<StartupInfo>(), Flags = 0x100, Input = input, Output = output, Error = output };
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            // NSIS parses the entire unquoted remainder after /D, including spaces.
            // https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
            if (nsisInstallDirectory != null) command.Append(" /D=").Append(nsisInstallDirectory);
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, directory, ref startup, out process), "Create suspended primary");
            receipt.primaryPid = process.ProcessId;
            Check(AssignProcessToJobObject(job, process.Process), "Assign suspended primary to job");
            assigned = true;
            if (!String.IsNullOrEmpty(startReceipt))
            {
                if (!Path.IsPathRooted(startReceipt) || String.IsNullOrEmpty(startIdentity))
                    throw new InvalidOperationException("Owned start receipt identity required");
                // Exclusive publication precedes execution; the child cannot mint
                // this receipt before its assignment. The Job handle stays private.
                using (var file = new FileStream(startReceipt, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
                    writer.Write("{\"primaryPid\":" + process.ProcessId + ",\"monitorPid\":" + Environment.ProcessId +
                        ",\"killOnClose\":true,\"breakaway\":false,\"identity\":" + startIdentity + "}");
            }
            Check(ResumeThread(process.Thread) != uint.MaxValue, "Resume assigned primary");
            CloseHandle(process.Thread); process.Thread = IntPtr.Zero;
            CloseHandle(output); output = IntPtr.Zero;
            CloseHandle(input); input = IntPtr.Zero;
            long nextSample = 60000;
            while (true)
            {
                if (Volatile.Read(ref cancelled) != 0) break;
                uint wait = WaitForSingleObject(process.Process, 100);
                if (wait == 0) break;
                Check(wait == 258, "Wait for primary");
                if (clock.Elapsed.TotalSeconds >= timeoutSeconds) { receipt.timedOut = true; break; }
                if (clock.ElapsedMilliseconds >= nextSample)
                {
                    var sample = Inspect(job);
                    ExtendedLimits memory;
                    Check(QueryLimits(job, 9, out memory, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero), "Read job memory");
                    Console.WriteLine("owned_job elapsed_ms={0} active={1} cpu_ms={2} read_bytes={3} write_bytes={4} peak_memory_bytes={5} disk_free_bytes={6}",
                        clock.ElapsedMilliseconds, sample.Basic.ActiveProcesses, (sample.Basic.UserTime + sample.Basic.KernelTime) / 10000,
                        sample.Io.ReadBytes, sample.Io.WriteBytes, memory.PeakJobMemory.ToUInt64(), new DriveInfo(Path.GetPathRoot(directory)).AvailableFreeSpace);
                    nextSample += 60000;
                }
            }
            Check(GetExitCodeProcess(process.Process, out receipt.exitCode), "Read primary exit");
            if (receipt.exitCode != 259) receipt.primaryExitObservedMs = clock.ElapsedMilliseconds;
            if (!receipt.timedOut && receipt.exitCode == 0 && Volatile.Read(ref cancelled) == 0)
            {
                long deadline = clock.ElapsedMilliseconds + 10000;
                while (Inspect(job).Basic.ActiveProcesses != 0 && clock.ElapsedMilliseconds < deadline && Volatile.Read(ref cancelled) == 0) Thread.Sleep(50);
            }
            receipt.cancelled = Volatile.Read(ref cancelled) != 0;
            if (receipt.cancelled || receipt.timedOut || receipt.exitCode != 0 || Inspect(job).Basic.ActiveProcesses != 0)
            {
                receipt.terminated = true;
                var before = Inspect(job).Basic;
                receipt.telemetryTotalBefore = before.TotalProcesses;
                receipt.telemetryActiveBefore = before.ActiveProcesses;
                DiagnoseMembers(job, receipt, held);
                var verified = Inspect(job).Basic;
                receipt.telemetryTotalVerified = verified.TotalProcesses;
                receipt.telemetryActiveVerified = verified.ActiveProcesses;
                Check(TerminateJobObject(job, 1), "Terminate owned job");
            }
        }
        catch (Exception error)
        {
            receipt.error = error.ToString();
            receipt.terminated = true;
            if (Valid(job) && assigned) TerminateJobObject(job, 1);
            // Assignment failure leaves an unexecuted suspended child; terminate that exact handle.
            if (Valid(process.Process) && !assigned) TerminateProcess(process.Process, 1);
        }
        finally
        {
            try
            {
                if (Valid(process.Process) && !assigned)
                    Check(WaitForSingleObject(process.Process, 5000) == 0, "Wait for unassigned suspended child cleanup");
                if (Valid(job))
                {
                    long deadline = clock.ElapsedMilliseconds + 5000;
                    while (Inspect(job).Basic.ActiveProcesses != 0 && clock.ElapsedMilliseconds < deadline) Thread.Sleep(50);
                    var final = Inspect(job);
                    receipt.activeProcesses = final.Basic.ActiveProcesses;
                    receipt.totalProcesses = final.Basic.TotalProcesses;
                    receipt.cpuMilliseconds = (final.Basic.UserTime + final.Basic.KernelTime) / 10000;
                    receipt.readBytes = final.Io.ReadBytes; receipt.writeBytes = final.Io.WriteBytes;
                    ExtendedLimits memory;
                    Check(QueryLimits(job, 9, out memory, (uint)Marshal.SizeOf<ExtendedLimits>(), IntPtr.Zero), "Read final job memory");
                    receipt.peakJobMemoryBytes = memory.PeakJobMemory.ToUInt64();
                    receipt.complete = receipt.activeProcesses == 0 && receipt.error == null;
                }
            }
            catch (Exception error) { receipt.error = (receipt.error ?? "") + error; receipt.complete = false; }
            foreach (IntPtr handle in new[] { process.Thread, process.Process, output, input, job })
                if (Valid(handle)) CloseHandle(handle);
            foreach (var member in held) member.Dispose();
            receipt.elapsedMs = clock.ElapsedMilliseconds;
            receipt.cancelled = Volatile.Read(ref cancelled) != 0;
            receipt.buildSucceededWithTelemetryCleanup = IsBuildTelemetryCleanup(receipt);
            try
            {
                if (receiptFile != null)
                {
                    // Persist before returning to PowerShell, whose pipeline may
                    // already be stopping after the console cancellation event.
                    string temporary = receiptFile + ".partial-" + Guid.NewGuid().ToString("N");
                    try
                    {
                        File.WriteAllText(temporary, System.Text.Json.JsonSerializer.Serialize(receipt,
                            new System.Text.Json.JsonSerializerOptions { IncludeFields = true }), new UTF8Encoding(false));
                        File.Move(temporary, receiptFile);
                    }
                    finally { if (File.Exists(temporary)) File.Delete(temporary); }
                }
            }
            finally { Console.CancelKeyPress -= handler; }
        }
        return receipt;
    }
}
