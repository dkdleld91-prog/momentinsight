using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace MomentInsight.NaverShopping
{
    internal static class Program
    {
        private const string ProductionApiUrl = "https://insight.momentlabs.co.kr/api/naver-shopping-local-worker";
        private const string ProductionOrigin = "https://insight.momentlabs.co.kr";
        private const string EntropyLabel = "co.kr.momentinsight.naver-shopping-local-worker.v1";

        [STAThread]
        private static int Main(string[] args)
        {
            byte[] protectedSecret = null;
            byte[] secretBytes = null;
            string secret = null;
            try
            {
                string runtimePath = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                    Path.DirectorySeparatorChar,
                    Path.AltDirectorySeparatorChar
                );
                string configPath = Path.Combine(runtimePath, "windows-native-host.conf");
                string secretPath = Path.Combine(runtimePath, "windows-worker-secret.dpapi");
                string hostScriptPath = Path.Combine(runtimePath, "scripts", "naver-shopping-native-host.mjs");
                string[] config = File.ReadAllLines(configPath, Encoding.UTF8);
                if (config.Length != 3)
                {
                    return Fail("config_line_count_invalid");
                }

                string nodePath = Path.GetFullPath(config[0].Trim());
                string apiUrl = config[1].Trim();
                string maxJobs = config[2].Trim();
                if (!File.Exists(nodePath) || !nodePath.EndsWith("node.exe", StringComparison.OrdinalIgnoreCase))
                {
                    return Fail("node_path_invalid");
                }
                if (!String.Equals(apiUrl, ProductionApiUrl, StringComparison.Ordinal))
                {
                    return Fail("api_url_invalid");
                }
                if (!String.Equals(maxJobs, "1", StringComparison.Ordinal))
                {
                    return Fail("max_jobs_invalid");
                }
                if (!File.Exists(hostScriptPath))
                {
                    return Fail("host_script_missing");
                }

                protectedSecret = Convert.FromBase64String(File.ReadAllText(secretPath, Encoding.UTF8).Trim());
                secretBytes = ProtectedData.Unprotect(
                    protectedSecret,
                    Encoding.UTF8.GetBytes(EntropyLabel),
                    DataProtectionScope.CurrentUser
                );
                secret = Encoding.UTF8.GetString(secretBytes);
                if (secret.Length < 32)
                {
                    return Fail("worker_secret_invalid");
                }

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = nodePath;
                start.Arguments = Quote(hostScriptPath);
                start.WorkingDirectory = runtimePath;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardInput = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = false;
                start.EnvironmentVariables["MI_NAVER_SHOPPING_LOCAL_WORKER_ENABLED"] = "true";
                start.EnvironmentVariables["MI_NAVER_SHOPPING_LOCAL_WORKER_SECRET"] = secret;
                start.EnvironmentVariables["MI_NAVER_SHOPPING_LOCAL_WORKER_API_URL"] = apiUrl;
                start.EnvironmentVariables["MI_NAVER_SHOPPING_LOCAL_WORKER_ALLOWED_ORIGINS"] = ProductionOrigin;
                start.EnvironmentVariables["MI_NAVER_SHOPPING_LOCAL_WORKER_MAX_JOBS"] = maxJobs;

                using (Process child = Process.Start(start))
                {
                    if (child == null)
                    {
                        return Fail("node_start_failed");
                    }

                    Thread inputRelay = new Thread(() => RelayInput(child));
                    Thread outputRelay = new Thread(() => RelayOutput(child));
                    inputRelay.IsBackground = true;
                    outputRelay.IsBackground = true;
                    inputRelay.Start();
                    outputRelay.Start();
                    child.WaitForExit();
                    if (!outputRelay.Join(5000))
                    {
                        return Fail("native_host_output_relay_timeout");
                    }
                    return child.ExitCode;
                }
            }
            catch (CryptographicException)
            {
                return Fail("dpapi_unprotect_failed");
            }
            catch (Exception)
            {
                return Fail("native_host_launcher_failed");
            }
            finally
            {
                secret = null;
                if (secretBytes != null) Array.Clear(secretBytes, 0, secretBytes.Length);
                if (protectedSecret != null) Array.Clear(protectedSecret, 0, protectedSecret.Length);
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void RelayInput(Process child)
        {
            try
            {
                using (Stream input = Console.OpenStandardInput())
                {
                    input.CopyTo(child.StandardInput.BaseStream);
                }
                child.StandardInput.Close();
            }
            catch (IOException)
            {
                // Chrome or the child closed the native messaging pipe.
            }
            catch (ObjectDisposedException)
            {
                // The child exited while the background relay was finishing.
            }
        }

        private static void RelayOutput(Process child)
        {
            try
            {
                using (Stream output = Console.OpenStandardOutput())
                {
                    child.StandardOutput.BaseStream.CopyTo(output);
                    output.Flush();
                }
            }
            catch (IOException)
            {
                // Chrome disconnected; the child process will exit with the pipe.
            }
            catch (ObjectDisposedException)
            {
                // The child exited while the background relay was finishing.
            }
        }

        private static int Fail(string code)
        {
            try
            {
                string logDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MomentInsight",
                    "Logs"
                );
                Directory.CreateDirectory(logDirectory);
                File.AppendAllText(
                    Path.Combine(logDirectory, "naver-shopping-native-host-launcher.log"),
                    DateTime.UtcNow.ToString("o") + " " + code + Environment.NewLine,
                    Encoding.UTF8
                );
            }
            catch
            {
                // Native messaging stdout must stay completely clean.
            }
            return 1;
        }
    }
}
