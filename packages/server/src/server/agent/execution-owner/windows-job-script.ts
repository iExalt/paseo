// The Windows keeper owns the Job, the original SDK process handle, and the
// daemon pipes. The SDK receives a separate, PID-verified local pipe.
export const windowsJobSource = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
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
  [StructLayout(LayoutKind.Sequential)] struct PipeSecurityAttributes {
    public int Size;
    public IntPtr Descriptor;
    public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outputSize, uint inputSize, uint defaultTimeout, ref PipeSecurityAttributes security);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success, string step) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), step);
  }

  static IntPtr OpenObservedProcess(uint pid) {
    // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    IntPtr process = OpenProcess(0x00101000, false, pid);
    Check(process != IntPtr.Zero, "open daemon handle");
    return process;
  }

  static long ProcessBirth(IntPtr process) {
    long creation, exit, kernel, user;
    Check(GetProcessTimes(process, out creation, out exit, out kernel, out user), "read daemon identity");
    return creation;
  }

  public static int Main(string[] args) {
    IntPtr daemon = IntPtr.Zero;
    try {
      if (args.Length == 2 && args[0] == "--process-birth") {
        daemon = OpenObservedProcess(UInt32.Parse(args[1]));
        Console.WriteLine(ProcessBirth(daemon));
        return 0;
      }
      if (args.Length != 8) return 2;
      daemon = OpenObservedProcess(UInt32.Parse(args[6]));
      if (ProcessBirth(daemon) != Int64.Parse(args[7]) || WaitForSingleObject(daemon, 0) != 258) {
        throw new InvalidOperationException("Daemon identity changed before worker launch.");
      }
      Run(args[0], args[1], args[2], args[3], args[4], args[5], daemon);
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
      return 1;
    } finally {
      if (daemon != IntPtr.Zero) CloseHandle(daemon);
    }
  }

  sealed class WorkerChannel : IDisposable {
    readonly NamedPipeServerStream pipe;
    readonly IntPtr outputHandle = GetStdHandle(-11);
    readonly Stream daemonInput = Console.OpenStandardInput();
    readonly Stream daemonOutput = Console.OpenStandardOutput();
    int closed, daemonEnded;
    public bool DaemonEnded { get { return Interlocked.CompareExchange(ref daemonEnded, 0, 0) != 0; } }

    public WorkerChannel(string name) {
      PipeSecurity access = new PipeSecurity();
      access.SetAccessRuleProtection(true, false);
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
        access.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
      }
      GCHandle descriptor = GCHandle.Alloc(access.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
      try {
        PipeSecurityAttributes security = new PipeSecurityAttributes {
          Size = Marshal.SizeOf(typeof(PipeSecurityAttributes)), Descriptor = descriptor.AddrOfPinnedObject(),
        };
        // OVERLAPPED | FIRST_PIPE_INSTANCE | DUPLEX; reject remote peers.
        SafePipeHandle handle = CreateNamedPipe(name, 0x40080003, 8, 1, 65536, 65536, 0, ref security);
        if (handle.IsInvalid) {
          int failure = Marshal.GetLastWin32Error();
          handle.Dispose();
          throw new Win32Exception(failure, "create worker pipe");
        }
        try { pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
        catch { handle.Dispose(); throw; }
      } finally { descriptor.Free(); }
    }

    static void StartThread(Action work) {
      Thread thread = new Thread(() => work());
      thread.IsBackground = true;
      thread.Start();
    }

    public void Start(ProcessInfo worker) {
      StartThread(() => {
        try {
          for (;;) {
            pipe.WaitForConnection();
            uint peer;
            if (GetNamedPipeClientProcessId(pipe.SafePipeHandle, out peer) &&
                peer == worker.Pid && WaitForSingleObject(worker.Process, 0) == 258) break;
            pipe.Disconnect();
          }
          StartThread(() => {
            try { daemonInput.CopyTo(pipe); }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally {
              Interlocked.Exchange(ref daemonEnded, 1);
              Dispose();
            }
          });
          byte[] bytes = new byte[65536];
          while (Interlocked.CompareExchange(ref closed, 0, 0) == 0) {
            int length = pipe.Read(bytes, 0, bytes.Length);
            if (length == 0 || Interlocked.CompareExchange(ref closed, 0, 0) != 0 ||
                WaitForSingleObject(worker.Process, 0) != 258) break;
            daemonOutput.Write(bytes, 0, length);
          }
        } catch (IOException) { }
          catch (InvalidOperationException) { }
          finally { Dispose(); }
      });
    }

    public void Dispose() {
      if (Interlocked.Exchange(ref closed, 1) != 0) return;
      StartThread(() => {
        try { pipe.Dispose(); }
        finally { CloseHandle(outputHandle); }
      });
    }
  }

  static void Run(string executable, string argv, string jobName, string receipt, string generation, string pipeName, IntPtr daemon) {
    IntPtr job = CreateJobObject(IntPtr.Zero, jobName);
    int jobError = Marshal.GetLastWin32Error();
    Check(job != IntPtr.Zero, "create execution job");
    ProcessInfo worker = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero;
    IntPtr jobList = IntPtr.Zero;
    WorkerChannel channel = null;
    bool initialized = false;
    try {
      if (jobError == 183) throw new InvalidOperationException("Execution job name is already in use.");
      ExtendedLimits limits = new ExtendedLimits { Basic = new Limits { Flags = 0x2000 } };
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))), "set execution job limits");
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new InvalidOperationException("Cannot size launch attributes.");
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "initialize launch attributes");
      initialized = true;
      // PROC_THREAD_ATTRIBUTE_JOB_LIST places the worker in the Job on creation.
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "enroll launch in execution job");
      channel = new WorkerChannel(pipeName);
      Startup io = new Startup { Size = Marshal.SizeOf(typeof(ExtendedStartup)) };
      ExtendedStartup startup = new ExtendedStartup { Attributes = attributes, Startup = io };
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW
      // The worker cannot inherit any keeper handle. Its Job is applied before it can run.
      Check(CreateProcess(executable, new StringBuilder(argv), IntPtr.Zero, IntPtr.Zero, false, 0x08080004, IntPtr.Zero, null, ref startup, out worker), "create enrolled worker");
      channel.Start(worker);
      Check(ResumeThread(worker.Thread) != UInt32.MaxValue, "resume enclosed worker");
      bool writerExited = false;
      for (;;) {
        uint writerState = WaitForSingleObject(worker.Process, 0);
        if (!writerExited && writerState == 0) {
          channel.Dispose();
          try {
            File.WriteAllText(receipt + ".writer-exited", generation, Encoding.ASCII);
            writerExited = true;
          } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        } else if (writerState == 258 && (WaitForSingleObject(daemon, 0) == 0 || channel.DaemonEnded)) {
          TerminateProcess(worker.Process, 1);
        }
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
      if (channel != null) channel.Dispose();
      if (worker.Thread != IntPtr.Zero) CloseHandle(worker.Thread);
      if (worker.Process != IntPtr.Zero) CloseHandle(worker.Process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      CloseHandle(job);
    }
  }
}`;
