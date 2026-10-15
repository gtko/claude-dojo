using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DojoWallpaper
{
    // Fenetre generique de l'interface : une instance par page (windows\ui), WebView2 sur https://dojo-ui.local/<page>.
    // Une seule fenetre par page : un second appel la ramene au premier plan. Thread UI uniquement.
    internal sealed class UiWindow : Form
    {
        private static readonly Color Background = Color.FromArgb(30, 31, 41);
        private static readonly Dictionary<string, UiWindow> Windows =
            new Dictionary<string, UiWindow>(StringComparer.OrdinalIgnoreCase);
        private static readonly string InstallDir = UiLayout.InstallDir();
        private static readonly string UiDir = UiLayout.UiDirFrom(AppDomain.CurrentDomain.BaseDirectory);
        private static readonly string ThemesDir = UiLayout.ThemesDirFor(InstallDir);
        private static readonly string BackgroundsDir = UiLayout.BackgroundsDirFor(InstallDir);

        // Rechargement des pages du fond (action native reloadWallpaper), fourni par DojoApp. Null = rien a faire.
        public static Action WallpaperReload;

        private readonly string _page;
        private string _query;
        private readonly WebView2 _web;
        private readonly UiBridge _bridge;
        private readonly bool _debug;
        // Tailles en DIP (voir UiLayout.ToPixels) : converties en pixels reels a chaque creation de handle et changement de DPI.
        private readonly Size _sizeDip;
        private readonly Size _minSizeDip;

        private UiWindow(string page, string title, Size size, Size minSize, string query)
        {
            _page = page;
            _query = query;
            _sizeDip = size;
            _minSizeDip = minSize;
            _debug = Environment.GetEnvironmentVariable("DOJO_UI_DEBUG") == "1";
            Text = title;
            StartPosition = FormStartPosition.CenterScreen;
            // Pas de mise a l'echelle WinForms : les tailles sont deja converties en pixels (ApplyDpi).
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Background;
            Icon = AppIcon();

            _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
            Controls.Add(_web);
            _bridge = new UiBridge(new Host(this), PostToPage);

            Load += delegate { InitializeAsync(); };
            FormClosed += delegate
            {
                UiWindow current;
                if (Windows.TryGetValue(_page, out current) && current == this)
                {
                    Windows.Remove(_page);
                }
            };
        }

        // Taille en pixels reels pour le DPI donne. Minimum d'abord : il peut relever la taille courante.
        private void ApplyDpi(int dpi)
        {
            MinimumSize = UiLayout.ToPixels(_minSizeDip, dpi);
            ClientSize = UiLayout.ToPixels(_sizeDip, dpi);
        }

        // DPI reel de la fenetre (Windows 10 1607+). Mesure sur un ecran a 125 % : Control.DeviceDpi valait 96 a la
        // creation du handle, la taille restait donc en pixels DIP (980x720 au lieu de 1225x900).
        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            uint dpi = GetDpiForWindow(Handle);
            ApplyDpi(dpi > 0 ? (int)dpi : DeviceDpi);
        }

        // Deplacement vers un ecran a autre DPI : la taille en DIP ne change pas, seuls les pixels changent.
        // WebView2 (Dock Fill) suit la taille du formulaire ; son zoom reste 1 (le DPI est gere par WebView2).
        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            ApplyDpi(e.DeviceDpiNew);
        }

        // Ouvre la page (ou la ramene au premier plan si elle est deja ouverte).
        public static void Open(string page, string title, Size size, Size minSize)
        {
            Open(page, title, size, minSize, string.Empty);
        }

        // query : « ?theme=<id> » pour la galerie (UiBridge.WindowQuery), vide sinon. Fenetre deja ouverte : rechargee si la query change.
        public static void Open(string page, string title, Size size, Size minSize, string query)
        {
            UiWindow existing;
            if (Windows.TryGetValue(page, out existing) && !existing.IsDisposed)
            {
                if (existing.WindowState == FormWindowState.Minimized)
                {
                    existing.WindowState = FormWindowState.Normal;
                }
                existing.Show();
                existing.Activate();
                existing.BringToFront();
                existing.NavigateTo(query ?? string.Empty);
                return;
            }

            var window = new UiWindow(page, title, size, minSize, query ?? string.Empty);
            Windows[page] = window;
            window.Show();
        }

        private string PageUrl()
        {
            return "https://" + UiBridge.UiHost + "/" + _page + _query;
        }

        // Autre theme pour une fenetre deja ouverte : navigation vers la nouvelle URL. Sans theme (menu), la page reste en place.
        private void NavigateTo(string query)
        {
            if (query.Length == 0 || string.Equals(_query, query, StringComparison.Ordinal))
            {
                return;
            }
            _query = query;
            CoreWebView2 core = _web.CoreWebView2;
            if (core != null)
            {
                core.Navigate(PageUrl());
            }
        }

        private async void InitializeAsync()
        {
            try
            {
                CoreWebView2Environment env = await WallpaperManager.GetSharedEnvironment();
                if (IsDisposed)
                {
                    return;
                }
                CoreWebView2ControllerOptions options = env.CreateCoreWebView2ControllerOptions();
                options.IsInPrivateModeEnabled = true;
                await _web.EnsureCoreWebView2Async(env, options);
                if (IsDisposed)
                {
                    return;
                }

                Directory.CreateDirectory(BackgroundsDir);
                CoreWebView2 core = _web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDevToolsEnabled = _debug;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                // Seuls ces trois dossiers sont accessibles : pas l'installation entiere (config.json peut contenir des secrets).
                core.SetVirtualHostNameToFolderMapping(UiBridge.UiHost, UiDir, CoreWebView2HostResourceAccessKind.Allow);
                core.SetVirtualHostNameToFolderMapping(UiBridge.ThemesHost, ThemesDir, CoreWebView2HostResourceAccessKind.Allow);
                core.SetVirtualHostNameToFolderMapping(UiBridge.BackgroundHost, BackgroundsDir, CoreWebView2HostResourceAccessKind.Allow);
                core.NavigationStarting += OnNavigationStarting;
                core.NewWindowRequested += OnNewWindowRequested;
                core.WebMessageReceived += OnWebMessage;
                core.Navigate(PageUrl());
                DojoLog.Write("interface : " + _page + " (ouverte)");
            }
            catch (Exception ex)
            {
                DojoLog.Error("interface " + _page, ex);
            }
        }

        // Toute navigation hors dojo-ui.local est annulee (les liens externes passent par openUrl).
        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!UiBridge.IsTrustedUrl(e.Uri))
            {
                e.Cancel = true;
                DojoLog.Write("interface : navigation hors dojo-ui.local refusée");
            }
        }

        private static void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            // HandleAsync ne leve pas : la tache n'a pas besoin d'etre observee.
            _ = _bridge.HandleAsync(e.Source, e.WebMessageAsJson);
        }

        // Reponse vers la page ; appele possiblement hors thread UI (commandes asynchrones).
        private void PostToPage(string json)
        {
            if (IsDisposed)
            {
                return;
            }
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(PostToPage), json);
                return;
            }
            CoreWebView2 core = _web.CoreWebView2;
            if (core != null)
            {
                core.PostWebMessageAsJson(json);
            }
        }

        private static Icon AppIcon()
        {
            try
            {
                return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception)
            {
                return null;
            }
        }

        // Dictionnaire de reponse : paires cle, valeur.
        private static Dictionary<string, object> Obj(params object[] pairs)
        {
            var dict = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                dict[(string)pairs[i]] = pairs[i + 1];
            }
            return dict;
        }

        // Implementation des actions natives et des commandes : appelee par UiBridge (thread UI, sauf RunSetupAsync).
        private sealed class Host : IBridgeHost
        {
            private readonly UiWindow _owner;

            public Host(UiWindow owner)
            {
                _owner = owner;
            }

            public Task<IDictionary<string, object>> RunSetupAsync(BridgeCall call)
            {
                return NodeRunner.RunAsync(call, UiLayout.SetupScriptFor(InstallDir));
            }

            public IDictionary<string, object> PickFile()
            {
                using (var dialog = new OpenFileDialog())
                {
                    dialog.Title = "Choisir une image de fond";
                    dialog.Filter = "Images (*.jpg;*.jpeg;*.png;*.webp;*.heic)|*.jpg;*.jpeg;*.png;*.webp;*.heic";
                    dialog.CheckFileExists = true;
                    dialog.Multiselect = false;
                    if (dialog.ShowDialog(_owner) != DialogResult.OK)
                    {
                        return Obj("ok", true, "path", null);
                    }
                    return Obj("ok", true, "path", dialog.FileName);
                }
            }

            public IDictionary<string, object> PickFolder()
            {
                using (var dialog = new FolderBrowserDialog())
                {
                    dialog.Description = "Choisir un dossier";
                    dialog.ShowNewFolderButton = true;
                    if (dialog.ShowDialog(_owner) != DialogResult.OK)
                    {
                        return Obj("ok", true, "path", null);
                    }
                    return Obj("ok", true, "path", dialog.SelectedPath);
                }
            }

            public IDictionary<string, object> OpenUrl(string url)
            {
                try
                {
                    using (Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }))
                    {
                    }
                    return Obj("ok", true);
                }
                catch (Exception ex)
                {
                    return Obj("ok", false, "error", "ouverture impossible : " + ex.Message);
                }
            }

            public IDictionary<string, object> CloseWindow()
            {
                if (!_owner.IsDisposed)
                {
                    _owner.BeginInvoke(new Action(_owner.Close));
                }
                return Obj("ok", true);
            }

            public IDictionary<string, object> SetTitle(string title)
            {
                _owner.Text = title;
                return Obj("ok", true);
            }

            public IDictionary<string, object> GetEnv()
            {
                string version = typeof(UiWindow).Assembly.GetName().Version.ToString();
                return Obj("ok", true, "install", InstallDir, "ui", UiDir, "platform", "win32", "version", version);
            }

            public IDictionary<string, object> GetAutostart()
            {
                try
                {
                    return Obj("ok", true, "enabled", Autostart.IsEnabled());
                }
                catch (Exception ex)
                {
                    return Obj("ok", false, "error", "lecture impossible : " + ex.Message);
                }
            }

            public IDictionary<string, object> SetAutostart(bool enabled)
            {
                try
                {
                    if (enabled)
                    {
                        Autostart.Enable(Application.ExecutablePath);
                    }
                    else
                    {
                        Autostart.Disable();
                    }
                    DojoLog.Write("demarrage avec Windows : " + (enabled ? "active" : "desactive") + " (interface)");
                    return Obj("ok", true, "enabled", enabled);
                }
                catch (Exception ex)
                {
                    return Obj("ok", false, "error", "écriture impossible : " + ex.Message);
                }
            }

            public IDictionary<string, object> ReloadWallpaper()
            {
                Action reload = WallpaperReload;
                if (reload == null)
                {
                    return Obj("ok", true, "noop", true);
                }
                reload();
                return Obj("ok", true);
            }

            // Ouverture sur le thread UI : le pont y tourne deja (WebMessageReceived), Invoke couvre le cas contraire.
            public IDictionary<string, object> OpenWindow(string page, string theme)
            {
                try
                {
                    if (_owner.InvokeRequired)
                    {
                        return (IDictionary<string, object>)_owner.Invoke(new Func<IDictionary<string, object>>(() => OpenPage(page, theme)));
                    }
                    return OpenPage(page, theme);
                }
                catch (Exception ex)
                {
                    return Obj("ok", false, "error", "ouverture impossible : " + ex.Message);
                }
            }

            // Meme chemin que le menu (DojoApp.OnUiRequested) : UiLayout.Find puis UiWindow.Open avec titre et tailles.
            private static IDictionary<string, object> OpenPage(string page, string theme)
            {
                UiPage info = UiLayout.Find(page);
                if (info == null)
                {
                    return Obj("ok", false, "error", "page inconnue.");
                }
                UiWindow.Open(info.File, info.Title, info.Size, info.MinSize, UiBridge.WindowQuery(info.Key, theme));
                return Obj("ok", true);
            }
        }
    }
}
