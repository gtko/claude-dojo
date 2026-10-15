using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace DojoWallpaper
{
    // Execution de « node setup.js <argv> » (sans shell). La derniere ligne non vide de stdout est le JSON de reponse.
    // Toujours un objet { ok: bool, ... } : aucune exception ne remonte a l'appelant.
    public static class NodeRunner
    {
        public const int MaxErrorChars = 300;
        public const string SetupScript = "setup.js";

        // Resultat brut d'un processus (sortie decodee en UTF-8).
        internal sealed class ProcessRun
        {
            public int ExitCode { get; set; }
            public string Stdout { get; set; }
            public string Stderr { get; set; }
            public bool TimedOut { get; set; }
        }

        // Lance setup.js avec l'appel valide. Node est cherche hors du thread UI.
        public static Task<IDictionary<string, object>> RunAsync(BridgeCall call, string setupPath)
        {
            return Task.Run(() =>
            {
                NodeInfo node;
                try
                {
                    node = NodeLocator.Find();
                }
                catch (Exception ex)
                {
                    return Failure("Node.js introuvable : " + ex.Message);
                }
                return Execute(call, node, setupPath);
            });
        }

        // Execution avec un node deja choisi (sans recherche).
        internal static IDictionary<string, object> Execute(BridgeCall call, NodeInfo node, string setupPath)
        {
            try
            {
                if (call == null)
                {
                    return Failure("appel manquant.");
                }
                if (node == null)
                {
                    return Failure("Node.js 18 ou plus introuvable : installer Node.js (https://nodejs.org).");
                }
                if (!node.Ok)
                {
                    return Failure("Node.js 18 ou plus requis (version trouvée : " + node.Version + ").");
                }
                if (string.IsNullOrEmpty(setupPath) || !File.Exists(setupPath))
                {
                    return Failure("setup.js introuvable : " + setupPath);
                }

                string workdir = Path.GetDirectoryName(setupPath);
                ProcessRun run = RunProcess(
                    node.Path, BuildArguments(setupPath, call.Argv), call.Stdin, call.TimeoutSeconds, workdir);
                if (run.TimedOut)
                {
                    return Failure("délai dépassé (" + call.TimeoutSeconds + " s)");
                }
                return ParseOutput(run.Stdout, run.ExitCode, run.Stderr);
            }
            catch (Exception ex)
            {
                return Failure("exécution impossible : " + ex.Message);
            }
        }

        // Ligne de commande : chemin de setup.js puis chaque argument, echappes (regles CommandLineToArgvW).
        public static string BuildArguments(string setupPath, IEnumerable<string> argv)
        {
            var parts = new List<string> { EscapeArgument(setupPath) };
            parts.AddRange(argv.Select(EscapeArgument));
            return string.Join(" ", parts);
        }

        // Echappement d'un argument pour la ligne de commande Windows (CommandLineToArgvW / MSVCRT).
        public static string EscapeArgument(string arg)
        {
            if (arg == null)
            {
                arg = string.Empty;
            }
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
            {
                return arg;
            }

            var sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    // Les antislashs qui precedent un guillemet sont doubles, puis le guillemet est echappe.
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(c);
                }
                backslashes = 0;
            }
            // Antislashs finaux : doubles, pour ne pas echapper le guillemet de fermeture.
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        // Sortie de setup.js -> reponse. Fonction pure.
        public static IDictionary<string, object> ParseOutput(string stdout, int exitCode, string stderr)
        {
            string last = LastNonEmptyLine(stdout);
            IDictionary<string, object> obj = last == null ? null : JsonText.ParseObject(last);
            if (obj == null)
            {
                string errText = Truncate((stderr ?? string.Empty).Trim());
                if (exitCode != 0 && errText.Length > 0)
                {
                    return Failure(errText);
                }
                return Failure("réponse illisible");
            }

            var result = new Dictionary<string, object>(obj);
            object okValue;
            bool ok = result.TryGetValue("ok", out okValue) && okValue is bool && (bool)okValue;
            if (exitCode != 0)
            {
                ok = false;
            }
            result["ok"] = ok;
            if (!ok && !(result.ContainsKey("error") && result["error"] is string && ((string)result["error"]).Length > 0))
            {
                string errText = Truncate((stderr ?? string.Empty).Trim());
                result["error"] = errText.Length > 0 ? errText : "échec de la commande (code " + exitCode + ")";
            }
            return result;
        }

        // Execute un programme avec arguments bruts (deja echappes), stdin optionnel (UTF-8 sans BOM).
        // Au depassement du delai : arbre de processus tue, TimedOut = true.
        internal static ProcessRun RunProcess(string fileName, string arguments, string stdin, int timeoutSeconds, string workingDirectory)
        {
            var psi = new ProcessStartInfo(fileName, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            if (!string.IsNullOrEmpty(workingDirectory) && Directory.Exists(workingDirectory))
            {
                psi.WorkingDirectory = workingDirectory;
            }

            using (var process = new Process { StartInfo = psi })
            {
                process.Start();
                Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
                Task<string> stderrTask = process.StandardError.ReadToEndAsync();
                Task stdinTask = Task.Run(() =>
                {
                    try
                    {
                        if (!string.IsNullOrEmpty(stdin))
                        {
                            // Octets UTF-8 sans BOM, ecrits directement : StandardInput utiliserait l'encodage de la console (OEM).
                            byte[] bytes = new UTF8Encoding(false).GetBytes(stdin);
                            process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                            process.StandardInput.BaseStream.Flush();
                        }
                    }
                    catch (IOException)
                    {
                        // Le processus a quitte sans lire stdin.
                    }
                    finally
                    {
                        try
                        {
                            process.StandardInput.Close();
                        }
                        catch (IOException)
                        {
                        }
                    }
                });

                var run = new ProcessRun();
                if (!process.WaitForExit(timeoutSeconds * 1000))
                {
                    KillTree(process);
                    Task.WaitAll(new Task[] { stdoutTask, stderrTask, stdinTask }, 2000);
                    run.TimedOut = true;
                    run.ExitCode = -1;
                    run.Stdout = string.Empty;
                    run.Stderr = string.Empty;
                    return run;
                }

                process.WaitForExit();
                Task.WaitAll(new Task[] { stdoutTask, stderrTask, stdinTask }, 5000);
                run.ExitCode = process.ExitCode;
                run.Stdout = stdoutTask.IsCompleted ? stdoutTask.Result : string.Empty;
                run.Stderr = stderrTask.IsCompleted ? stderrTask.Result : string.Empty;
                return run;
            }
        }

        // Arrete le processus et ses enfants (node peut lancer powershell, npm...). Best effort.
        private static void KillTree(Process process)
        {
            try
            {
                var psi = new ProcessStartInfo(
                    Path.Combine(Environment.SystemDirectory, "taskkill.exe"),
                    "/T /F /PID " + process.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var killer = Process.Start(psi))
                {
                    if (killer != null)
                    {
                        killer.WaitForExit(5000);
                    }
                }
            }
            catch (Exception)
            {
            }
            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                }
                process.WaitForExit(2000);
            }
            catch (Exception)
            {
            }
        }

        private static string LastNonEmptyLine(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }
            string[] lines = text.Split('\n');
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string line = lines[i].Trim();
                if (line.Length > 0)
                {
                    return line;
                }
            }
            return null;
        }

        private static string Truncate(string text)
        {
            return text.Length > MaxErrorChars ? text.Substring(0, MaxErrorChars) : text;
        }

        private static IDictionary<string, object> Failure(string message)
        {
            return new Dictionary<string, object> { { "ok", false }, { "error", message } };
        }
    }
}
