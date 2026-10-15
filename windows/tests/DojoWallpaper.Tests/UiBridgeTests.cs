using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace DojoWallpaper.Tests
{
    // Dispatch du pont (messages, source, actions natives, URL) avec un hote simule, et disposition des pages (UiLayout).
    internal static class UiBridgeTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("UiBridge : source non approuvee refusee", UntrustedSource));
            list.Add(new KeyValuePair<string, Action>("UiBridge : message mal forme (JSON, id, kind)", MalformedMessage));
            list.Add(new KeyValuePair<string, Action>("UiBridge : commande valide routee, reponse avec le meme id", ValidCommand));
            list.Add(new KeyValuePair<string, Action>("UiBridge : commande refusee sans appel a l'hote", RefusedCommand));
            list.Add(new KeyValuePair<string, Action>("UiBridge : arguments entiers convertis, non-listes refusees", ArgumentShapes));
            list.Add(new KeyValuePair<string, Action>("UiBridge : action native inconnue", UnknownNative));
            list.Add(new KeyValuePair<string, Action>("UiBridge : openUrl https et hotes de la liste blanche seulement", OpenUrlRules));
            list.Add(new KeyValuePair<string, Action>("UiBridge : titres, autostart, reloadWallpaper et pickFile routes", OtherNatives));
            list.Add(new KeyValuePair<string, Action>("UiBridge : exception de l'hote devient ok:false", HostException));
            list.Add(new KeyValuePair<string, Action>("UiBridge : IsTrustedUrl n'accepte que https://dojo-ui.local/", TrustedUrl));
            list.Add(new KeyValuePair<string, Action>("UiBridge : openWindow, page inconnue et theme invalide refusees sans appel a l'hote", OpenWindowRefusals));
            list.Add(new KeyValuePair<string, Action>("UiBridge : openWindow, page de la liste blanche et theme optionnel routes", OpenWindowDispatch));
            list.Add(new KeyValuePair<string, Action>("UiBridge : identifiant de theme (regex) et query ?theme= reservee a la galerie", ThemeIdAndQuery));
            list.Add(new KeyValuePair<string, Action>("UiLayout : pages et recherche par nom", LayoutPages));
            list.Add(new KeyValuePair<string, Action>("UiLayout : dossier windows\\ui trouve depuis bin ou build", LayoutUiDir));
            list.Add(new KeyValuePair<string, Action>("UiLayout : dossier d'installation comme setup.js", LayoutInstall));
            return list;
        }

        // Hote simule : enregistre les appels, renvoie des reponses fixes.
        private sealed class FakeHost : IBridgeHost
        {
            public readonly List<BridgeCall> Calls = new List<BridgeCall>();
            public readonly List<string> Events = new List<string>();
            public bool ThrowOnSetup;

            public Task<IDictionary<string, object>> RunSetupAsync(BridgeCall call)
            {
                if (ThrowOnSetup)
                {
                    throw new InvalidOperationException("boom");
                }
                Calls.Add(call);
                return Task.FromResult<IDictionary<string, object>>(Obj("ok", true, "echo", call.Command));
            }

            public IDictionary<string, object> PickFile()
            {
                Events.Add("pickFile");
                return Obj("ok", true, "path", null);
            }

            public IDictionary<string, object> PickFolder()
            {
                Events.Add("pickFolder");
                return Obj("ok", true, "path", null);
            }

            public IDictionary<string, object> OpenUrl(string url)
            {
                Events.Add("openUrl:" + url);
                return Obj("ok", true);
            }

            public IDictionary<string, object> CloseWindow()
            {
                Events.Add("close");
                return Obj("ok", true);
            }

            public IDictionary<string, object> SetTitle(string title)
            {
                Events.Add("setTitle:" + title);
                return Obj("ok", true);
            }

            public IDictionary<string, object> GetEnv()
            {
                Events.Add("getEnv");
                return Obj("ok", true, "platform", "win32");
            }

            public IDictionary<string, object> GetAutostart()
            {
                Events.Add("autostart.get");
                return Obj("ok", true, "enabled", false);
            }

            public IDictionary<string, object> SetAutostart(bool enabled)
            {
                Events.Add("autostart.set:" + enabled);
                return Obj("ok", true, "enabled", enabled);
            }

            public IDictionary<string, object> ReloadWallpaper()
            {
                Events.Add("reloadWallpaper");
                return Obj("ok", true);
            }

            public IDictionary<string, object> OpenWindow(string page, string theme)
            {
                Events.Add("openWindow:" + page + ":" + (theme ?? "-"));
                return Obj("ok", true);
            }
        }

        private static IDictionary<string, object> Obj(params object[] pairs)
        {
            var dict = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                dict[(string)pairs[i]] = pairs[i + 1];
            }
            return dict;
        }

        private const string UiSource = "https://dojo-ui.local/themes.html";

        // Envoie un message et renvoie la reponse decodee { id, result }.
        private static IDictionary<string, object> Send(FakeHost host, string source, string json, out int posts)
        {
            var sent = new List<string>();
            var bridge = new UiBridge(host, sent.Add);
            bridge.HandleAsync(source, json).Wait();
            posts = sent.Count;
            Assert.AreEqual(1, sent.Count, "une seule reponse pour : " + json);
            return JsonText.ParseObject(sent[0]);
        }

        private static IDictionary<string, object> Result(IDictionary<string, object> envelope)
        {
            return (IDictionary<string, object>)envelope["result"];
        }

        private static void UntrustedSource()
        {
            var host = new FakeHost();
            int posts;
            string json = "{\"id\":1,\"kind\":\"cmd\",\"cmd\":\"themes\",\"args\":[]}";
            foreach (string source in new[] { "https://evil.example/", "http://dojo-ui.local/themes.html", "https://dojo-ui.local.evil.com/", string.Empty })
            {
                IDictionary<string, object> envelope = Send(host, source, json, out posts);
                Assert.IsFalse((bool)Result(envelope)["ok"], "refus pour la source : " + source);
            }
            Assert.AreEqual(0, host.Calls.Count, "l'hote n'est jamais appele");
        }

        private static void MalformedMessage()
        {
            var host = new FakeHost();
            int posts;
            IDictionary<string, object> noJson = Send(host, UiSource, "pas du json", out posts);
            Assert.IsTrue(noJson["id"] == null, "id nul sans message lisible");
            Assert.AreEqual("message invalide.", (string)Result(noJson)["error"], "message invalide");

            IDictionary<string, object> noId = Send(host, UiSource, "{\"kind\":\"cmd\",\"cmd\":\"themes\"}", out posts);
            Assert.AreEqual("identifiant de requête manquant.", (string)Result(noId)["error"], "sans id");

            IDictionary<string, object> stringId = Send(host, UiSource, "{\"id\":\"abc\",\"kind\":\"cmd\",\"cmd\":\"themes\"}", out posts);
            Assert.AreEqual("identifiant de requête manquant.", (string)Result(stringId)["error"], "id texte");

            IDictionary<string, object> unknownKind = Send(host, UiSource, "{\"id\":4,\"kind\":\"x\"}", out posts);
            Assert.AreEqual(4, (int)unknownKind["id"], "id renvoye");
            Assert.AreEqual("type de message inconnu.", (string)Result(unknownKind)["error"], "type inconnu");
            Assert.AreEqual(0, host.Calls.Count, "rien n'est execute");
        }

        private static void ValidCommand()
        {
            var host = new FakeHost();
            int posts;
            IDictionary<string, object> envelope = Send(host, UiSource, "{\"id\":7,\"kind\":\"cmd\",\"cmd\":\"themes\",\"args\":[]}", out posts);
            Assert.AreEqual(7, (int)envelope["id"], "id de correlation");
            IDictionary<string, object> result = Result(envelope);
            Assert.IsTrue((bool)result["ok"], "ok");
            Assert.AreEqual("themes", (string)result["echo"], "reponse de l'hote");
            Assert.AreEqual(1, host.Calls.Count, "un appel");
            Assert.AreEqual("themes", string.Join("|", host.Calls[0].Argv), "argv");
            Assert.AreEqual(30, host.Calls[0].TimeoutSeconds, "delai");
        }

        private static void RefusedCommand()
        {
            var host = new FakeHost();
            int posts;
            string[] messages =
            {
                "{\"id\":2,\"kind\":\"cmd\",\"cmd\":\"window-zone\",\"args\":[]}",
                "{\"id\":2,\"kind\":\"cmd\",\"cmd\":\"set-theme\",\"args\":[\"a;b\"]}",
                "{\"id\":2,\"kind\":\"cmd\",\"cmd\":\"themes\",\"args\":[],\"stdin\":\"{}\"}",
                "{\"id\":2,\"kind\":\"cmd\",\"cmd\":\"write-config\",\"args\":[\"{}\"],\"stdin\":\"{}\"}",
            };
            foreach (string json in messages)
            {
                IDictionary<string, object> envelope = Send(host, UiSource, json, out posts);
                IDictionary<string, object> result = Result(envelope);
                Assert.IsFalse((bool)result["ok"], "refus : " + json);
                Assert.IsTrue(((string)result["error"]).Length > 0, "message lisible");
            }
            Assert.AreEqual(0, host.Calls.Count, "aucun appel a setup.js");
        }

        private static void ArgumentShapes()
        {
            var host = new FakeHost();
            int posts;
            Send(host, UiSource, "{\"id\":3,\"kind\":\"cmd\",\"cmd\":\"wallpapers\",\"args\":[\"search\",\"demo\",2]}", out posts);
            Assert.AreEqual("wallpapers|search|demo|2", string.Join("|", host.Calls[0].Argv), "entier converti");

            IDictionary<string, object> asText = Result(Send(host, UiSource, "{\"id\":3,\"kind\":\"cmd\",\"cmd\":\"set-theme\",\"args\":\"demo\"}", out posts));
            Assert.IsFalse((bool)asText["ok"], "args en texte refuse");

            IDictionary<string, object> asBool = Result(Send(host, UiSource, "{\"id\":3,\"kind\":\"cmd\",\"cmd\":\"set-theme\",\"args\":[true]}", out posts));
            Assert.IsFalse((bool)asBool["ok"], "argument booleen refuse");
            Assert.AreEqual(1, host.Calls.Count, "seul l'appel valide est execute");
        }

        private static void UnknownNative()
        {
            var host = new FakeHost();
            int posts;
            IDictionary<string, object> result = Result(Send(host, UiSource, "{\"id\":5,\"kind\":\"native\",\"action\":\"rm\",\"payload\":{}}", out posts));
            Assert.IsFalse((bool)result["ok"], "action inconnue refusee");
            Assert.IsTrue(((string)result["error"]).Contains("rm"), "nom de l'action dans le message");
            Assert.AreEqual(0, host.Events.Count, "rien n'est fait");
        }

        private static void OpenUrlRules()
        {
            var host = new FakeHost();
            int posts;
            string[] refused =
            {
                "http://github.com/x",
                "https://evil.example/",
                "https://user:pw@github.com/",
                "https://github.com.evil.example/",
                "javascript:alert(1)",
                "file:///C:/Windows/win.ini",
                "pas une url",
            };
            foreach (string url in refused)
            {
                string json = "{\"id\":6,\"kind\":\"native\",\"action\":\"openUrl\",\"payload\":{\"url\":\"" + url + "\"}}";
                IDictionary<string, object> result = Result(Send(host, UiSource, json, out posts));
                Assert.IsFalse((bool)result["ok"], "refus de : " + url);
            }
            Assert.AreEqual(0, host.Events.Count, "aucune ouverture");

            IDictionary<string, object> ok = Result(Send(host, UiSource,
                "{\"id\":6,\"kind\":\"native\",\"action\":\"openUrl\",\"payload\":{\"url\":\"https://GitHub.com/gtko/claude-dojo\"}}", out posts));
            Assert.IsTrue((bool)ok["ok"], "hote de la liste accepte");
            Assert.AreEqual("openUrl:https://github.com/gtko/claude-dojo", host.Events[0], "URL normalisee transmise");
        }

        private static void OtherNatives()
        {
            var host = new FakeHost();
            int posts;
            IDictionary<string, object> emptyTitle = Result(Send(host, UiSource,
                "{\"id\":8,\"kind\":\"native\",\"action\":\"setTitle\",\"payload\":{\"title\":\"  \"}}", out posts));
            Assert.IsFalse((bool)emptyTitle["ok"], "titre vide refuse");

            IDictionary<string, object> badBool = Result(Send(host, UiSource,
                "{\"id\":8,\"kind\":\"native\",\"action\":\"autostart.set\",\"payload\":{\"enabled\":\"oui\"}}", out posts));
            Assert.IsFalse((bool)badBool["ok"], "enabled non booleen refuse");

            Send(host, UiSource, "{\"id\":9,\"kind\":\"native\",\"action\":\"autostart.set\",\"payload\":{\"enabled\":true}}", out posts);
            Send(host, UiSource, "{\"id\":10,\"kind\":\"native\",\"action\":\"setTitle\",\"payload\":{\"title\":\"Thème\"}}", out posts);
            Send(host, UiSource, "{\"id\":11,\"kind\":\"native\",\"action\":\"reloadWallpaper\"}", out posts);
            Send(host, UiSource, "{\"id\":12,\"kind\":\"native\",\"action\":\"pickFile\"}", out posts);
            Send(host, UiSource, "{\"id\":13,\"kind\":\"native\",\"action\":\"close\"}", out posts);
            Send(host, UiSource, "{\"id\":14,\"kind\":\"native\",\"action\":\"getEnv\"}", out posts);

            string events = string.Join("|", host.Events);
            Assert.AreEqual("autostart.set:True|setTitle:Thème|reloadWallpaper|pickFile|close|getEnv", events, "actions routees");
        }

        private static void HostException()
        {
            var host = new FakeHost { ThrowOnSetup = true };
            int posts;
            IDictionary<string, object> result = Result(Send(host, UiSource, "{\"id\":15,\"kind\":\"cmd\",\"cmd\":\"themes\",\"args\":[]}", out posts));
            Assert.IsFalse((bool)result["ok"], "ok:false");
            Assert.IsTrue(((string)result["error"]).StartsWith("erreur interne", StringComparison.Ordinal), "message interne");
        }

        private static void TrustedUrl()
        {
            Assert.IsTrue(UiBridge.IsTrustedUrl("https://dojo-ui.local/themes.html"), "page de l'interface");
            Assert.IsTrue(UiBridge.IsTrustedUrl("https://DOJO-UI.local/"), "hote insensible a la casse");
            Assert.IsFalse(UiBridge.IsTrustedUrl("http://dojo-ui.local/themes.html"), "http refuse");
            Assert.IsFalse(UiBridge.IsTrustedUrl("https://dojo-ui.local.evil.com/"), "sous-domaine piege");
            Assert.IsFalse(UiBridge.IsTrustedUrl("https://evil.com/dojo-ui.local"), "chemin piege");
            Assert.IsFalse(UiBridge.IsTrustedUrl("https://dojo-themes.local/a/b.png"), "autre hote mappe");
            Assert.IsFalse(UiBridge.IsTrustedUrl(null), "null");
        }

        private static string OpenWindowMessage(int id, string payload)
        {
            return "{\"id\":" + id + ",\"kind\":\"native\",\"action\":\"openWindow\",\"payload\":" + payload + "}";
        }

        private static void OpenWindowRefusals()
        {
            var host = new FakeHost();
            int posts;
            string tooLong = "a" + new string('b', 40);
            string[] refused =
            {
                "{\"page\":\"nope\"}",
                "{\"page\":\"Themes\"}",
                "{\"page\":\"../themes\"}",
                "{}",
                "{\"page\":7}",
                "{\"page\":\"gallery\",\"theme\":\"Naruto\"}",
                "{\"page\":\"gallery\",\"theme\":\"../etc\"}",
                "{\"page\":\"gallery\",\"theme\":\"\"}",
                "{\"page\":\"gallery\",\"theme\":\"-naruto\"}",
                "{\"page\":\"gallery\",\"theme\":\"" + tooLong + "\"}",
                "{\"page\":\"gallery\",\"theme\":7}",
                "{\"page\":\"themes\",\"theme\":true}",
            };
            foreach (string payload in refused)
            {
                IDictionary<string, object> result = Result(Send(host, UiSource, OpenWindowMessage(16, payload), out posts));
                Assert.IsFalse((bool)result["ok"], "refus : " + payload);
                Assert.IsTrue(((string)result["error"]).Length > 0, "message lisible : " + payload);
            }
            Assert.AreEqual(0, host.Events.Count, "l'hote n'ouvre rien");
        }

        private static void OpenWindowDispatch()
        {
            var host = new FakeHost();
            int posts;
            IDictionary<string, object> gallery = Result(Send(host, UiSource, OpenWindowMessage(17, "{\"page\":\"gallery\",\"theme\":\"naruto\"}"), out posts));
            Assert.IsTrue((bool)gallery["ok"], "galerie avec theme");
            IDictionary<string, object> themes = Result(Send(host, UiSource, OpenWindowMessage(18, "{\"page\":\"themes\"}"), out posts));
            Assert.IsTrue((bool)themes["ok"], "page themes sans theme");
            IDictionary<string, object> wizard = Result(Send(host, UiSource, OpenWindowMessage(19, "{\"page\":\"wizard\",\"theme\":null}"), out posts));
            Assert.IsTrue((bool)wizard["ok"], "assistant, theme nul");
            IDictionary<string, object> edge = Result(Send(host, UiSource, OpenWindowMessage(20, "{\"page\":\"gallery\",\"theme\":\"a" + new string('0', 39) + "\"}"), out posts));
            Assert.IsTrue((bool)edge["ok"], "theme de 40 caracteres accepte");

            string expected = "openWindow:gallery:naruto|openWindow:themes:-|openWindow:wizard:-|openWindow:gallery:a" + new string('0', 39);
            Assert.AreEqual(expected, string.Join("|", host.Events), "pages et themes transmis à l'hôte");
        }

        private static void ThemeIdAndQuery()
        {
            Assert.IsTrue(UiBridge.IsValidThemeId("naruto"), "nom simple");
            Assert.IsTrue(UiBridge.IsValidThemeId("dojo_2-x"), "tiret et souligné");
            Assert.IsFalse(UiBridge.IsValidThemeId("naruto\n"), "saut de ligne final refusé");
            Assert.IsFalse(UiBridge.IsValidThemeId("naruto&x=1"), "caractère de query refusé");
            Assert.IsFalse(UiBridge.IsValidThemeId(null), "null");

            Assert.AreEqual("?theme=naruto", UiBridge.WindowQuery("gallery", "naruto"), "query de la galerie");
            Assert.AreEqual(string.Empty, UiBridge.WindowQuery("gallery", null), "galerie sans theme");
            Assert.AreEqual(string.Empty, UiBridge.WindowQuery("themes", "naruto"), "pas de query hors galerie");
        }

        private static void LayoutPages()
        {
            UiPage themes = UiLayout.Find("themes");
            Assert.IsTrue(themes != null, "page themes");
            Assert.AreEqual("themes.html", themes.File, "fichier");
            Assert.AreEqual(980, themes.Size.Width, "largeur");
            Assert.AreEqual(560, themes.MinSize.Height, "hauteur minimale");
            Assert.IsTrue(UiLayout.Find("gallery") != null && UiLayout.Find("wizard") != null, "autres pages");
            Assert.IsTrue(UiLayout.Find("nope") == null, "page inconnue");
            Assert.IsTrue(UiLayout.Find(null) == null, "null");
            Assert.IsTrue(UiLayout.Find("Themes") == null, "casse exacte");
        }

        private static void LayoutUiDir()
        {
            string root = TestFiles.NewDir();
            try
            {
                string ui = Path.Combine(root, "windows", "ui");
                Directory.CreateDirectory(ui);
                TestFiles.Write(Path.Combine(ui, "common.css"), "/* test */");
                string bin = Path.Combine(root, "windows", "bin") + Path.DirectorySeparatorChar;
                string build = Path.Combine(root, "windows", "build", "Release", "net48") + Path.DirectorySeparatorChar;
                Directory.CreateDirectory(bin);
                Directory.CreateDirectory(build);

                string expected = Path.GetFullPath(ui);
                Assert.AreEqual(expected, UiLayout.UiDirFrom(bin), "depuis bin (installation)");
                Assert.AreEqual(expected, UiLayout.UiDirFrom(build), "depuis build (developpement)");
            }
            finally
            {
                TestFiles.DeleteDir(root);
            }
        }

        private static void LayoutInstall()
        {
            Assert.AreEqual(@"C:\Users\Jean\.config\claude-dojo", UiLayout.InstallDirFor(@"C:\Users\Jean"), "dossier d'installation");
            Assert.IsTrue(UiLayout.SetupScriptFor(@"C:\x").EndsWith("setup.js", StringComparison.Ordinal), "setup.js");
            Assert.AreEqual(@"C:\x\backgrounds", UiLayout.BackgroundsDirFor(@"C:\x"), "fonds");
            Assert.AreEqual(@"C:\x\themes", UiLayout.ThemesDirFor(@"C:\x"), "themes");
        }
    }
}
