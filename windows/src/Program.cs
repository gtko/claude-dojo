using System;
using System.Globalization;
using System.Threading;
using System.Windows.Forms;

namespace DojoWallpaper
{
    internal static class Program
    {
        // Global\ : une seule instance pour toute la machine (toutes sessions confondues).
        // DOJO_INSTANCE (valeur valide) ajoute un suffixe au nom : voir MutexNames.
        private const int MaxExitAfterSeconds = 86400;

        [STAThread]
        private static int Main(string[] args)
        {
            bool core = HasArg(args, "--core");
            bool createdNew;
            using (var mutex = new Mutex(true, MutexNames.FromEnvironment(), out createdNew))
            {
                if (!createdNew)
                {
                    // Deuxieme instance : sortie immediate (trace au journal, sauf en mode --core).
                    if (!core)
                    {
                        DojoLog.Open(HasArg(args, "--log-console"));
                        DojoLog.Write("une instance tourne deja : sortie");
                    }
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (core)
                {
                    RunCore(args);
                    return 0;
                }
                return RunApp(args);
            }
        }

        // Mode normal : configuration, fond, zone de notification, pauses.
        // Options : --log-console (recopie sur la console parente), --exit-after N (sortie propre apres N secondes),
        // --open themes|gallery|wizard (ouvre une page de l'interface au demarrage).
        // Journal : %LOCALAPPDATA%\DojoWallpaper\dojo.log
        private static int RunApp(string[] args)
        {
            DojoLog.Open(HasArg(args, "--log-console"));
            System.Diagnostics.Trace.Listeners.Add(new DojoTraceListener());
            CoreLog.Forward = DojoLog.Write;

            // Exceptions UI : journalisees, la boucle de messages continue (pas de plantage en boucle).
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                DojoLog.Error("exception UI", e.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                DojoLog.Error("exception non geree", e.ExceptionObject as Exception);
            };

            var app = new DojoApp(ReadExitAfter(args), ReadOpenPage(args));
            Application.Run(app);
            DojoLog.Write("processus termine (code " + app.ExitCode + ")");
            return app.ExitCode;
        }

        // Mode test (--core) : le fond seul, sans tray. Options :
        //   --seconds N     sortie propre apres N secondes (defaut : jusqu'a fermeture)
        //   --interactive   mode interactif (defaut en test : passif)
        //   --url U         URL de la page (defaut : celle de DojoConfig)
        //   --pause-test    pause de tous les ecrans a 5 s, reprise a 14 s
        // Journal : %TEMP%\dojo-core.log
        private static void RunCore(string[] args)
        {
            int seconds = 0;
            bool interactive = false;
            bool pauseTest = false;
            string url = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--seconds" && i + 1 < args.Length)
                {
                    seconds = int.Parse(args[++i]);
                }
                else if (args[i] == "--url" && i + 1 < args.Length)
                {
                    url = args[++i];
                }
                else if (args[i] == "--interactive")
                {
                    interactive = true;
                }
                else if (args[i] == "--pause-test")
                {
                    pauseTest = true;
                }
            }

            CoreLog.Enabled = true;
            CoreLog.Reset();
            var cfg = new DojoConfig();
            cfg.Mode = interactive ? "interactive" : "passive";
            if (url != null)
            {
                cfg.Url = url;
            }

            var manager = new WallpaperManager(cfg);
            var context = new ApplicationContext();

            // Demarrage dans le message loop (le SynchronizationContext WinForms est alors installe).
            ScheduleAt(100, delegate
            {
                CoreLog.Write("core: demarrage (url=" + cfg.Url + ", mode=" + cfg.Mode + ")");
                manager.Start();
                if (pauseTest)
                {
                    ScheduleAt(5000, delegate
                    {
                        foreach (var screen in manager.ActiveScreens)
                        {
                            manager.SetPaused(screen, true);
                        }
                        CoreLog.Write("TEST pause: tous les ecrans");
                    });
                    ScheduleAt(14000, delegate
                    {
                        foreach (var screen in manager.ActiveScreens)
                        {
                            manager.SetPaused(screen, false);
                        }
                        CoreLog.Write("TEST reprise: tous les ecrans");
                    });
                }
                if (seconds > 0)
                {
                    ScheduleAt(seconds * 1000, delegate
                    {
                        CoreLog.Write("core: --seconds atteint, sortie");
                        context.ExitThread();
                    });
                }
            });

            Application.Run(context);
            manager.Dispose();
            CoreLog.Write("core: sortie propre");
        }

        private static void ScheduleAt(int milliseconds, Action action)
        {
            var timer = new System.Windows.Forms.Timer { Interval = milliseconds };
            timer.Tick += delegate
            {
                timer.Stop();
                timer.Dispose();
                action();
            };
            timer.Start();
        }

        private static bool HasArg(string[] args, string name)
        {
            return Array.IndexOf(args, name) >= 0;
        }

        // --open themes|gallery|wizard : page de l'interface ouverte au demarrage (demonstration). Inconnue : ignoree.
        private static string ReadOpenPage(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] != "--open")
                {
                    continue;
                }
                if (UiLayout.Find(args[i + 1]) != null)
                {
                    return args[i + 1];
                }
                DojoLog.Write("--open : page inconnue, ignoree");
                return null;
            }
            return null;
        }

        // --exit-after N : N entre 1 et MaxExitAfterSeconds, sinon 0 (pas de sortie automatique).
        private static int ReadExitAfter(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] != "--exit-after")
                {
                    continue;
                }
                int seconds;
                if (int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out seconds)
                    && seconds > 0 && seconds <= MaxExitAfterSeconds)
                {
                    return seconds;
                }
                DojoLog.Write("--exit-after : valeur ignoree");
                return 0;
            }
            return 0;
        }
    }
}
