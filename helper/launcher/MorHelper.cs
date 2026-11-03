// MorHelper.exe: what Firefox starts for Mor's extension (its native messaging host). A windowless program that
// runs the helper (python -m mor_helper, from the helper's own environment beside it) with no console window, and
// passes Firefox's messages through to it and its answers back. When Firefox closes the connection the helper ends,
// and so does this.
// Built by Install Mor.cmd with the C# compiler that ships with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

[assembly: AssemblyTitle("Mor Helper")]
[assembly: AssemblyProduct("Mor")]
[assembly: AssemblyDescription("Mor's helper for Firefox")]
[assembly: AssemblyVersion("0.1.4.0")]
[assembly: AssemblyFileVersion("0.1.4.0")]

static class Program {
    static int Main() {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string python = Path.Combine(root, @".venv\Scripts\python.exe");
        if (!File.Exists(python)) return 1;

        var start = new ProcessStartInfo(python, "-m mor_helper");
        start.WorkingDirectory = root;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = false;
        start.EnvironmentVariables["PYTHONUTF8"] = "1";

        using (var helper = Process.Start(start)) {
            Stream fromFirefox = Console.OpenStandardInput();
            Stream toFirefox = Console.OpenStandardOutput();
            var down = new Thread(() => Pump(fromFirefox, helper.StandardInput.BaseStream, true));
            var up = new Thread(() => Pump(helper.StandardOutput.BaseStream, toFirefox, false));
            down.IsBackground = true;
            up.IsBackground = true;
            down.Start();
            up.Start();
            helper.WaitForExit();
            up.Join(2000);
            return helper.ExitCode;
        }
    }

    static void Pump(Stream from, Stream to, bool closeAfter) {
        var buffer = new byte[65536];
        try {
            int read;
            while ((read = from.Read(buffer, 0, buffer.Length)) > 0) {
                to.Write(buffer, 0, read);
                to.Flush();
            }
        } catch (IOException) {
            // one side is gone: the helper or Firefox ended the connection
        } catch (ObjectDisposedException) {
        }
        if (closeAfter) {
            try { to.Close(); } catch (IOException) { }
        }
    }
}
