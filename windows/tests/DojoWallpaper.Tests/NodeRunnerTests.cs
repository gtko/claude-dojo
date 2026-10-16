using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;

namespace DojoWallpaper.Tests
{
    // Lancement de setup.js : echappement des arguments (aller-retour), parsing de la sortie, stdin, delai.
    internal static class NodeRunnerTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("NodeRunner : echappement des arguments relu par CommandLineToArgvW", EscapeRoundTrip));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : ligne de commande = setup.js puis arguments echappes", CommandLine));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : derniere ligne non vide de stdout = JSON", LastLineIsJson));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : sortie illisible -> reponse illisible", UnreadableOutput));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : ok:false remonte error", ErrorFromJson));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : code de sortie non nul sans JSON -> stderr tronque a 300", StderrTruncated));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : code de sortie non nul force ok:false", NonZeroExitIsFailure));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : stdin transmis et stdout lu (processus reel)", StdinAndStdout));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : delai depasse -> processus arrete (processus reel)", TimeoutKills));
            list.Add(new KeyValuePair<string, Action>("NodeRunner : setup.js absent ou node introuvable -> ok:false", MissingPieces));
            return list;
        }

        // Analyse une ligne de commande Windows selon CommandLineToArgvW (miroir du parseur de MSVCRT).
        internal static List<string> ParseCommandLine(string line)
        {
            var args = new List<string>();
            var current = new StringBuilder();
            bool inToken = false;
            bool inQuotes = false;
            int backslashes = 0;
            foreach (char c in line)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    current.Append('\\', backslashes / 2);
                    if (backslashes % 2 == 1)
                    {
                        current.Append('"');
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }
                    inToken = true;
                    backslashes = 0;
                    continue;
                }
                current.Append('\\', backslashes);
                backslashes = 0;
                if (c == ' ' && !inQuotes)
                {
                    if (inToken)
                    {
                        args.Add(current.ToString());
                        current.Clear();
                        inToken = false;
                    }
                    continue;
                }
                current.Append(c);
                inToken = true;
            }
            current.Append('\\', backslashes);
            if (inToken)
            {
                args.Add(current.ToString());
            }
            return args;
        }

        private static void EscapeRoundTrip()
        {
            string[] samples =
            {
                "",
                "abc",
                "a b",
                "a\"b",
                "trailing\\",
                "a b\\",
                "a\\\"b",
                "{\"ghostty\":true,\"welcome\":false}",
                "C:\\Program Files\\Dojo Wallpaper\\",
                "tab\there",
                "\\\\server\\share\\x y\\",
                "\"quoted\" and \\\\ double",
            };
            foreach (string sample in samples)
            {
                string escaped = NodeRunner.EscapeArgument(sample);
                List<string> back = ParseCommandLine(escaped);
                Assert.AreEqual(1, back.Count, "un seul argument pour : " + sample);
                Assert.AreEqual(sample, back[0], "aller-retour pour : " + sample);
            }
            Assert.AreEqual("\"\"", NodeRunner.EscapeArgument(""), "chaine vide");
            Assert.AreEqual("abc", NodeRunner.EscapeArgument("abc"), "sans espace : inchangee");
        }

        private static void CommandLine()
        {
            string setup = @"C:\Users\Jean Dupont\.config\claude-dojo\setup.js";
            string line = NodeRunner.BuildArguments(setup, new[] { "write-config", "-" });
            List<string> args = ParseCommandLine(line);
            Assert.AreEqual(3, args.Count, "nombre d'arguments");
            Assert.AreEqual(setup, args[0], "chemin de setup.js");
            Assert.AreEqual("write-config", args[1], "commande");
            Assert.AreEqual("-", args[2], "stdin");
        }

        private static void LastLineIsJson()
        {
            IDictionary<string, object> result = NodeRunner.ParseOutput(
                "bruit avant\n{\"ok\":true,\"x\":1}\n\n   \n", 0, string.Empty);
            Assert.IsTrue((bool)result["ok"], "ok");
            Assert.AreEqual(1, (int)result["x"], "champ du JSON conserve");
        }

        private static void UnreadableOutput()
        {
            foreach (string text in new[] { string.Empty, "pas du json", "{\"ok\":true" })
            {
                IDictionary<string, object> result = NodeRunner.ParseOutput(text, 0, string.Empty);
                Assert.IsFalse((bool)result["ok"], "ok:false pour : " + text);
                Assert.AreEqual("réponse illisible", (string)result["error"], "message pour : " + text);
            }
        }

        private static void ErrorFromJson()
        {
            IDictionary<string, object> result = NodeRunner.ParseOutput(
                "{\"ok\":false,\"error\":\"thème inconnu\"}", 1, "ignore");
            Assert.IsFalse((bool)result["ok"], "ok");
            Assert.AreEqual("thème inconnu", (string)result["error"], "error du JSON");
        }

        private static void StderrTruncated()
        {
            string stderr = new string('e', 500);
            IDictionary<string, object> result = NodeRunner.ParseOutput("texte non JSON", 1, stderr);
            Assert.IsFalse((bool)result["ok"], "ok");
            Assert.AreEqual(300, ((string)result["error"]).Length, "stderr tronque a 300 caracteres");
        }

        private static void NonZeroExitIsFailure()
        {
            IDictionary<string, object> result = NodeRunner.ParseOutput("{\"ok\":true}", 2, string.Empty);
            Assert.IsFalse((bool)result["ok"], "ok:true avec code 2 reste un echec");
            Assert.IsTrue(((string)result["error"]).Length > 0, "message d'erreur present");
        }

        private static void StdinAndStdout()
        {
            NodeRunner.ProcessRun run = NodeRunner.RunProcess("cmd.exe", "/d /c more", "{\"a\":1}\n", 30, null);
            Assert.IsFalse(run.TimedOut, "pas de delai");
            Assert.AreEqual(0, run.ExitCode, "code de sortie");
            Assert.IsTrue(run.Stdout.Contains("{\"a\":1}"), "stdin relu sur stdout : " + run.Stdout);
        }

        private static void TimeoutKills()
        {
            var watch = Stopwatch.StartNew();
            NodeRunner.ProcessRun run = NodeRunner.RunProcess(
                "cmd.exe", "/d /c \"ping -n 30 127.0.0.1 >nul 2>&1\"", null, 1, null);
            watch.Stop();
            Assert.IsTrue(run.TimedOut, "delai depasse");
            Assert.IsTrue(watch.Elapsed.TotalSeconds < 20, "processus arrete rapidement : " + watch.Elapsed.TotalSeconds);
        }

        private static void MissingPieces()
        {
            var call = new BridgeCall("themes", new[] { "themes" }, null, 30);
            IDictionary<string, object> noNode = NodeRunner.Execute(call, null, @"C:\nope\setup.js");
            Assert.IsFalse((bool)noNode["ok"], "node absent");
            Assert.IsTrue(((string)noNode["error"]).Contains("Node.js"), "message Node.js");

            var old = new NodeInfo { Path = "node.exe", Version = "16.20.2", Ok = false };
            IDictionary<string, object> oldNode = NodeRunner.Execute(call, old, @"C:\nope\setup.js");
            Assert.IsFalse((bool)oldNode["ok"], "node trop ancien");
            Assert.IsTrue(((string)oldNode["error"]).Contains("16.20.2"), "version dans le message");

            var good = new NodeInfo { Path = "node.exe", Version = "20.0.0", Ok = true };
            IDictionary<string, object> noSetup = NodeRunner.Execute(call, good, @"C:\nope\setup.js");
            Assert.IsFalse((bool)noSetup["ok"], "setup.js absent");
            Assert.IsTrue(((string)noSetup["error"]).Contains("setup.js"), "message setup.js");
        }
    }
}
