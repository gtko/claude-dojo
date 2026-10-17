using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

namespace DojoWallpaper
{
    // Gere le fond : une fenetre par ecran (WallpaperWindow), reconstruite quand les ecrans changent.
    // A utiliser depuis le thread UI (le message loop de Application.Run).
    public sealed class WallpaperManager : IDisposable
    {
        private const int SafePushMs = 3000;
        private const int RebuildDebounceMs = 1000;
        private const int ResumeReloadMs = 3000;

        private DojoConfig cfg;
        private readonly List<WallpaperWindow> windows = new List<WallpaperWindow>();
        // Ecrans en pause, par nom de peripherique (stable entre deux reconstructions).
        private readonly HashSet<string> pausedDevices = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly System.Windows.Forms.Timer safeTimer;
        private readonly System.Windows.Forms.Timer rebuildTimer;
        private readonly System.Windows.Forms.Timer resumeTimer;
        private System.Threading.SynchronizationContext ui;
        private ShellWatcher shellWatcher;
        private string builtUrl;
        private int[] builtDisabled = new int[0];
        // Disposition des ecrans au moment de la derniere construction (voir ScreenSignature).
        private string builtScreens = string.Empty;
        private bool rebuildForced;
        private string rebuildReason = string.Empty;
        private bool started;
        private bool disposed;

        public WallpaperManager(DojoConfig cfg)
        {
            if (cfg == null)
            {
                throw new ArgumentNullException("cfg");
            }
            this.cfg = cfg;

            safeTimer = new System.Windows.Forms.Timer { Interval = SafePushMs };
            safeTimer.Tick += delegate
            {
                PushSafeAll(false);
                CheckWindows();
            };

            rebuildTimer = new System.Windows.Forms.Timer { Interval = RebuildDebounceMs };
            rebuildTimer.Tick += delegate
            {
                rebuildTimer.Stop();
                RunPendingRebuild();
            };

            resumeTimer = new System.Windows.Forms.Timer { Interval = ResumeReloadMs };
            resumeTimer.Tick += delegate
            {
                resumeTimer.Stop();
                CoreLog.Write("reload (reprise de veille)");
                Reload();
            };
        }

        // Une fenetre par ecran non desactive. Idempotent.
        public event Action ScreensRebuilt;

        public IList<Screen> ActiveScreens
        {
            get
            {
                var list = new List<Screen>();
                foreach (var w in windows)
                {
                    list.Add(w.Display);
                }
                return new ReadOnlyCollection<Screen>(list);
            }
        }

        public void Start()
        {
            ThrowIfDisposed();
            if (started)
            {
                return;
            }
            started = true;
            ui = System.Threading.SynchronizationContext.Current;
            GetSharedEnvironment();
            shellWatcher = new ShellWatcher(delegate { RequestRebuild("Explorateur redemarre", true); });
            SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            Build();
            safeTimer.Start();
        }

        // Applique la config a chaud. Reconstruit les fenetres si l'URL ou la liste des ecrans desactives change.
        public void ApplyConfig(DojoConfig newCfg)
        {
            ThrowIfDisposed();
            if (newCfg == null)
            {
                throw new ArgumentNullException("newCfg");
            }
            cfg = newCfg;
            if (!started)
            {
                return;
            }
            if (!string.Equals(cfg.Url, builtUrl, StringComparison.Ordinal) || !SameSet(Disabled(cfg), builtDisabled))
            {
                CoreLog.Write("ApplyConfig: rebuild (URL ou ecrans changes)");
                Rebuild();
                return;
            }
            foreach (var w in windows)
            {
                w.ApplyConfig(cfg);
            }
        }

        public void Reload()
        {
            ThrowIfDisposed();
            foreach (var w in windows)
            {
                w.Reload();
            }
        }

        // Pause GPU d'un ecran (WebView2 masque + suspendu). Reprise : Resume + affichage + zone sure.
        public void SetPaused(Screen s, bool paused)
        {
            if (s == null)
            {
                throw new ArgumentNullException("s");
            }
            ThrowIfDisposed();
            if (paused)
            {
                pausedDevices.Add(s.DeviceName);
            }
            else
            {
                pausedDevices.Remove(s.DeviceName);
            }
            var w = Find(s.DeviceName);
            if (w != null)
            {
                w.SetPaused(paused);
            }
        }

        public bool IsPaused(Screen s)
        {
            return s != null && pausedDevices.Contains(s.DeviceName);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            safeTimer.Stop();
            rebuildTimer.Stop();
            resumeTimer.Stop();
            safeTimer.Dispose();
            rebuildTimer.Dispose();
            resumeTimer.Dispose();
            CloseWindows();
            if (shellWatcher != null)
            {
                shellWatcher.DestroyHandle();
                shellWatcher = null;
            }
            CoreLog.Write("manager ferme");
        }

