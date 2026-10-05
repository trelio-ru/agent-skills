using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Collections.Generic;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

// Built with the OS .NET Framework compiler: no Visual Studio, admin rights,
// BitLocker edition, disk driver, or PowerShell credential serialization.
internal static class WhatsAppNative {
    const double MaximumLease = 1800000;
    static readonly SecurityIdentifier Owner = WindowsIdentity.GetCurrent().User;
    static string Stage = "entry";
    // QueryInterruptTime is exported by KernelBase on supported Windows builds;
    // Kernel32 does not consistently forward it (despite the Learn DLL table).
    // Cygwin's canonical autoload table also binds this API to KernelBase.
    [DllImport("KernelBase.dll", ExactSpelling=true)] static extern void QueryInterruptTime(out ulong time);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    sealed class NativeFailure : Exception { internal NativeFailure(string code) : base(code) {} }
    static void Check(bool value, string code = "native_operation_failed") { if (!value) throw new NativeFailure(code); }
    static void Report(Exception error) {
        // Stage names are source constants and HRESULT is numeric. Never emit
        // Exception.Message/StackTrace, which can contain paths or input data.
        Console.Error.WriteLine("native_" + Stage + "_hresult_" + error.HResult.ToString("x8"));
    }
    static string StoragePath(string location) {
        // Framework ACL overloads eventually call Win32 with the supplied path.
        // Extended paths also work when the machine has not opted all processes
        // into long paths. Normalize before adding the prefix, retaining the
        // same exact file and all ownership/reparse checks below.
        string full = Path.GetFullPath(location);
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
        return full.StartsWith(@"\\", StringComparison.Ordinal)
            ? @"\\?\UNC\" + full.Substring(2) : @"\\?\" + full;
    }
    static void NoReparse(string location) {
        string current = StoragePath(location);
        while (!String.IsNullOrEmpty(current)) {
            if (Directory.Exists(current) || File.Exists(current))
                Check((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "native_reparse_point");
            string parent = Path.GetDirectoryName(current);
            if (parent == current) break; current = parent;
        }
    }
    static DirectorySecurity DirectoryAcl() {
        var acl = new DirectorySecurity(); acl.SetOwner(Owner); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(Owner, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return acl;
    }
    static void VerifyAcl(string file, bool directory) {
        file = StoragePath(file);
        NoReparse(file);
        FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(file) : File.GetAccessControl(file);
        Check(Owner.Equals(acl.GetOwner(typeof(SecurityIdentifier))), "native_owner_mismatch");
        bool allowed = false;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            Check(Owner.Equals(rule.IdentityReference), "native_acl_not_private"); allowed = true;
        }
        Check(allowed, "native_acl_not_private");
    }
    static void PrivateDirectory(string directory) {
        directory = StoragePath(directory); NoReparse(directory);
        if (Directory.Exists(directory)) { VerifyAcl(directory, true); return; }
        var missing = new Stack<string>(); string cursor = directory;
        while (!Directory.Exists(cursor)) { missing.Push(cursor); cursor = Path.GetDirectoryName(cursor); Check(cursor != null); }
        while (missing.Count > 0) Directory.CreateDirectory(missing.Pop(), DirectoryAcl());
        VerifyAcl(directory, true);
    }
    static void CreatePrivateFile(string file, byte[] value) {
        file = StoragePath(file);
        NoReparse(file); VerifyAcl(Path.GetDirectoryName(file), true);
        var acl = new FileSecurity(); acl.SetOwner(Owner); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(Owner, FileSystemRights.FullControl, AccessControlType.Allow));
        // Explicit owner is essential under an elevated Windows token, whose
        // default owner may be Administrators. CreateNew never repairs/overwrites
        // an existing object; the caller atomically renames its own temp file.
        using (var stream = new FileStream(file, FileMode.CreateNew, FileSystemRights.Write,
            FileShare.None, 4096, FileOptions.None, acl)) {
            stream.Write(value, 0, value.Length); stream.Flush(true);
        }
        VerifyAcl(file, false);
    }
    static byte[] ReadBoundedInput() {
        using (var stream = Console.OpenStandardInput()) using (var data = new MemoryStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                Check(data.Length + count <= 48 * 1024 * 1024); data.Write(buffer, 0, count);
            }
            return data.ToArray();
        }
    }
    static void Key(string op, string file, string identity) {
        file = StoragePath(file);
        Check(identity.Length == 64 && System.Text.RegularExpressions.Regex.IsMatch(identity, "^[a-f0-9]+$"));
        VerifyAcl(Path.GetDirectoryName(file), true);
        if (File.Exists(file)) VerifyAcl(file, false);
        // Non-financial WhatsApp sessions rely on exact SID/DACL and DPAPI
        // CurrentUser. Do not add a CredUI password prompt on every new session.
        byte[] key = null;
        byte[] entropy = Encoding.UTF8.GetBytes("trelio/whatsapp-web/v1/" + identity);
        try {
            if (op == "key-create") {
                key = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(key);
                byte[] encrypted = ProtectedData.Protect(key, entropy, DataProtectionScope.CurrentUser);
                CreatePrivateFile(file, encrypted); Console.WriteLine(Convert.ToBase64String(key));
            } else if (op == "key-read") {
                Check(new FileInfo(file).Length <= 16384);
                key = ProtectedData.Unprotect(File.ReadAllBytes(file), entropy, DataProtectionScope.CurrentUser);
                Check(key.Length == 32); Console.WriteLine(Convert.ToBase64String(key));
            } else if (op == "key-delete") { File.Delete(file); Console.WriteLine("ok"); }
            else throw new InvalidOperationException();
        } finally { if (key != null) Array.Clear(key, 0, key.Length); }
    }
    static double Continuous() { ulong time; QueryInterruptTime(out time); return time / 10000.0; }
    static double Wall() { return (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
    static string Quote(string text) {
        // CommandLineToArgvW/CRT quoting; no shell, interpolation, or secret args.
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in text) {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            result.Append(ch); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static void Guard(string node, string workerPath, double duration, string config) {
        Stage = "guard_config";
        Check(duration > 0 && duration <= MaximumLease && config != null && config.Length <= 16384, "native_guard_config_invalid");
        Stage = "guard_clock";
        double start = Continuous(), wall = Wall();
        Stage = "guard_config";
        var configObject = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(config);
        if (configObject.ContainsKey("expiresAt") || configObject.ContainsKey("startedAt")) {
            Check(configObject.ContainsKey("expiresAt") && configObject.ContainsKey("startedAt"));
            double expiry = Convert.ToDouble(configObject["expiresAt"]), started = Convert.ToDouble(configObject["startedAt"]);
            Check(expiry - started == MaximumLease && expiry <= wall + MaximumLease);
            // A slow file write or native startup cannot buy another 30 minutes.
            duration = Math.Min(duration, expiry - wall); Check(duration > 0);
        }
        Stage = "guard_job";
        IntPtr job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "native_job_create_failed");
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "native_job_limits_failed");
        Process worker = null; int stopped = 0;
        Action stop = delegate {
            if (Interlocked.Exchange(ref stopped, 1) != 0) return;
            TerminateJobObject(job, 1); CloseHandle(job); Environment.Exit(1);
        };
        Func<bool> valid = () => Continuous() >= start && Continuous() - start < duration && Wall() >= wall - 2000 && Wall() < wall + duration;
        try {
            Stage = "guard_worker";
            worker = new Process(); worker.StartInfo = new ProcessStartInfo(node, Quote(workerPath)) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8
            };
            worker.EnableRaisingEvents = true; worker.Exited += (sender, args) => {
                Console.Error.WriteLine("native_worker_exited"); stop();
            };
            Check(worker.Start());
            Stage = "guard_assign";
            // Worker waits for this config before launching any subprocess. The
            // assignment barrier closes the Start->Assign race without requiring
            // elevated permissions or inheriting handles from the agent.
            if (!AssignProcessToJobObject(job, worker.Handle)) {
                Console.Error.WriteLine("native_job_assignment_failed"); worker.Kill(); stop();
            }
            worker.ErrorDataReceived += (sender, args) => {}; worker.BeginErrorReadLine();
            Stage = "guard_pipe";
            // Do not depend on Console.InputEncoding: a detached guardian has
            // no console/code page. The private protocol is always UTF-8 without
            // a BOM, including Windows paths containing Cyrillic characters.
            var input = new StreamWriter(worker.StandardInput.BaseStream, new UTF8Encoding(false));
            input.AutoFlush = true; input.WriteLine(config);
            var clock = new Thread(() => { while (true) { if (!valid()) stop(); Thread.Sleep(100); } });
            clock.IsBackground = true; clock.Start();
            var json = new JavaScriptSerializer();
            Stage = "guard_packets";
            while (true) {
                string line = worker.StandardOutput.ReadLine();
                Check(line != null && line.Length <= 8192 && valid());
                var packet = json.Deserialize<Dictionary<string, object>>(line);
                string op = (string)packet["op"]; int id = Convert.ToInt32(packet["id"]);
                if (op == "own") {
                    using (var browser = Process.GetProcessById(Convert.ToInt32(packet["pid"]))) {
                        bool belongs; Check(IsProcessInJob(browser.Handle, job, out belongs) && belongs, "native_browser_not_owned");
                    }
                } else Check(op == "permit");
                input.WriteLine("{\"id\":" + id + ",\"ok\":true}");
            }
        } catch (NativeFailure error) { Console.Error.WriteLine(error.Message); }
        catch (Exception error) { Report(error); }
        finally { stop(); }
    }
    // A synthetic in-memory DPAPI regression is safe in unattended Windows CI.
    // It cannot read or modify real vaults; only synthetic in-memory values.
    static void CryptoSelfTest() {
        byte[] value = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(value);
        byte[] entropy = Encoding.UTF8.GetBytes("trelio-whatsapp-web-synthetic-test");
        byte[] encrypted = ProtectedData.Protect(value, entropy, DataProtectionScope.CurrentUser);
        byte[] roundtrip = ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser);
        Check(Convert.ToBase64String(value) == Convert.ToBase64String(roundtrip));
        encrypted[encrypted.Length / 2] ^= 1;
        bool rejected = false; try { ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser); }
        catch (CryptographicException) { rejected = true; }
        Check(rejected); Console.WriteLine("dpapi-current-user-roundtrip-tamper-ok");
    }
    [STAThread]
    static int Main(string[] args) {
        try {
            // The standalone Framework compiler otherwise selects legacy path
            // handling. Company/member/connection UUIDs plus an atomic-write
            // suffix can exceed MAX_PATH even below a normal LOCALAPPDATA root.
            // Enable Framework 4.6.2+ long paths before any System.IO access;
            // ACL ownership and reparse-point checks still cover every path.
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            // Setting Console.InputEncoding calls SetConsoleCP, which fails for
            // DETACHED_PROCESS. Bind the redirected handles directly instead;
            // no console window is created merely to transport private JSON.
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
            var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true; Console.SetOut(output);
            if (args.Length == 1 && args[0] == "probe") {
                Check(Continuous() >= 0); Console.WriteLine("windows-dpapi-job-continuous-v1");
            }
            else if (args.Length == 1 && args[0] == "self-test") CryptoSelfTest();
            else if (args.Length == 2 && args[0] == "private-directory") PrivateDirectory(args[1]);
            else if (args.Length == 2 && args[0] == "verify-directory") VerifyAcl(args[1], true);
            else if (args.Length == 2 && args[0] == "verify-file") VerifyAcl(args[1], false);
            else if (args.Length == 2 && args[0] == "write-private") CreatePrivateFile(args[1], ReadBoundedInput());
            else if (args.Length == 3 && args[0].StartsWith("key-")) Key(args[0], args[1], args[2]);
            else if (args.Length == 4 && args[0] == "guard") Guard(args[1], args[2], Double.Parse(args[3], System.Globalization.CultureInfo.InvariantCulture), Console.ReadLine());
            else throw new InvalidOperationException();
            return 0;
        } catch (NativeFailure error) { Console.Error.WriteLine(error.Message); return 2; }
        catch (PathTooLongException) { Console.Error.WriteLine("native_path_too_long"); return 2; }
        catch (DirectoryNotFoundException) { Console.Error.WriteLine("native_directory_missing"); return 2; }
        catch (Exception error) { Report(error); return 2; }
    }
}
