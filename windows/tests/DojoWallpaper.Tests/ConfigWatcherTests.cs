using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace DojoWallpaper.Tests
{
    internal static class ConfigWatcherTests
    {
        private const string PassiveJson = "{ \"Mode\": \"passive\" }";

        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(Case("ConfigWatcher : cree le fichier avec les defauts s'il manque", CreatesMissingFile));
            list.Add(Case("ConfigWatcher : hot reload -> Changed < 2 s sur le contexte UI", HotReload));
            list.Add(Case("ConfigWatcher : remplacement atomique et renommage detectes", AtomicReplace));
            list.Add(Case("ConfigWatcher : rafale d'ecritures -> un seul Changed (debounce)", BurstIsDebounced));
            list.Add(Case("ConfigWatcher : Save n'emet pas Changed et met Current a jour", SaveDoesNotLoop));
            list.Add(Case("ConfigWatcher : fichier corrompu au demarrage -> defauts + .bad", CorruptedAtStartup));
            return list;
        }

        private static KeyValuePair<string, Action> Case(string name, Action action)
        {
            return new KeyValuePair<string, Action>(name, action);
        }

        // Contexte de synchronisation de test : Post met le callback en file, Pump l'execute sur le thread de test
        // (equivalent d'une boucle de messages).
        internal sealed class PumpContext : SynchronizationContext
        {
            private readonly ConcurrentQueue<Action> _queue = new ConcurrentQueue<Action>();
            private int _posts;

            public int PostCount
            {
                get { return Thread.VolatileRead(ref _posts); }
            }

            public override void Post(SendOrPostCallback d, object state)
            {
                Interlocked.Increment(ref _posts);
                _queue.Enqueue(() => d(state));
            }

            public void Pump()
            {
                Action action;
                while (_queue.TryDequeue(out action))
                {
                    action();
                }
            }

            // Pompe jusqu'a ce que la condition soit vraie ou que le delai expire.
            public bool WaitFor(Func<bool> condition, int timeoutMs)
            {
                var clock = Stopwatch.StartNew();
                while (true)
                {
                    Pump();
                    if (condition())
                    {
                        return true;
                    }
                    if (clock.ElapsedMilliseconds >= timeoutMs)
                    {
                        return false;
                    }
                    Thread.Sleep(10);
                }
            }
        }

        private static void RunWithContext(Action<PumpContext> body)
        {
            SynchronizationContext previous = SynchronizationContext.Current;
            var ctx = new PumpContext();
            SynchronizationContext.SetSynchronizationContext(ctx);
            try
            {
                body(ctx);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }
        }

        private static void CreatesMissingFile()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "sous-dossier", "dojo-wallpaper.json");
                    using (var watcher = new ConfigWatcher(path))
                    {
                        Assert.IsTrue(File.Exists(path), "fichier cree");
                        Assert.AreEqual("interactive", watcher.Current.Mode, "defauts");
                        Assert.AreEqual("http://localhost:7777/", watcher.Current.Url, "Url par defaut");
                        watcher.Dispose();
                        watcher.Dispose();
                    }
                    Assert.AreEqual("http://localhost:7777/", DojoConfig.Load(path).Url, "fichier relisible");
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }

        private static void HotReload()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () => RunWithContext(ctx =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    using (var watcher = new ConfigWatcher(path))
                    {
                        DojoConfig received = null;
                        watcher.Changed += c => received = c;

                        TestFiles.Write(path, PassiveJson);
                        bool ok = ctx.WaitFor(() => received != null, 2000);

                        Assert.IsTrue(ok, "Changed recu en moins de 2 s");
                        Assert.IsTrue(ctx.PostCount > 0, "Changed poste sur le contexte UI");
                        Assert.AreEqual("passive", received.Mode, "Mode recharge");
                        Assert.AreEqual("passive", watcher.Current.Mode, "Current mis a jour");
                    }
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            }));
        }

        private static void AtomicReplace()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () => RunWithContext(ctx =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    string temp = path + ".edit";
                    using (var watcher = new ConfigWatcher(path))
                    {
                        int count = 0;
                        DojoConfig last = null;
                        watcher.Changed += c =>
                        {
                            count++;
                            last = c;
                        };

                        // Ecriture dans un fichier voisin puis remplacement : schema des editeurs.
                        TestFiles.Write(temp, PassiveJson);
                        File.Replace(temp, path, null);
                        Assert.IsTrue(ctx.WaitFor(() => count >= 1, 2000), "Changed apres remplacement");
                        Assert.AreEqual("passive", last.Mode, "Mode apres remplacement");

                        // Suppression puis renommage du fichier voisin.
                        TestFiles.Write(temp, "{ \"Mode\": \"interactive\", \"Zoom\": 0.8 }");
                        File.Delete(path);
                        File.Move(temp, path);
                        Assert.IsTrue(ctx.WaitFor(() => count >= 2, 2000), "Changed apres renommage");
                        Assert.AreEqual(0.8, last.Zoom, "Zoom apres renommage");
                    }
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            }));
        }

        private static void BurstIsDebounced()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () => RunWithContext(ctx =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    using (var watcher = new ConfigWatcher(path))
                    {
                        int count = 0;
                        DojoConfig last = null;
                        watcher.Changed += c =>
                        {
                            count++;
                            last = c;
                        };

                        TestFiles.Write(path, "{ \"Zoom\": 0.5 }");
                        TestFiles.Write(path, "{ \"Zoom\": 0.6 }");
                        TestFiles.Write(path, "{ \"Zoom\": 0.9 }");
                        Assert.IsTrue(ctx.WaitFor(() => count >= 1, 2000), "Changed recu");
                        ctx.WaitFor(() => false, 800);

                        Assert.AreEqual(1, count, "rafale -> un seul Changed");
                        Assert.AreEqual(0.9, last.Zoom, "valeur finale");
                    }
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            }));
        }

        private static void SaveDoesNotLoop()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () => RunWithContext(ctx =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    using (var watcher = new ConfigWatcher(path))
                    {
                        int count = 0;
                        watcher.Changed += c => count++;

                        var cfg = new DojoConfig();
                        cfg.Mode = "passive";
                        cfg.Zoom = 0.5;
                        watcher.Save(cfg);
                        ctx.WaitFor(() => false, 900);

                        Assert.AreEqual(0, count, "Save n'emet pas Changed");
                        Assert.AreEqual("passive", watcher.Current.Mode, "Current Mode");
                        Assert.AreEqual(0.5, watcher.Current.Zoom, "Current Zoom");
                        Assert.IsTrue(TestFiles.Read(path).Contains("\"Mode\": \"passive\""), "fichier ecrit");
                    }
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            }));
        }

        private static void CorruptedAtStartup()
        {
            TestFiles.WithEnv(DojoConfig.UrlEnvironmentVariable, null, () =>
            {
                string dir = TestFiles.NewDir();
                try
                {
                    string path = Path.Combine(dir, "dojo-wallpaper.json");
                    TestFiles.Write(path, "{ casse");
                    using (var watcher = new ConfigWatcher(path))
                    {
                        Assert.AreEqual("interactive", watcher.Current.Mode, "defauts");
                        Assert.IsTrue(File.Exists(path + ".bad"), "backup .bad");
                    }
                }
                finally
                {
                    TestFiles.DeleteDir(dir);
                }
            });
        }
    }
}