        private void Build()
        {
            var screens = Screen.AllScreens;
            var disabled = Disabled(cfg);
            builtUrl = cfg.Url;
            builtDisabled = disabled.ToArray();
            builtScreens = ScreenSignature(screens);

            for (int i = 0; i < screens.Length; i++)
            {
                if (Array.IndexOf(builtDisabled, i) >= 0)
                {
                    CoreLog.Write("ecran " + i + " desactive");
                    continue;
                }
                var w = new WallpaperWindow(i, screens[i], cfg, GetEnvironment);
                windows.Add(w);
                w.Present();
                if (pausedDevices.Contains(screens[i].DeviceName))
                {
                    w.SetPaused(true);
                }
            }
            CoreLog.Write("fenetres: " + windows.Count + " / ecrans: " + screens.Length);
            RaiseScreensRebuilt();
        }

        private void Rebuild()
        {
            CloseWindows();
            Build();
        }

        private void CloseWindows()
        {
            var old = windows.ToArray();
            windows.Clear();
            foreach (var w in old)
            {
                try
                {
                    w.Shutdown();
                }
                catch (Exception ex)
                {
                    // Handle deja detruit (Explorateur redemarre) : les autres fenetres sont fermees quand meme.
                    CoreLog.Write("fermeture fenetre echec: " + ex.Message);
                }
            }
        }

        private WallpaperWindow Find(string deviceName)
        {
            foreach (var w in windows)
            {
                if (string.Equals(w.Display.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase))
                {
                    return w;
                }
            }
            return null;
        }

        private void PushSafeAll(bool force)
        {
            foreach (var w in windows)
            {
                w.PushSafe(force);
            }
        }

        private void OnDisplaySettingsChanged(object sender, EventArgs e)
        {
            Post(delegate
            {
                if (!disposed)
                {
                    RequestRebuild("changement d'ecrans", false);
                }
            });
        }

        // Reconstruction differee (debounce). Un changement d'ecrans ne reconstruit que si la disposition a change ;
        // un redemarrage de l'Explorateur ou une fenetre perdue reconstruit toujours (force).
        private void RequestRebuild(string reason, bool force)
        {
            rebuildReason = reason;
            rebuildForced |= force;
            rebuildTimer.Stop();
            rebuildTimer.Start();
        }

        private void RunPendingRebuild()
        {
            bool force = rebuildForced;
            rebuildForced = false;
            if (!force && string.Equals(ScreenSignature(Screen.AllScreens), builtScreens, StringComparison.Ordinal))
            {
                CoreLog.Write("ecrans inchanges (" + rebuildReason + "), pas de reconstruction");
                return;
            }
            CoreLog.Write("rebuild (" + rebuildReason + ")");
            try
            {
                Rebuild();
            }
            catch (Exception ex)
            {
                CoreLog.Write("rebuild echec: " + ex.Message);
            }
        }

        // Controle periodique (safeTimer) : une fenetre perdue declenche une reconstruction. Filet de securite
        // si le message TaskbarCreated n'arrive pas.
        private void CheckWindows()
        {
            foreach (var w in windows)
            {
                if (w.IsStale)
                {
                    RequestRebuild("fenetre perdue par le bureau", true);
                    return;
                }
            }
        }

        private static string ScreenSignature(Screen[] screens)
        {
            var list = new List<ScreenDescriptor>();
            foreach (Screen s in screens)
            {
                list.Add(new ScreenDescriptor(s.DeviceName, s.Bounds, ScreenMetrics.Scale(s)));
            }
            return DisplaySignature.Of(list);
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode != PowerModes.Resume)
            {
                return;
            }
            Post(delegate
            {
                if (!disposed)
                {
                    resumeTimer.Stop();
                    resumeTimer.Start();
                }
            });
        }

        // Les evenements SystemEvents arrivent hors thread UI : on repasse sur le thread du manager.
        private void Post(Action action)
        {
            var context = ui;
            if (context == null)
            {
                action();
                return;
            }
            context.Post(state => action(), null);
        }

        private void RaiseScreensRebuilt()
        {
            var handler = ScreensRebuilt;
            if (handler == null)
            {
                return;
            }
            try
            {
                handler();
            }
            catch (Exception ex)
            {
                CoreLog.Write("ScreensRebuilt: " + ex.Message);
            }
        }

