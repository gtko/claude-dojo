using System;
using System.Collections.Generic;
using System.IO;

namespace DojoWallpaper.Tests
{
    internal static class ConfigTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(Case("DojoConfig : valeurs par defaut (Pause, IgnoreApps)", Defaults));
            list.Add(Case("DojoConfig : DefaultPath = dojo-wallpaper.json a cote de l'exe", DefaultPathIsBesideExe));
            list.Add(Case("DojoConfig : aller-retour JSON (Save puis Load), fichier indente", RoundTrip));
            list.Add(Case("DojoConfig : fichier absent -> defauts, Load ne cree rien", MissingFile));
            list.Add(Case("DojoConfig : fichier corrompu -> defauts + backup .bad", CorruptedFile));
            list.Add(Case("DojoConfig : racine non objet -> defauts + backup .bad", NonObjectFile));
            list.Add(Case("DojoConfig : normalisation des valeurs invalides", Normalization));
            list.Add(Case("DojoConfig : types incorrects et listes null tolerés", TolerantTypes));
            list.Add(Case("DojoConfig : DOJO_URL surcharge Load, jamais ecrite par Save", EnvironmentUrlNotSaved));
            list.Add(Case("DojoConfig : DOJO_URL invalide ignoree", InvalidEnvironmentUrl));
            list.Add(Case("DojoConfig : echappement des chaines (guillemets, antislash, accents)", Escaping));
            return list;
        }

        private static KeyValuePair<string, Action> Case(string name, Action action)
        {
            return new KeyValuePair<string, Action>(name, action);
        }

        private static void Defaults()
        {
            var cfg = new DojoConfig();
            Assert.AreEqual("http://localhost:7777/", cfg.Url, "Url");
            Assert.AreEqual("interactive", cfg.Mode, "Mode");
            Assert.IsTrue(cfg.Mirror, "Mirror");
            Assert.AreEqual(0.0, cfg.Zoom, "Zoom");
            Assert.AreEqual(0, cfg.DisabledScreens.Length, "DisabledScreens");
            Assert.IsTrue(cfg.Pause.OnFullscreen && cfg.Pause.OnMaximized, "Pause fullscreen/maximized");
            Assert.IsTrue(cfg.Pause.OnBattery && cfg.Pause.OnBatterySaver, "Pause batterie");
            Assert.AreEqual(0, cfg.Pause.ForegroundApps.Length, "ForegroundApps");
            Assert.AreEqual(
                "DojoWallpaper|SearchHost|ShellExperienceHost|StartMenuExperienceHost",
                string.Join("|", cfg.Pause.IgnoreApps),
                "IgnoreApps");
        }

        private static void DefaultPathIsBesideExe()
        {
            Assert.AreEqual(
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dojo-wallpaper.json"),
                DojoConfig.DefaultPath,
                "DefaultPath");
        }

        private static void RoundTrip()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    var cfg = new DojoConfig();
                    cfg.Url = "http://127.0.0.1:9000/";
                    cfg.Mode = "passive";
                    cfg.Mirror = false;
                    cfg.Zoom = 0.75;
                    cfg.DisabledScreens = new[] { 0, 2 };
                    cfg.Pause.OnFullscreen = false;
                    cfg.Pause.OnBattery = false;
                    cfg.Pause.ForegroundApps = new[] { "code", "notepad" };
                    cfg.Pause.IgnoreApps = new[] { "explorer" };
                    cfg.Save(path);

                    string text = TestFiles.Read(path);
                    Assert.IsTrue(text.Contains("\n  \"Mode\": \"passive\",\n"), "Mode indente sur une ligne");
                    Assert.IsTrue(text.Contains("\n    \"ForegroundApps\": [\n      \"code\",\n"), "liste indentee");

                    var back = DojoConfig.Load(path);
                    Assert.AreEqual("http://127.0.0.1:9000/", back.Url, "Url");
                    Assert.AreEqual("passive", back.Mode, "Mode");
                    Assert.AreEqual(false, back.Mirror, "Mirror");
                    Assert.AreEqual(0.75, back.Zoom, "Zoom");
                    Assert.AreEqual(2, back.DisabledScreens.Length, "DisabledScreens.Length");
                    Assert.AreEqual(0, back.DisabledScreens[0], "DisabledScreens[0]");
                    Assert.AreEqual(2, back.DisabledScreens[1], "DisabledScreens[1]");
                    Assert.AreEqual(false, back.Pause.OnFullscreen, "OnFullscreen");
                    Assert.AreEqual(true, back.Pause.OnMaximized, "OnMaximized");
                    Assert.AreEqual(false, back.Pause.OnBattery, "OnBattery");
                    Assert.AreEqual("code|notepad", string.Join("|", back.Pause.ForegroundApps), "ForegroundApps");
                    Assert.AreEqual("explorer", string.Join("|", back.Pause.IgnoreApps), "IgnoreApps");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void MissingFile()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "absent.json");
                    var cfg = DojoConfig.Load(path);
                    Assert.AreEqual("http://localhost:7777/", cfg.Url, "Url par defaut");
                    Assert.IsTrue(!File.Exists(path), "Load ne cree pas le fichier");
                    Assert.IsTrue(!File.Exists(path + ".bad"), "pas de backup pour un fichier absent");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void CorruptedFile()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    const string broken = "{ \"Mode\": \"passive\"";
                    TestFiles.Write(path, broken);

                    var cfg = DojoConfig.Load(path);
                    Assert.AreEqual("interactive", cfg.Mode, "defauts apres corruption");
                    Assert.IsTrue(File.Exists(path + ".bad"), "backup .bad cree");
                    Assert.AreEqual(broken, TestFiles.Read(path + ".bad"), "contenu du .bad");
                    Assert.AreEqual(broken, TestFiles.Read(path), "original conserve");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void NonObjectFile()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    TestFiles.Write(path, "[1, 2]");

                    var cfg = DojoConfig.Load(path);
                    Assert.AreEqual("interactive", cfg.Mode, "defauts");
                    Assert.IsTrue(File.Exists(path + ".bad"), "backup .bad cree");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void Normalization()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                DojoConfig cfg;
                Assert.IsTrue(DojoConfig.TryParse("{ \"Mode\": \"Turbo\" }", out cfg), "parse Turbo");
                Assert.AreEqual("interactive", cfg.Mode, "Mode inconnu -> interactive");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Mode\": \"  PASSIVE \" }", out cfg), "parse PASSIVE");
                Assert.AreEqual("passive", cfg.Mode, "Mode casse/espaces");

                Assert.IsTrue(DojoConfig.TryParse("{ \"mode\": \"passive\" }", out cfg), "parse cle minuscule");
                Assert.AreEqual("passive", cfg.Mode, "cle insensible a la casse");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Mode\": 42 }", out cfg), "parse Mode numerique");
                Assert.AreEqual("interactive", cfg.Mode, "Mode non chaine -> interactive");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Zoom\": 5 }", out cfg), "parse Zoom 5");
                Assert.AreEqual(2.0, cfg.Zoom, "Zoom > 2 -> 2");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Zoom\": 0.1 }", out cfg), "parse Zoom 0.1");
                Assert.AreEqual(0.3, cfg.Zoom, "Zoom < 0.3 -> 0.3");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Zoom\": -1 }", out cfg), "parse Zoom -1");
                Assert.AreEqual(0.0, cfg.Zoom, "Zoom negatif -> 0 (auto)");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Zoom\": \"0.5\" }", out cfg), "parse Zoom chaine");
                Assert.AreEqual(0.0, cfg.Zoom, "Zoom chaine ignore -> 0");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Zoom\": 0.8 }", out cfg), "parse Zoom 0.8");
                Assert.AreEqual(0.8, cfg.Zoom, "Zoom valide conserve");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Url\": \"ftp://x/\" }", out cfg), "parse Url ftp");
                Assert.AreEqual("http://localhost:7777/", cfg.Url, "Url non http -> defaut");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Url\": \"   \" }", out cfg), "parse Url vide");
                Assert.AreEqual("http://localhost:7777/", cfg.Url, "Url vide -> defaut");
                Assert.IsTrue(DojoConfig.TryParse("{ \"Url\": \"https://h.example/\" }", out cfg), "parse Url https");
                Assert.AreEqual("https://h.example/", cfg.Url, "Url https conservee");

                Assert.IsTrue(DojoConfig.TryParse("{ \"DisabledScreens\": [1, -2, 1.5, \"a\", 0, 1] }", out cfg), "parse ecrans");
                Assert.AreEqual("1|0", string.Join("|", Array.ConvertAll(cfg.DisabledScreens, x => x.ToString())), "ecrans valides, sans doublon");
            });
        }

        private static void TolerantTypes()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                DojoConfig cfg;
                const string nulls = "{ \"DisabledScreens\": null, \"Pause\": { \"ForegroundApps\": null, \"IgnoreApps\": null, \"OnFullscreen\": \"non\", \"OnBattery\": false } }";
                Assert.IsTrue(DojoConfig.TryParse(nulls, out cfg), "parse listes null");
                Assert.AreEqual(0, cfg.DisabledScreens.Length, "DisabledScreens null -> vide");
                Assert.AreEqual(0, cfg.Pause.ForegroundApps.Length, "ForegroundApps null -> vide");
                Assert.AreEqual(0, cfg.Pause.IgnoreApps.Length, "IgnoreApps null -> vide");
                Assert.IsTrue(cfg.Pause.OnFullscreen, "bool invalide -> defaut");
                Assert.AreEqual(false, cfg.Pause.OnBattery, "bool valide conserve");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Pause\": \"oops\" }", out cfg), "parse Pause invalide");
                Assert.AreEqual(4, cfg.Pause.IgnoreApps.Length, "Pause invalide -> regles par defaut");
                Assert.IsFalse(Array.IndexOf(cfg.Pause.IgnoreApps, "explorer") >= 0, "explorer absent des regles par defaut");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Pause\": { \"IgnoreApps\": [\"  Foo \", \"\", null, 3, \"foo\"] } }", out cfg), "parse IgnoreApps sale");
                Assert.AreEqual("Foo", string.Join("|", cfg.Pause.IgnoreApps), "trim, vides et doublons retires");

                Assert.IsTrue(DojoConfig.TryParse("{ \"Mirror\": \"oui\" }", out cfg), "parse Mirror invalide");
                Assert.AreEqual(true, cfg.Mirror, "Mirror invalide -> defaut");
            });
        }

        private static void EnvironmentUrlNotSaved()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, "http://127.0.0.1:8123/", () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    TestFiles.Write(path, "{ \"Url\": \"http://fichier/\" }");

                    var cfg = DojoConfig.Load(path);
                    Assert.AreEqual("http://127.0.0.1:8123/", cfg.Url, "DOJO_URL surcharge Load");

                    string copy = Path.Combine(dir, "copie.json");
                    cfg.Save(copy);
                    Assert.IsTrue(TestFiles.Read(copy).Contains("\"Url\": \"http://fichier/\""), "Save n'ecrit pas DOJO_URL");

                    cfg.Mode = "passive";
                    cfg.Save(path);
                    string text = TestFiles.Read(path);
                    Assert.IsTrue(text.Contains("\"Url\": \"http://fichier/\""), "Save sur le meme fichier garde l'URL du fichier");
                    Assert.IsTrue(text.Contains("\"Mode\": \"passive\""), "Mode ecrit");

                    cfg.Url = "http://autre/";
                    cfg.Save(copy);
                    Assert.IsTrue(TestFiles.Read(copy).Contains("\"Url\": \"http://autre/\""), "URL modifiee explicitement ecrite");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void InvalidEnvironmentUrl()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, "pas une url", () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    var cfg = DojoConfig.Load(Path.Combine(dir, "absent.json"));
                    Assert.AreEqual("http://localhost:7777/", cfg.Url, "DOJO_URL invalide ignoree");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void Escaping()
        {
            var cfg = new DojoConfig();
            cfg.Pause.ForegroundApps = new[] { "a\"b\\c", "été" };
            DojoConfig back;
            Assert.IsTrue(DojoConfig.TryParse(cfg.ToFileJson(), out back), "JSON echappe valide");
            Assert.AreEqual("a\"b\\c", back.Pause.ForegroundApps[0], "guillemet et antislash");
            Assert.AreEqual("été", back.Pause.ForegroundApps[1], "accents");
        }
    }
}
