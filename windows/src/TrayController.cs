using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DojoWallpaper
{
    // Icone de zone de notification et son menu. Les items ne font qu'emettre des evenements :
    // le cablage global (appliquer le mode, la pause, l'autostart...) est fait par l'integration.
    public sealed class TrayController : IDisposable
    {
        internal const string LabelInteractive = "Interactif (clics transmis au fond)";
        internal const string LabelPassive = "Passif (derrière les icônes)";
        internal const string LabelMirror = "Inverser gauche / droite";
        internal const string LabelPause = "Pause manuelle";
        internal const string LabelReload = "Recharger";
        internal const string LabelOpenConfig = "Ouvrir la config";
        internal const string LabelAutostart = "Démarrer avec Windows";
        internal const string LabelQuit = "Quitter le Dojo";

        private const string Tooltip = "Dojo Wallpaper";
        private const int MaxTooltipLength = 63; // limite de NotifyIcon.Text (.NET Framework)

        private readonly string _configPath;
        private readonly NotifyIcon _icon;
        private readonly ContextMenuStrip _menu;
        private readonly ToolStripMenuItem _interactiveItem;
        private readonly ToolStripMenuItem _passiveItem;
        private readonly ToolStripMenuItem _mirrorItem;
        private readonly ToolStripMenuItem _pauseItem;
        private readonly ToolStripMenuItem _autostartItem;
        private string _mode;
        private bool _mirror;
        private bool _paused;
        private IntPtr _iconHandle = IntPtr.Zero;
        private bool _disposed;

        // Ouverture de la config. Remplacable (tests) pour ne pas lancer d'application.
        internal Action<string> OpenFile = DefaultOpenFile;

        public event Action<string> ModeChanged;
        public event Action<bool> MirrorToggled;
        public event Action<bool> ManualPauseToggled;
        public event Action ReloadRequested;
        public event Action OpenConfigRequested;
        public event Action<bool> AutostartToggled;
        public event Action QuitRequested;

        public TrayController(DojoConfig cfg)
            : this(cfg, DojoConfig.DefaultPath)
        {
        }

        public TrayController(DojoConfig cfg, string configPath)
        {
            if (cfg == null)
            {
                throw new ArgumentNullException("cfg");
            }

            _configPath = configPath;
            _mode = DojoConfig.NormalizeMode(cfg.Mode);
            _mirror = cfg.Mirror;

            _interactiveItem = CreateItem(LabelInteractive, () => SelectMode(DojoConfig.DefaultMode));
            _passiveItem = CreateItem(LabelPassive, () => SelectMode(DojoConfig.PassiveMode));
            _mirrorItem = CreateItem(LabelMirror, OnToggleMirror);
            _pauseItem = CreateItem(LabelPause, OnTogglePause);
            var reloadItem = CreateItem(LabelReload, OnReload);
            var openConfigItem = CreateItem(LabelOpenConfig, OnOpenConfig);
            _autostartItem = CreateItem(LabelAutostart, OnToggleAutostart);
            var quitItem = CreateItem(LabelQuit, OnQuit);

            _menu = new ContextMenuStrip();
            _menu.Items.AddRange(new ToolStripItem[]
            {
                _interactiveItem, _passiveItem, _mirrorItem, _pauseItem, reloadItem, openConfigItem, _autostartItem,
                new ToolStripSeparator(), quitItem
            });
            _menu.Opening += (s, e) => RefreshChecks();

            _icon = new NotifyIcon
            {
                Text = Tooltip,
                ContextMenuStrip = _menu
            };
            _icon.DoubleClick += (s, e) => OnReload();

            RefreshIcon();
            RefreshChecks();
            _icon.Visible = true;
        }

        public void UpdateConfig(DojoConfig cfg)
        {
            if (cfg == null)
            {
                throw new ArgumentNullException("cfg");
            }
            if (_disposed)
            {
                return;
            }

            _mode = DojoConfig.NormalizeMode(cfg.Mode);
            _mirror = cfg.Mirror;
            UpdateModeChecks();
            _mirrorItem.Checked = _mirror;
        }

        public void SetPaused(bool manualPaused)
        {
            if (_disposed)
            {
                return;
            }

            _paused = manualPaused;
            _pauseItem.Checked = _paused;
            RefreshIcon();
        }

        public void SetStatus(string tooltip)
        {
            if (_disposed)
            {
                return;
            }

            string text = string.IsNullOrEmpty(tooltip) ? Tooltip : tooltip;
            _icon.Text = text.Length > MaxTooltipLength ? text.Substring(0, MaxTooltipLength) : text;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;

            // Masquer avant Dispose : pas d'icone fantome dans la zone de notification.
            _icon.Visible = false;
            _icon.Dispose();
            _menu.Dispose();
            DestroyIconHandle();
        }

        internal bool IsIconVisible
        {
            get { return !_disposed && _icon.Visible; }
        }

        internal string CurrentTooltip
        {
            get { return _icon.Text; }
        }

        internal ContextMenuStrip Menu
        {
            get { return _menu; }
        }

        private static ToolStripMenuItem CreateItem(string text, Action onClick)
        {
            var item = new ToolStripMenuItem(text) { CheckOnClick = false };
            item.Click += (s, e) => onClick();
            return item;
        }

        private void SelectMode(string mode)
        {
            if (_mode == mode)
            {
                UpdateModeChecks();
                return;
            }

            _mode = mode;
            UpdateModeChecks();
            var handler = ModeChanged;
            if (handler != null)
            {
                handler(mode);
            }
        }

        private void OnToggleMirror()
        {
            bool next = !_mirror;
            _mirror = next;
            _mirrorItem.Checked = next;
            var handler = MirrorToggled;
            if (handler != null)
            {
                handler(next);
            }
        }

        private void OnTogglePause()
        {
            _paused = !_paused;
            _pauseItem.Checked = _paused;
            RefreshIcon();
            var handler = ManualPauseToggled;
            if (handler != null)
            {
                handler(_paused);
            }
        }

        private void OnReload()
        {
            var handler = ReloadRequested;
            if (handler != null)
            {
                handler();
            }
        }

        private void OnOpenConfig()
        {
            OpenFile(_configPath);
            var handler = OpenConfigRequested;
            if (handler != null)
            {
                handler();
            }
        }

        private void OnToggleAutostart()
        {
            bool next = !_autostartItem.Checked;
            _autostartItem.Checked = next;
            var handler = AutostartToggled;
            if (handler != null)
            {
                handler(next);
            }
        }

        private void OnQuit()
        {
            var handler = QuitRequested;
            if (handler != null)
            {
                handler();
            }
        }

        private void UpdateModeChecks()
        {
            _interactiveItem.Checked = _mode == DojoConfig.DefaultMode;
            _passiveItem.Checked = _mode == DojoConfig.PassiveMode;
        }

        // Etat lu a l'ouverture du menu : l'autostart peut avoir change hors de l'application.
        private void RefreshChecks()
        {
            UpdateModeChecks();
            _mirrorItem.Checked = _mirror;
            _pauseItem.Checked = _paused;
            _autostartItem.Checked = ReadAutostart();
        }

        private static bool ReadAutostart()
        {
            try
            {
                return Autostart.IsEnabled();
            }
            catch (System.IO.IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
            catch (System.Security.SecurityException)
            {
                return false;
            }
        }

        private void RefreshIcon()
        {
            IntPtr handle;
            using (Bitmap bitmap = RenderIcon(_paused))
            {
                handle = bitmap.GetHicon();
            }

            IntPtr previous = _iconHandle;
            _iconHandle = handle;
            _icon.Icon = Icon.FromHandle(handle);
            if (previous != IntPtr.Zero)
            {
                DestroyIcon(previous);
            }
        }

        private void DestroyIconHandle()
        {
            if (_iconHandle != IntPtr.Zero)
            {
                DestroyIcon(_iconHandle);
                _iconHandle = IntPtr.Zero;
            }
        }

        // Torii rouge sur fond sombre ; version grisee en pause. 16 px ou 32 px selon la zone de notification.
        private static Bitmap RenderIcon(bool paused)
        {
            int size = SystemInformation.SmallIconSize.Width >= 24 ? 32 : 16;
            var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);

                Color background = paused ? Color.FromArgb(255, 72, 72, 80) : Color.FromArgb(255, 28, 28, 34);
                Color red = paused ? Color.FromArgb(255, 150, 150, 158) : Color.FromArgb(255, 214, 38, 61);

                using (GraphicsPath path = RoundedRectangle(0, 0, size, size, size * 0.2f))
                using (var backgroundBrush = new SolidBrush(background))
                {
                    g.FillPath(backgroundBrush, path);
                }

                using (var brush = new SolidBrush(red))
                {
                    DrawTorii(g, brush, size);
                }
            }
            return bitmap;
        }

        private static void DrawTorii(Graphics g, Brush brush, int size)
        {
            float s = size;
            // Kasagi : linteau superieur aux extremites relevees.
            g.FillPolygon(brush, new[]
            {
                new PointF(0.14f * s, 0.30f * s), new PointF(0.50f * s, 0.21f * s), new PointF(0.86f * s, 0.30f * s),
                new PointF(0.86f * s, 0.37f * s), new PointF(0.50f * s, 0.28f * s), new PointF(0.14f * s, 0.37f * s)
            });
            // Nuki : linteau inferieur.
            g.FillRectangle(brush, 0.22f * s, 0.44f * s, 0.56f * s, 0.08f * s);
            // Piliers.
            g.FillRectangle(brush, 0.25f * s, 0.36f * s, 0.10f * s, 0.48f * s);
            g.FillRectangle(brush, 0.65f * s, 0.36f * s, 0.10f * s, 0.48f * s);
        }

        private static GraphicsPath RoundedRectangle(float x, float y, float width, float height, float radius)
        {
            var path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + width - d, y, d, d, 270, 90);
            path.AddArc(x + width - d, y + height - d, d, d, 0, 90);
            path.AddArc(x, y + height - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // Ouvre la config avec le programme par defaut ; notepad en repli si aucun n'est associe.
        private static void DefaultOpenFile(string path)
        {
            try
            {
                using (Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }))
                {
                }
            }
            catch (Win32Exception)
            {
                try
                {
                    using (Process.Start("notepad.exe", "\"" + path + "\""))
                    {
                    }
                }
                catch (Win32Exception)
                {
                }
            }
        }

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr handle);
    }
}
