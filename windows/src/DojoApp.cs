using System;
using System.Collections.Generic;
using System.Globalization;
using System.Windows.Forms;

namespace DojoWallpaper
{
    // Cablage de l'application (mode normal) : configuration (ConfigWatcher), fond (WallpaperManager),
    // zone de notification (TrayController) et pauses (PauseEngine). Tout tourne sur le thread UI.
    // L'initialisation est differee d'un tick : le SynchronizationContext WinForms n'est installe
    // qu'une fois la boucle de messages lancee (Application.Run).
    internal sealed class DojoApp : ApplicationContext
    {
        private readonly System.Windows.Forms.Timer _startTimer;
        private readonly System.Windows.Forms.Timer _exitTimer;
        // Derniere raison connue par ecran (nom de peripherique -> raison).
        private readonly Dictionary<string, PauseReason> _reasons =
            new Dictionary<string, PauseReason>(StringComparer.OrdinalIgnoreCase);
        private ConfigWatcher _watcher;
        private WallpaperManager _manager;
        private TrayController _tray;
        private PauseEngine _engine;
        private bool _quitting;

        // exitAfterSeconds > 0 : sortie automatique, par le meme chemin que le menu Quitter (tests automatises).
        public DojoApp(int exitAfterSeconds)
        {
            _startTimer = new System.Windows.Forms.Timer { Interval = 1 };
            _startTimer.Tick += delegate
            {
                _startTimer.Stop();
                Start();
            };
            _startTimer.Start();

            if (exitAfterSeconds > 0)
            {
                _exitTimer = new System.Windows.Forms.Timer { Interval = exitAfterSeconds * 1000 };
                _exitTimer.Tick += delegate
                {
                    _exitTimer.Stop();
                    DojoLog.Write("--exit-after : delai atteint");
                    Quit();
                };
                _exitTimer.Start();
            }
        }

        // 0 = sortie normale ; 1 = echec au demarrage.
        public int ExitCode { get; private set; }

        // Sortie propre (menu Quitter, --exit-after, echec de demarrage) : moteur de pause, fenetres,
        // icone de zone de notification, puis fichier de config. Idempotent.
        public void Quit()
        {
            if (_quitting)
            {
                return;
            }
            _quitting = true;
            DojoLog.Write("sortie");

            Release(_engine, "moteur de pause");
            Release(_manager, "fond d'ecran");
            Release(_tray, "zone de notification");
            Release(_watcher, "configuration");
            Release(_startTimer, "minuteur");
            Release(_exitTimer, "minuteur de sortie");

            Application.Exit();
        }

        private void Start()
        {
            try
            {
                DojoLog.Write("lancement (version " + typeof(DojoApp).Assembly.GetName().Version + ")");

                _watcher = new ConfigWatcher(DojoConfig.DefaultPath);
                DojoConfig cfg = _watcher.Current;
                _watcher.Changed += OnConfigChanged;

                _manager = new WallpaperManager(cfg);
                _manager.Start();

                _tray = new TrayController(cfg, DojoConfig.DefaultPath);
                _tray.ModeChanged += OnModeChanged;
                _tray.MirrorToggled += OnMirrorToggled;
                _tray.ManualPauseToggled += OnManualPauseToggled;
                _tray.ReloadRequested += OnReloadRequested;
                _tray.OpenConfigRequested += delegate { DojoLog.Write("ouverture de la config"); };
                _tray.AutostartToggled += OnAutostartToggled;
                _tray.QuitRequested += Quit;
                DojoLog.Write("zone de notification : icone creee");

                _engine = new PauseEngine(() => _watcher.Current);
                _engine.ScreenChanged += OnScreenChanged;
                _manager.ScreensRebuilt += OnScreensRebuilt;

                DojoLog.Write("configuration : url " + DojoLog.Redact(cfg.Url) + ", mode " + cfg.Mode
                    + ", ecrans " + Screen.AllScreens.Length);
                UpdateStatus();
            }
            catch (Exception ex)
            {
                DojoLog.Error("demarrage", ex);
                ExitCode = 1;
                Quit();
            }
        }

        private void OnConfigChanged(DojoConfig cfg)
        {
            Guard("rechargement de la config", delegate
            {
                _manager.ApplyConfig(cfg);
                _tray.UpdateConfig(cfg);
                DojoLog.Write("config rechargee : url " + DojoLog.Redact(cfg.Url) + ", mode " + cfg.Mode);
            });
        }

        // Changement de mode depuis la zone de notification : ecrit la config puis l'applique a chaud.
        private void OnModeChanged(string mode)
        {
            Guard("changement de mode", delegate
            {
                DojoConfig next;
                if (!DojoConfig.TryParse(_watcher.Current.ToFileJson(), out next))
                {
                    return;
                }
                next.Mode = DojoConfig.NormalizeMode(mode);
                _watcher.Save(next);
                DojoConfig applied = _watcher.Current;
                _manager.ApplyConfig(applied);
                _tray.UpdateConfig(applied);
                DojoLog.Write("mode : " + applied.Mode);
            });
        }

