using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace DojoWallpaper.Tests
{
    // Liste blanche des commandes du pont : acceptations, refus (injection, bornes, stdin, JSON, chemins).
    internal static class BridgeCommandsTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : commandes simples acceptees (argv, delai)", SimpleCommands));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : commandes inconnues refusees", UnknownCommands));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : injection (; & | guillemets, --, -, ..) refusee", Injection));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : bornes de longueur et de format", Bounds));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : stdin reserve a write-config et merge-settings", StdinRules));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : options terminal (cles booleennes, 2 Ko)", TerminalJson));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : set-background (chemin absolu, extension, existence)", SetBackground));
            list.Add(new KeyValuePair<string, Action>("BridgeCommands : wallpapers use (mots-cles, id, fichier)", WallpaperUse));
            return list;
        }

        private static BridgeCall Call(string cmd, string stdin, params string[] args)
        {
            return BridgeCommands.Validate(cmd, args, stdin);
        }

        private static void Refused(string cmd, string stdin, params string[] args)
        {
            Assert.Throws<BridgeRejectedException>(
                () => BridgeCommands.Validate(cmd, args, stdin),
                "refus attendu : " + cmd + " [" + string.Join("|", args) + "]");
        }

        private static void Argv(BridgeCall call, int timeout, string expected)
        {
            Assert.AreEqual(expected, string.Join("|", call.Argv), "argv");
            Assert.AreEqual(timeout, call.TimeoutSeconds, "delai de " + call.Command);
        }

        private static void SimpleCommands()
        {
            Argv(Call("themes", null), 30, "themes");
            Argv(Call("detect", null), 60, "detect");
            Argv(Call("status", null), 30, "status");
            Argv(Call("set-theme", null, "demo"), 60, "set-theme|demo");
            Argv(Call("geocode", null, "Paris, France"), 30, "geocode|Paris, France");
            Argv(Call("wallpapers", null, "list", "demo"), 90, "wallpapers|list|demo");
            Argv(Call("wallpapers", null, "search", "demo"), 90, "wallpapers|search|demo");
            Argv(Call("wallpapers", null, "search", "demo", "3"), 90, "wallpapers|search|demo|3");
            Argv(Call("wallpapers", null, "local", "demo"), 30, "wallpapers|local|demo");
            Argv(Call("wallpapers", null, "download", "abc123"), 180, "wallpapers|download|abc123");
            Argv(Call("wallpapers", null, "download", "abc123", "demo"), 180, "wallpapers|download|abc123|demo");
            Argv(Call("wallpapers", null, "sync"), 600, "wallpapers|sync");
            Argv(Call("wallpapers", null, "sync", "demo"), 600, "wallpapers|sync|demo");
            Argv(Call("wallpapers", null, "progress", "demo"), 30, "wallpapers|progress|demo");
            Argv(Call("wallpapers", null, "next"), 180, "wallpapers|next");
            Argv(Call("terminal", null, "status"), 180, "terminal|status");
            Argv(Call("terminal", null, "apply", "{\"ghostty\":true}"), 180, "terminal|apply|{\"ghostty\":true}");
            Argv(Call("terminal", null, "remove"), 180, "terminal|remove");
            Argv(Call("set-theme", "", "demo"), 60, "set-theme|demo");
        }

        private static void UnknownCommands()
        {
            Refused("window-zone", null);
            Refused("rm", null, "-rf");
            Refused("themes;calc", null);
            Refused("Themes", null);
            Refused("wallpapers", null, "delete", "demo");
            Refused("terminal", null, "install");
            Refused("merge-settings", null, "{}");
            Refused("unmerge-settings", null, "{}");
            Refused("uninstall", null);
            Refused("", null);
            Assert.Throws<BridgeRejectedException>(() => BridgeCommands.Validate(null, new string[0], null), "commande null");
        }

        private static void Injection()
        {
            Refused("set-theme", null, "a;b");
            Refused("set-theme", null, "a&b");
            Refused("set-theme", null, "a|b");
            Refused("set-theme", null, "a b");
            Refused("set-theme", null, "a\"b");
            Refused("set-theme", null, "a$b");
            Refused("set-theme", null, "--x");
            Refused("set-theme", null, "-x");
            Refused("set-theme", null, "-");
            Refused("set-theme", null, "../x");
            Refused("set-theme", null, "demo", "extra");
            Refused("geocode", null, "-Paris");
            Refused("wallpapers", null, "use", "--force");
            Refused("wallpapers", null, "use", "../secret.jpg");
            Refused("wallpapers", null, "use", "fond..jpg");
            Refused("wallpapers", null, "use", "-rf");
            Refused("wallpapers", null, "search", "demo", "-1");
            Refused("terminal", null, "status", "-");
        }

        private static void Bounds()
        {
            Call("set-theme", null, "a");
            Call("set-theme", null, "1a");
            Call("set-theme", null, new string('a', 40));
            Refused("set-theme", null, new string('a', 41));
            Refused("set-theme", null, "_a");
            Refused("set-theme", null, "A");
            Refused("set-theme", null, "a\n");
            Refused("set-theme", null, "a\u0007");

            Call("wallpapers", null, "search", "demo", "1");
            Call("wallpapers", null, "search", "demo", "1000");
            Refused("wallpapers", null, "search", "demo", "0");
            Refused("wallpapers", null, "search", "demo", "1001");
            Refused("wallpapers", null, "search", "demo", "x");

            Call("geocode", null, new string('a', 100));
            Refused("geocode", null, new string('a', 101));
            Refused("geocode", null, "");
            Refused("geocode", null, "   ");

            Call("wallpapers", null, "download", "abc");
            Call("wallpapers", null, "download", new string('a', 16));
            Refused("wallpapers", null, "download", new string('a', 17));
            Refused("wallpapers", null, "download", "ab");
            Refused("wallpapers", null, "download", "ab-c");

            Refused("wallpapers", null, "list");
            Refused("wallpapers", null, "list", "demo", "extra");
            Refused("wallpapers", null, "next", "extra");
            Refused("terminal", null, "status", "{}", "extra");
        }

        private static void StdinRules()
        {
            Refused("themes", "{}");
            Refused("wallpapers", "x", "list", "demo");
            Refused("set-theme", "{}", "demo");

            BridgeCall writeConfig = Call("write-config", "{\"theme\":\"demo\"}", "-");
            Argv(writeConfig, 60, "write-config|-");
            Assert.AreEqual("{\"theme\":\"demo\"}", writeConfig.Stdin, "stdin transmis");

            BridgeCall merge = Call("merge-settings", "{\"a\":1}", "-");
            Argv(merge, 120, "merge-settings|-");

            Refused("write-config", null, "-");
            Refused("write-config", "{}");
            Refused("write-config", "{}", "{}");
            Refused("write-config", "[]", "-");
            Refused("write-config", "5", "-");
            Refused("write-config", "pas du json", "-");
            Refused("merge-settings", "{}", "-", "extra");

            string big = "{\"a\":\"" + new string('x', BridgeCommands.MaxStdinBytes) + "\"}";
            Refused("write-config", big, "-");
        }

        private static void TerminalJson()
        {
            Call("terminal", null, "apply", "{\"ghostty\":true,\"welcome\":false}");
            Call("terminal", null, "apply", "{\"windowsTerminal\":true}");
            Call("terminal", null, "apply", "{\"terminalApp\":false}");
            Refused("terminal", null, "apply", "{\"foo\":true}");
            Refused("terminal", null, "apply", "{\"ghostty\":\"oui\"}");
            Refused("terminal", null, "apply", "{\"ghostty\":1}");
            Refused("terminal", null, "apply", "[]");
            Refused("terminal", null, "apply", "pas du json");
            Refused("terminal", null, "apply", "");
            Refused("terminal", null, "reset");

            Call("terminal", null, "status", "{" + new string(' ', 2046) + "}");
            Refused("terminal", null, "status", "{" + new string(' ', 2047) + "}");
        }

        private static void SetBackground()
        {
            Argv(Call("set-background", null, "default"), 120, "set-background|default");
            Refused("set-background", null, "fond.png");
            Refused("set-background", null, "C:\\dojo-inexistant\\fond.png");

            string dir = TestFiles.NewDir();
            try
            {
                string png = Path.Combine(dir, "fond.PNG");
                string txt = Path.Combine(dir, "fond.txt");
                TestFiles.Write(png, "x");
                TestFiles.Write(txt, "x");

                Argv(Call("set-background", null, png), 120, "set-background|" + png);
                Refused("set-background", null, txt);
                Refused("set-background", null, Path.Combine(dir, "absent.png"));
                Refused("set-background", null, png + "\n");
                Refused("set-background", null, png, "extra");
            }
            finally
            {
                TestFiles.DeleteDir(dir);
            }
        }

        private static void WallpaperUse()
        {
            Argv(Call("wallpapers", null, "use", "theme"), 60, "wallpapers|use|theme");
            Argv(Call("wallpapers", null, "use", "bundled"), 60, "wallpapers|use|bundled");
            Argv(Call("wallpapers", null, "use", "abc123"), 60, "wallpapers|use|abc123");
            Argv(Call("wallpapers", null, "use", "abc123", "demo"), 60, "wallpapers|use|abc123|demo");
            Argv(Call("wallpapers", null, "use", "fond.jpg"), 60, "wallpapers|use|fond.jpg");
            Refused("wallpapers", null, "use", "theme", "demo");
            Refused("wallpapers", null, "use", "bundled", "demo");
            Refused("wallpapers", null, "use", "fond.jpg", "demo");
            Refused("wallpapers", null, "use", "abc123", "Bad Theme");
            Refused("wallpapers", null);
            Refused("wallpapers", null, "use");
        }
    }
}