        private void ThrowIfDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException("WallpaperManager");
            }
        }

        // Environnement WebView2 partage par les fenetres. Un environnement en echec est recree a l'appel suivant
        // (reessai de chaque fenetre, voir WallpaperWindow), au lieu de reattendre indefiniment la meme tache en echec.
        private Task<CoreWebView2Environment> GetEnvironment()
        {
            return GetSharedEnvironment();
        }

        // Environnement unique du processus, partage avec les fenetres d'interface (UiWindow) : un seul dossier de donnees WebView2.
        private static readonly object EnvironmentGate = new object();
        private static Task<CoreWebView2Environment> sharedEnvironment;

        internal static Task<CoreWebView2Environment> GetSharedEnvironment()
        {
            lock (EnvironmentGate)
            {
                if (sharedEnvironment == null || sharedEnvironment.IsFaulted || sharedEnvironment.IsCanceled)
                {
                    sharedEnvironment = CreateEnvironment();
                }
                return sharedEnvironment;
            }
        }

        // Navigateur WebView2 mort : l'environnement qu'il servait est oublie, la prochaine demande en cree un neuf.
        // Ciblee : sans effet si le cache a deja ete renouvele (autre fenetre). Les controles deja crees (UiWindow)
        // gardent leur propre reference et ne sont pas touches.
        internal static void ResetSharedEnvironment(Task<CoreWebView2Environment> dead)
        {
            lock (EnvironmentGate)
            {
                if (dead != null && ReferenceEquals(sharedEnvironment, dead))
                {
                    sharedEnvironment = null;
                    CoreLog.Write("environnement WebView2 partage oublie (navigateur arrete)");
                }
            }
        }

        private static Task<CoreWebView2Environment> CreateEnvironment()
        {
            string dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DojoWallpaper",
                MutexNames.WebView2Folder(Environment.GetEnvironmentVariable(MutexNames.InstanceVariable)));
            Directory.CreateDirectory(dataDir);
            var options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required"
            };
            return CoreWebView2Environment.CreateAsync(null, dataDir, options);
        }

        private static IEnumerable<int> Disabled(DojoConfig cfg)
        {
            return cfg.DisabledScreens ?? new int[0];
        }

        private static bool SameSet(IEnumerable<int> a, int[] b)
        {
            return new HashSet<int>(a).SetEquals(b);
        }

        // Fenetre cachee de haut niveau, possedee par le manager. Seules les fenetres de haut niveau recoivent
        // TaskbarCreated (diffuse quand l'Explorateur redemarre) : les fenetres du fond, enfants de Progman, ne le recoivent pas.
        private sealed class ShellWatcher : NativeWindow
        {
            private static readonly int TaskbarCreated = (int)DesktopNative.RegisterWindowMessage("TaskbarCreated");
            private readonly Action onShellRestarted;

            public ShellWatcher(Action onShellRestarted)
            {
                this.onShellRestarted = onShellRestarted;
                // Sans parent ni WS_VISIBLE : fenetre de haut niveau, invisible.
                CreateHandle(new CreateParams());
            }

            protected override void WndProc(ref Message m)
            {
                if (TaskbarCreated != 0 && m.Msg == TaskbarCreated)
                {
                    CoreLog.Write("Explorateur redemarre (TaskbarCreated)");
                    onShellRestarted();
                }
                base.WndProc(ref m);
            }
        }
    }

    // Journal de diagnostic : actif seulement en mode --core (fichier %TEMP%\dojo-core.log).
    internal static class CoreLog
    {
        private static readonly object Gate = new object();

        public static bool Enabled;
        // Mode application : recopie des messages vers le journal (DojoLog). Null en mode --core.
        public static Action<string> Forward;
        public static readonly string FilePath = Path.Combine(Path.GetTempPath(), "dojo-core.log");

        public static void Reset()
        {
            if (!Enabled)
            {
                return;
            }
            try
            {
                File.Delete(FilePath);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        public static void Write(string message)
        {
            Action<string> forward = Forward;
            if (forward != null)
            {
                forward(message);
            }
            if (!Enabled)
            {
                return;
            }
            string line = DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine;
            try
            {
                lock (Gate)
                {
                    File.AppendAllText(FilePath, line);
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    // Metriques d'ecran : echelle DPI et zoom de la page.
    internal static class ScreenMetrics
    {
        private const int MONITOR_DEFAULTTONEAREST = 2;
        private const int MDT_EFFECTIVE_DPI = 0;
        // Largeur de reference en DIP (2560 : 4K a 150 % sous Windows).
        private const double ReferenceWidthDip = 2560.0;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

        // Echelle DPI de l'ecran (1.0 = 96 dpi). 1.0 si l'API n'est pas disponible.
        public static double Scale(Screen screen)
        {
            try
            {
                var center = new POINT
                {
                    X = screen.Bounds.Left + screen.Bounds.Width / 2,
                    Y = screen.Bounds.Top + screen.Bounds.Height / 2
                };
                IntPtr monitor = MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST);
                uint dpiX;
                uint dpiY;
                if (GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out dpiX, out dpiY) == 0 && dpiX > 0)
                {
                    return dpiX / 96.0;
                }
            }
            catch (DllNotFoundException)
            {
            }
            catch (EntryPointNotFoundException)
            {
            }
            return 1.0;
        }

        // Zoom auto = largeur en DIP / 2560, borne [0.6 ; 1], arrondi a 0.01 (parite Mac). cfg.Zoom > 0 : valeur imposee.
        public static double Zoom(DojoConfig cfg, Screen screen, double scale)
        {
            if (cfg.Zoom > 0)
            {
                return cfg.Zoom;
            }
            double widthDip = screen.Bounds.Width / scale;
            double zoom = Math.Round(widthDip / ReferenceWidthDip, 2, MidpointRounding.AwayFromZero);
            return Math.Min(1.0, Math.Max(0.6, zoom));
        }
    }
}
