// The Windows owner runs outside the Job. It admits a suspended process into
// the Job atomically and records an empty membership before dropping its handle.
export const windowsJobSource = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PaseoJobOwner {
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public short Show, ReservedCount;
    public IntPtr Reserved2, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Pid, Tid; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, int size, IntPtr written);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref ExtendedStartup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int which, IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success, string step) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), step);
  }

  public static void Run(string executable, string argv, string jobName, string receipt, string generation) {
    IntPtr job = CreateJobObject(IntPtr.Zero, jobName);
    int jobError = Marshal.GetLastWin32Error();
    Check(job != IntPtr.Zero, "create execution job");
    ProcessInfo worker = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero;
    IntPtr jobList = IntPtr.Zero;
    IntPtr inherited = IntPtr.Zero;
    bool initialized = false;
    try {
      if (jobError == 183) throw new InvalidOperationException("Execution job name is already in use.");
      ExtendedLimits limits = new ExtendedLimits { Basic = new Limits { Flags = 0x2000 } };
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "set execution job limits");
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) throw new InvalidOperationException("Cannot size launch attributes.");
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "initialize launch attributes");
      initialized = true;
      // PROC_THREAD_ATTRIBUTE_JOB_LIST places the worker in the Job on creation.
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "enroll launch in execution job");
      Startup io = new Startup {
        Size = Marshal.SizeOf(typeof(ExtendedStartup)), Flags = 0x100,
        Input = GetStdHandle(-10), Output = GetStdHandle(-11), Error = GetStdHandle(-12),
      };
      IntPtr[] handles = new IntPtr[] { io.Input, io.Output, io.Error };
      inherited = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
      for (int i = 0; i < handles.Length; i++) {
        Check(SetHandleInformation(handles[i], 1, 1), "enable private pipe inheritance");
        Marshal.WriteIntPtr(inherited, IntPtr.Size * i, handles[i]);
      }
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST restricts inheritance to these three pipes.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), inherited, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero), "limit worker handle inheritance");
      ExtendedStartup startup = new ExtendedStartup { Attributes = attributes, Startup = io };
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW
      Check(CreateProcess(executable, new StringBuilder(argv), IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out worker), "create enrolled worker");
      // The Job owner must not mask EOF when the SDK worker alone dies.
      Check(SetStdHandle(-10, IntPtr.Zero), "release owner stdin");
      Check(SetStdHandle(-11, IntPtr.Zero), "release owner stdout");
      Check(CloseHandle(io.Input), "close keeper stdin copy");
      Check(CloseHandle(io.Output), "close keeper stdout copy");
      Check(ResumeThread(worker.Thread) != UInt32.MaxValue, "resume enclosed worker");
      for (;;) {
        Accounting value;
        Check(QueryInformationJobObject(job, 1, out value, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "query execution job membership");
        if (value.ActiveProcesses == 0) break;
        string stop = receipt + ".stop";
        if (File.Exists(stop) && File.ReadAllText(stop) == generation) {
          Check(TerminateJobObject(job, 1), "terminate the owned execution job");
          File.Delete(stop);
        }
        Thread.Sleep(45);
      }
      byte[] data = Encoding.ASCII.GetBytes(generation);
      string temporary = receipt + ".pending";
      using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
        file.Write(data, 0, data.Length);
        file.Flush(true);
      }
      File.Move(temporary, receipt);
    } finally {
      if (worker.Thread != IntPtr.Zero) CloseHandle(worker.Thread);
      if (worker.Process != IntPtr.Zero) CloseHandle(worker.Process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited);
      CloseHandle(job);
    }
  }
}`;