        // Inversion gauche / droite depuis la zone de notification : ecrit la config puis l'applique a chaud.
        // ApplyConfig repousse la zone sure a chaque fenetre (setSafe force), meme si la zone n'a pas change.
        private void OnMirrorToggled(bool mirror)
        {
            Guard("inversion gauche / droite", delegate
            {
                DojoConfig next;
                if (!DojoConfig.TryParse(_watcher.Current.ToFileJson(), out next))
                {
                    return;
                }
                next.Mirror = mirror;
                _watcher.Save(next);
                DojoConfig applied = _watcher.Current;
                _manager.ApplyConfig(applied);
                _tray.UpdateConfig(applied);
                DojoLog.Write("inversion gauche / droite : " + (applied.Mirror ? "activee" : "desactivee"));
            });
        }

        private void OnManualPauseToggled(bool paused)
        {
            Guard("pause manuelle", delegate
            {
                _engine.ManualPause = paused;
                _tray.SetPaused(paused);
                DojoLog.Write("pause manuelle : " + (paused ? "activee" : "desactivee"));
            });
        }

        private void OnReloadRequested()
        {
            Guard("rechargement des pages", delegate
            {
                _manager.Reload();
                DojoLog.Write("rechargement des pages");
            });
        }

        private void OnAutostartToggled(bool enable)
        {
            Guard("demarrage avec Windows", delegate
            {
                if (enable)
                {
                    Autostart.Enable(Application.ExecutablePath);
                }
                else
                {
                    Autostart.Disable();
                }
                DojoLog.Write("demarrage avec Windows : " + (enable ? "active" : "desactive"));
            });
        }

        // Raison de pause d'un ecran : pause ou reprise du fond sur cet ecran, puis tooltip.
        private void OnScreenChanged(Screen screen, PauseReason reason)
        {
            Guard("pause d'ecran", delegate
            {
                _reasons[screen.DeviceName] = reason;
                _manager.SetPaused(screen, reason != PauseReason.None);
                DojoLog.Write("ecran " + ScreenIndex(screen) + " : " + ReasonLabel(reason));
                UpdateStatus();
            });
        }

        // Ecrans reconstruits (branchement, resolution, veille) : recalcul, puis pauses reappliquees ecran par ecran.
        private void OnScreensRebuilt()
        {
            Guard("reconstruction des ecrans", delegate
            {
                _engine.Refresh();
                _reasons.Clear();
                foreach (Screen screen in Screen.AllScreens)
                {
                    PauseReason reason = _engine.GetReason(screen);
                    _reasons[screen.DeviceName] = reason;
                    _manager.SetPaused(screen, reason != PauseReason.None);
                }
                DojoLog.Write("ecrans reconstruits : " + Screen.AllScreens.Length);
                UpdateStatus();
            });
        }

        // Tooltip : "Dojo : actif", "Dojo : pause (plein écran)", "Dojo : pause partielle".
        private void UpdateStatus()
        {
            int paused = 0;
            bool sameReason = true;
            PauseReason first = PauseReason.None;
            foreach (PauseReason reason in _reasons.Values)
            {
                if (reason == PauseReason.None)
                {
                    continue;
                }
                if (paused == 0)
                {
                    first = reason;
                }
                else if (reason != first)
                {
                    sameReason = false;
                }
                paused++;
            }

            string text;
            if (paused == 0)
            {
                text = "Dojo : actif";
            }
            else if (sameReason && paused == _reasons.Count)
            {
                text = "Dojo : pause (" + ReasonLabel(first) + ")";
            }
            else
            {
                text = "Dojo : pause partielle";
            }
            _tray.SetStatus(text);
        }

        private static string ReasonLabel(PauseReason reason)
        {
            switch (reason)
            {
                case PauseReason.Fullscreen: return "plein écran";
                case PauseReason.Maximized: return "fenêtre maximisée";
                case PauseReason.Battery: return "sur batterie";
                case PauseReason.BatterySaver: return "économiseur de batterie";
                case PauseReason.Manual: return "pause manuelle";
                case PauseReason.ForegroundApp: return "application au premier plan";
                default: return "actif";
            }
        }

        // Numero d'ecran tel que dans les noms de fenetre (DojoWallpaper-N).
        private static string ScreenIndex(Screen screen)
        {
            Screen[] all = Screen.AllScreens;
            for (int i = 0; i < all.Length; i++)
            {
                if (string.Equals(all[i].DeviceName, screen.DeviceName, StringComparison.OrdinalIgnoreCase))
                {
                    return i.ToString(CultureInfo.InvariantCulture);
                }
            }
            return "?";
        }

        // Un gestionnaire qui echoue ne doit jamais remonter a la boucle de messages : erreur journalisee.
        private void Guard(string what, Action action)
        {
            if (_quitting)
            {
                return;
            }
            try
            {
                action();
            }
            catch (Exception ex)
            {
                DojoLog.Error(what, ex);
            }
        }

        private static void Release(IDisposable item, string what)
        {
            if (item == null)
            {
                return;
            }
            try
            {
                item.Dispose();
            }
            catch (Exception ex)
            {
                DojoLog.Error("arret : " + what, ex);
            }
        }
    }
}
