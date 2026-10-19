using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DojoWallpaper
{
    // Une fenetre sans bordure par ecran : incrustee au bureau (DesktopHost), page du dojo dans un WebView2.
    // Thread UI uniquement.
    internal sealed class WallpaperWindow : Form
    {
        private const int WsExToolWindow = 0x00000080;
        private const int RetryMs = 3000;
        private const int ProbeMs = 4000;
        // Reessai d'initialisation WebView2 (environnement ou controle en echec).
        private const int InitRetryMs = 10000;
        // Delai maximal de la capture de la derniere image avant la mise en pause (la pause ne doit jamais attendre).
        private const int CaptureTimeoutMs = 3000;
        // Periode du chien de garde : page muette (PageWatchdog.SilenceMs) ou navigateur mort.
        private const int WatchdogTickMs = 5000;
        // Delai de la sonde de page (ExecuteScriptAsync) : au-dela, la page est jugee figee.
        private const int ProbeTimeoutMs = 5000;

        private readonly Func<Task<CoreWebView2Environment>> environment;
        // Non readonly : recree si le navigateur WebView2 meurt (RecreateWeb).
        private WebView2 web;
        private readonly InputForwarder input;
        private readonly System.Windows.Forms.Timer retryTimer;
        private readonly System.Windows.Forms.Timer probeTimer;
        private readonly System.Windows.Forms.Timer embedTimer;
        private readonly System.Windows.Forms.Timer initRetryTimer;
        private readonly System.Windows.Forms.Timer watchdogTimer;
        private readonly PageWatchdog watchdog;
        private readonly Stopwatch watchClock = Stopwatch.StartNew();
        private readonly double scale;

        private string url;
        private bool mirror;
        private bool interactive;
        private double zoom;
        private bool initialized;
        private bool handlersAttached;
        private bool loaded;
        private bool paused;
        // Incremente a chaque changement de pause : une capture en cours ne masque la page que si elle est encore valable.
        private int pauseSeq;
        private bool pendingNavigate;
        private bool shutdown;
        // Navigateur WebView2 mort (ProcessFailed BrowserProcessExited) : recreation par le chien de garde, hors pause.
        private bool browserDead;
        // Navigation lancee sans NavigationCompleted encore : un renderer fige ne la termine pas (escalade, WatchdogTick).
        private bool reloading;
        // Environnement servant au controle courant (oublie si le navigateur meurt : WallpaperManager.ResetSharedEnvironment).
        private Task<CoreWebView2Environment> environmentUsed;
        // Sonde de page en vol : une seule a la fois (ProbeSilentPage).
        private bool probing;
        // La page s'est annoncee (battement ou erreur dojo:) pendant la navigation en cours : sa sonde fait foi.
        private bool dojoPage;
        private string lastSafe;
        private DateTime embedSince;
        // Derniere image de la page, affichee sur le fond du formulaire pendant la pause (WebView masquee).
        private Image frame;

        public WallpaperWindow(int index, Screen display, DojoConfig cfg, Func<Task<CoreWebView2Environment>> environment)
        {
            Index = index;
            Display = display;
            this.environment = environment;
            scale = ScreenMetrics.Scale(display);
            url = cfg.Url;
            mirror = cfg.Mirror;
            interactive = IsInteractive(cfg);
            zoom = ScreenMetrics.Zoom(cfg, display, scale);

            Text = "DojoWallpaper-" + index.ToString(CultureInfo.InvariantCulture);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            ControlBox = false;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Bounds = display.Bounds;

            web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(web);

            input = new InputForwarder();

            // Reessai tant que l'agent ne repond pas (comme Mac : toutes les 3 s).
            retryTimer = new System.Windows.Forms.Timer { Interval = RetryMs };
            retryTimer.Tick += delegate
            {
                retryTimer.Stop();
                RetryNavigate();
            };

            // Diagnostic (mode --core seulement) : etat de la page quelques secondes apres le chargement.
            probeTimer = new System.Windows.Forms.Timer { Interval = ProbeMs };
            probeTimer.Tick += delegate
            {
                probeTimer.Stop();
                Probe();
            };

            // Reessai d'incrustation tant que l'Explorateur n'a pas fait de place au fond (ouverture de session).
            embedTimer = new System.Windows.Forms.Timer { Interval = DesktopHost.EmbedRetryDelayMs(TimeSpan.Zero) };
            embedTimer.Tick += delegate { TryEmbed(); };

            // Reessai d'initialisation WebView2 tant qu'elle echoue (toutes les 10 s).
            initRetryTimer = new System.Windows.Forms.Timer { Interval = InitRetryMs };
            initRetryTimer.Tick += delegate
            {
                initRetryTimer.Stop();
                InitializeAsync();
            };

            // Chien de garde : verifie la page (battements) et le navigateur toutes les 5 s (WatchdogTick).
            watchdog = new PageWatchdog(() => watchClock.ElapsedMilliseconds);
            watchdogTimer = new System.Windows.Forms.Timer { Interval = WatchdogTickMs };
            watchdogTimer.Tick += delegate { WatchdogTick(); };
        }

        public int Index { get; private set; }

        public Screen Display { get; private set; }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WsExToolWindow;
                return cp;
            }
        }

        // Affichage sans activation : le fond ne vole pas le focus.
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        // Fenetre perdue (handle detruit par le redemarrage de l'Explorateur, hote remplace) : le manager la reconstruit.
        public bool IsStale
        {
            get { return !shutdown && DesktopHost.IsStale(this); }
        }

        // Cree le handle, incruste la fenetre au bureau AVANT l'affichage, puis lance WebView2.
        public void Present()
        {
            if (shutdown)
            {
                return;
            }
            if (!IsHandleCreated)
            {
                CreateHandle();
            }
            bool embedded = DesktopHost.Embed(this, Display.Bounds);
            input.Attach(this, web);
            input.Enabled = interactive;
            Show();
            CoreLog.Write(string.Format(CultureInfo.InvariantCulture,
                "{0} ecran={1} bounds={2} echelle={3} zoom={4} interactif={5} incrustee={6}",
                Text, Display.DeviceName, Display.Bounds, scale, zoom, interactive, embedded));
            if (!embedded)
            {
                StartEmbedRetry();
            }
            watchdogTimer.Start();
            InitializeAsync();
        }

        // Fenetre restee en repli (Explorateur pas pret) : nouvel essai d'incrustation jusqu'a reussir.
        private void StartEmbedRetry()
        {
            embedSince = DateTime.UtcNow;
            embedTimer.Interval = DesktopHost.EmbedRetryDelayMs(TimeSpan.Zero);
            embedTimer.Start();
            CoreLog.Write(Text + " hors bureau (repli) : nouveaux essais d'incrustation");
        }

        private void TryEmbed()
        {
            if (shutdown || DesktopHost.IsEmbedded(this))
            {
                embedTimer.Stop();
                return;
            }
            if (DesktopHost.Embed(this, Display.Bounds))
            {
                embedTimer.Stop();
                CoreLog.Write(Text + " incrustee au bureau (nouvel essai)");
                return;
            }
            embedTimer.Interval = DesktopHost.EmbedRetryDelayMs(DateTime.UtcNow - embedSince);
        }

        public void ApplyConfig(DojoConfig cfg)
        {
            if (shutdown)
            {
                return;
            }
            mirror = cfg.Mirror;
            interactive = IsInteractive(cfg);
            zoom = ScreenMetrics.Zoom(cfg, Display, scale);
            input.Enabled = interactive;
            if (initialized)
            {
                web.ZoomFactor = zoom;
            }
            PushSafe(true);
        }

        public void Reload()
        {
            if (shutdown)
            {
                return;
            }
            retryTimer.Stop();
            Navigate();
        }

        public void SetPaused(bool value)
        {
            if (shutdown || paused == value)
            {
                return;
            }
            paused = value;
            pauseSeq++;
            // Pas de relais souris vers une WebView en pause (masquée et suspendue).
            input.SetSuspended(this, value);
            CoreLog.Write(Text + (value ? " pause" : " reprise"));
            if (!initialized)
            {
                return;
            }
            if (value)
            {
                SuspendCore();
            }
            else
            {
                ResumeCore();
            }
        }

        // Pousse la zone sure a la page (setSafe). Ignore si la page n'est pas chargee ou si la fenetre est en pause.
        public void PushSafe(bool force)
        {
            if (shutdown || !initialized || !loaded || paused)
            {
                return;
            }
            string script = "window.setSafe && setSafe(" + SafeJson() + ")";
            if (!force && string.Equals(script, lastSafe, StringComparison.Ordinal))
            {
                return;
            }
            lastSafe = script;
            RunScript(script);
        }

        public void Shutdown()
        {
            if (shutdown)
            {
                return;
            }
            shutdown = true;
            string name = Text; // lu avant Dispose (apres, Text est vide dans le journal)
            retryTimer.Stop();
            probeTimer.Stop();
            embedTimer.Stop();
            initRetryTimer.Stop();
            watchdogTimer.Stop();
            retryTimer.Dispose();
            probeTimer.Dispose();
            embedTimer.Dispose();
            initRetryTimer.Dispose();
            watchdogTimer.Dispose();
            // Masquee avant de quitter le bureau : une fenetre encore visible apparaitrait en plein ecran au premier plan.
            Hide();
            DesktopHost.Detach(this);
            input.Detach(this);
            input.Dispose();
            Close();
            Dispose();
            CoreLog.Write(name + " ferme");
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                shutdown = true;
                ClearFrame();
            }
            base.Dispose(disposing);
        }

        private async void InitializeAsync()
        {
            if (shutdown || initialized)
            {
                return;
            }
            // Controle vise par cet essai : s'il est recree pendant l'essai, l'essai est abandonne (RecreateWeb relance).
            WebView2 target = web;
            try
            {
                Task<CoreWebView2Environment> pendingEnv = environment();
                environmentUsed = pendingEnv;
                CoreWebView2Environment env = await pendingEnv;
                if (shutdown || target != web)
                {
                    return;
                }
                CoreWebView2ControllerOptions options = env.CreateCoreWebView2ControllerOptions();
                options.IsInPrivateModeEnabled = true;
                await web.EnsureCoreWebView2Async(env, options);
                if (shutdown || target != web)
                {
                    return;
                }

                CoreWebView2 core = web.CoreWebView2;
                // Gestionnaires attaches une seule fois, meme si une tentative precedente a echoue apres coup.
                if (!handlersAttached)
                {
                    core.Settings.AreDefaultContextMenusEnabled = false;
                    core.NavigationStarting += OnNavigationStarting;
                    core.NewWindowRequested += OnNewWindowRequested;
                    core.ProcessFailed += OnProcessFailed;
                    core.WebMessageReceived += OnWebMessage;
                    web.NavigationCompleted += OnNavigationCompleted;
                    handlersAttached = true;
                }
                web.DefaultBackgroundColor = Color.Transparent;
                web.ZoomFactor = zoom;
                initialized = true;
                CoreLog.Write(Text + " WebView2 pret (InPrivate)");

                if (paused)
                {
                    SuspendCore();
                }
                Navigate();
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " init WebView2 echec: " + ex.Message
                    + " (nouvel essai dans " + (InitRetryMs / 1000) + " s)");
                if (!shutdown && !initialized && target == web)
                {
                    initRetryTimer.Start();
                }
            }
        }

        private void Navigate()
        {
            if (shutdown || !initialized)
            {
                return;
            }
            if (paused)
            {
                // Pas de chargement pendant la pause : fait a la reprise.
                pendingNavigate = true;
                return;
            }
            pendingNavigate = false;
            loaded = false;
            dojoPage = false;
            reloading = true;
            watchdog.Reset();
            CoreLog.Write(Text + " navigate " + DojoLog.Redact(url));
            web.CoreWebView2.Navigate(url);
        }

        private void RetryNavigate()
        {
            if (shutdown || loaded)
            {
                return;
            }
            CoreLog.Write(Text + " nouvel essai (agent indisponible)");
            Navigate();
        }

        // Chien de garde (toutes les 5 s) : navigateur mort -> recreation du controle ; page muette (pas de battement
        // depuis 20 s) -> sonde, puis rechargement si la sonde reste sans reponse. Rien pendant la pause.
        // Recreations espacees (PageWatchdog.TryRecreate) : une page qui ne repart jamais ne boucle pas.
        private void WatchdogTick()
        {
            if (shutdown || paused)
            {
                return;
            }
            try
            {
                if (browserDead)
                {
                    if (watchdog.TryRecreate())
                    {
                        // Environnement du navigateur mort : oublie, la recreation en demande un neuf.
                        WallpaperManager.ResetSharedEnvironment(environmentUsed);
                        RecreateWeb();
                    }
                    return;
                }
                if (initialized && reloading)
                {
                    // Rechargement lance il y a 20 s sans fin de navigation : le renderer est fige et le rechargement
                    // ne le remplace pas. Le controle est recree.
                    if (watchdog.IsSilent() && watchdog.TryRecreate())
                    {
                        CoreLog.Write(Text + " rechargement sans reponse : recreation du controle (n=" + watchdog.Recreations + ")");
                        RecreateWeb();
                    }
                    return;
                }
                if (initialized && !probing && watchdog.SilenceDue(loaded, paused))
                {
                    ProbeSilentPage();
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " chien de garde echec: " + ex.Message);
            }
        }

        // Page muette depuis SilenceMs : sonde (ExecuteScriptAsync) avant tout rechargement. Un minuteur bride
        // (page jugee occultee) ne doit pas faire recharger une page vivante. Une seule sonde en vol (probing).
        // Sonde window.__dojoReady : "false" d'une page du dojo = script arrete (rechargement, backoff PageWatchdog).
        private async void ProbeSilentPage()
        {
            probing = true;
            WebView2 target = web;
            bool answered = false;
            string answer = null;
            try
            {
                Task<string> script = target.ExecuteScriptAsync(PageWatchdog.ReadyProbe);
                // Resultat tardif (renderer repris apres le delai) : observe, pour ne pas laisser une exception non geree.
                _ = script.ContinueWith(t => { _ = t.Exception; }, TaskScheduler.Default);
                Task finished = await Task.WhenAny(script, Task.Delay(ProbeTimeoutMs));
                if (finished == script && script.Status == TaskStatus.RanToCompletion)
                {
                    answered = true;
                    answer = script.Result;
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " sonde echec: " + ex.Message);
            }
            finally
            {
                probing = false;
            }
            // Etat change pendant la sonde (pause, navigation, recreation, fermeture) : aucune decision sur du perime.
            if (shutdown || target != web || paused || !initialized || !loaded)
            {
                return;
            }
            switch (PageWatchdog.Verdict(answered, answer, dojoPage))
            {
                case PageWatchdog.ProbeVerdict.Alive:
                    CoreLog.Write(Text + " page bridee, vivante : silence remis a zero");
                    watchdog.Reset();
                    return;
                case PageWatchdog.ProbeVerdict.ScriptStopped:
                    if (!watchdog.TryScriptReload())
                    {
                        // Sonde suivante a SilenceMs (pas a chaque tick) : le journal ne se remplit pas pendant l'attente.
                        CoreLog.Write(Text + " script de la page arrete : rechargement reporte (anti-rebond)");
                        watchdog.Reset();
                        return;
                    }
                    CoreLog.Write(Text + " script de la page arrete : rechargement");
                    Navigate();
                    return;
                case PageWatchdog.ProbeVerdict.Silent:
                    break;
            }
            if (!watchdog.TryReload())
            {
                CoreLog.Write(Text + " page muette : rechargement reporte (anti-rebond)");
                return;
            }
            CoreLog.Write(Text + " chien de garde : page muette, sonde sans reponse, rechargement");
            Navigate();
        }

        // Processus WebView2 en echec : rechargement de la page pour le rendu et le GPU (anti-rebond), navigateur mort
        // -> recreation par le chien de garde (WatchdogTick), autres types : journal seul.
        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            if (shutdown)
            {
                return;
            }
            CoreLog.Write(string.Format(CultureInfo.InvariantCulture, "{0} processus WebView2 en echec: {1} (code {2})",
                Text, e.ProcessFailedKind, e.ExitCode));
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                browserDead = true;
                initialized = false;
                loaded = false;
                return;
            }
            if (!ReloadsPage(e.ProcessFailedKind))
            {
                CoreLog.Write(Text + " processus en echec sans rechargement : " + e.ProcessFailedKind);
                return;
            }
            // Navigation deja en cours : pas de relance (les evenements se repetent tant que le renderer est fige).
            // L'escalade du chien de garde tranche si la navigation n'aboutit pas.
            if (reloading || !watchdog.TryReload())
            {
                CoreLog.Write(Text + " echec du processus : rechargement reporte (en cours ou anti-rebond)");
                return;
            }
            Navigate();
        }

        // Types d'echec qui justifient un rechargement : rendu (fige ou mort) et GPU. Les autres (utilitaires, sandbox,
        // plugins...) sont seulement journalises.
        private static bool ReloadsPage(CoreWebView2ProcessFailedKind kind)
        {
            return kind == CoreWebView2ProcessFailedKind.RenderProcessExited
                || kind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive
                || kind == CoreWebView2ProcessFailedKind.FrameRenderProcessExited
                || kind == CoreWebView2ProcessFailedKind.GpuProcessExited;
        }

        // Messages de la page : battement (dojo:alive, chien de garde) et erreurs JS (dojo:error:, journal seulement).
        // Les autres messages sont ignores.
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (shutdown)
            {
                return;
            }
            string message;
            try
            {
                message = e.TryGetWebMessageAsString();
            }
            catch (ArgumentException)
            {
                // Message non textuel : ignore.
                return;
            }
            if (string.Equals(message, PageWatchdog.AliveMessage, StringComparison.Ordinal))
            {
                dojoPage = true;
                watchdog.Reset();
                // Battement : le script tourne, les rechargements pour script arrete repartent de zero.
                watchdog.ResetScriptBackoff();
                return;
            }
            string error = PageWatchdog.PageError(message);
            if (error != null)
            {
                dojoPage = true;
                CoreLog.Write(Text + " erreur page: " + error);
            }
        }

        // Navigateur WebView2 mort : l'ancien controle est jete, un neuf prend sa place (Dock Fill), est relie
        // au relais souris, puis l'initialisation reprend. Appelee seulement hors pause.
        private void RecreateWeb()
        {
            browserDead = false;
            // Une initialisation restee en vol (ou ayant abouti sur l'ancien controle) ne compte plus.
            initialized = false;
            CoreLog.Write(Text + " navigateur WebView2 arrete : recreation du controle");
            WebView2 old = web;
            input.Detach(this);
            Controls.Remove(old);
            try
            {
                old.Dispose();
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " fermeture du controle echec: " + ex.Message);
            }
            ClearFrame();
            web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(web);
            input.Attach(this, web);
            input.SetSuspended(this, paused);
            // Gestionnaires a reattacher au nouveau controle et a son CoreWebView2 (InitializeAsync).
            handlersAttached = false;
            InitializeAsync();
        }

        // Pause : la derniere image reste sur le bureau. Capture AVANT le masquage (une WebView masquee ne dessine plus rien).
        // Si la reprise arrive pendant la capture, la WebView n'est jamais masquee. Capture en echec : fond noir, comme avant.
        private async void SuspendCore()
        {
            try
            {
                CoreWebView2 core = web.CoreWebView2;
                int seq = pauseSeq;
                Bitmap image = core != null ? await CaptureFrameAsync(core) : null;
                if (shutdown || !paused || seq != pauseSeq)
                {
                    if (image != null)
                    {
                        image.Dispose();
                    }
                    return;
                }
                if (image != null)
                {
                    ShowFrame(image);
                }
                web.Visible = false;
                if (core != null)
                {
                    SuspendAsync(core);
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " suspension echec: " + ex.Message);
            }
        }

        // Derniere image de la page (PNG, copie independante du flux). Null si la capture echoue ou depasse le delai.
        private async Task<Bitmap> CaptureFrameAsync(CoreWebView2 core)
        {
            var png = new MemoryStream();
            Task capture = null;
            try
            {
                capture = core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, png);
                if (await Task.WhenAny(capture, Task.Delay(CaptureTimeoutMs)) != capture)
                {
                    // La capture en cours ecrit encore dans le flux : il est libere quand elle se termine.
                    _ = capture.ContinueWith(delegate { png.Dispose(); }, TaskScheduler.Default);
                    CoreLog.Write(Text + " capture echec: delai depasse");
                    return null;
                }
                await capture;
                png.Position = 0;
                using (var decoded = new Bitmap(png))
                {
                    return new Bitmap(decoded);
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " capture echec: " + ex.Message);
                return null;
            }
            finally
            {
                if (capture == null || capture.IsCompleted)
                {
                    png.Dispose();
                }
            }
        }

        // Image sur le fond du formulaire, derriere la WebView masquee. L'ancienne image est liberee.
        private void ShowFrame(Bitmap image)
        {
            Image old = frame;
            frame = image;
            BackgroundImageLayout = FrameLayout(image.Size, ClientSize);
            BackgroundImage = image;
            if (old != null)
            {
                old.Dispose();
            }
        }

        // Retire l'image du fond et la libere (reprise, fermeture).
        private void ClearFrame()
        {
            if (frame == null)
            {
                return;
            }
            BackgroundImage = null;
            frame.Dispose();
            frame = null;
        }

        // Etiree quand les proportions de l'image sont celles de la fenetre, sinon ajustee sans deformation.
        private static ImageLayout FrameLayout(Size image, Size client)
        {
            if (image.Width <= 0 || image.Height <= 0 || client.Width <= 0 || client.Height <= 0)
            {
                return ImageLayout.Zoom;
            }
            double imageRatio = (double)image.Width / image.Height;
            double clientRatio = (double)client.Width / client.Height;
            return Math.Abs(imageRatio - clientRatio) <= clientRatio * 0.01 ? ImageLayout.Stretch : ImageLayout.Zoom;
        }

        private async void SuspendAsync(CoreWebView2 core)
        {
            try
            {
                bool suspended = await core.TrySuspendAsync();
                CoreLog.Write(Text + " TrySuspendAsync -> " + suspended);
                // Reprise demandee pendant la suspension : on reprend tout de suite.
                if (!paused && !shutdown)
                {
                    core.Resume();
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " suspension echec: " + ex.Message);
            }
        }

        private void ResumeCore()
        {
            // Une page suspendue ne bat pas : le delai de silence repart de la reprise.
            watchdog.Reset();
            CoreWebView2 core = web.CoreWebView2;
            try
            {
                if (core != null)
                {
                    core.Resume();
                }
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " reprise echec: " + ex.Message);
            }
            finally
            {
                // Toujours réafficher la WebView et retirer l'image figée, même si Resume() a échoué.
                web.Visible = true;
                ClearFrame();
            }
            PushSafe(true);
            if (pendingNavigate)
            {
                Navigate();
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (shutdown)
            {
                return;
            }
            // Navigation terminee (reussie ou non) : le renderer repond.
            reloading = false;
            // Fond vide apres un echec (ShowBlank) : ce n'est pas la page du dojo.
            if (string.Equals(web.CoreWebView2.Source, "about:blank", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            CoreLog.Write(Text + " NavigationCompleted IsSuccess=" + e.IsSuccess
                + " status=" + e.WebErrorStatus + " http=" + e.HttpStatusCode
                + " url=" + DojoLog.Redact(web.CoreWebView2.Source));
            if (e.IsSuccess)
            {
                loaded = true;
                watchdog.Reset();
                // Page revenue : le backoff des recreations repart de zero.
                watchdog.ResetRecreateBackoff();
                retryTimer.Stop();
                PushSafe(true);
                if (CoreLog.Enabled)
                {
                    probeTimer.Stop();
                    probeTimer.Start();
                }
                return;
            }
            // Annulation volontaire (lien externe, nouvelle navigation) : pas de nouvel essai.
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
            {
                return;
            }
            loaded = false;
            if (paused)
            {
                pendingNavigate = true;
            }
            else
            {
                ShowBlank();
            }
            // Un seul timer : le 2e evenement d'echec (page d'erreur) ne repousse pas le prochain essai.
            if (!retryTimer.Enabled)
            {
                retryTimer.Start();
            }
        }

        // Pas de page d'erreur WebView2 sur le bureau : fond vide en attendant le prochain essai (comme Mac).
        private void ShowBlank()
        {
            if (shutdown || !initialized)
            {
                return;
            }
            web.CoreWebView2.Navigate("about:blank");
        }

        // La page ne quitte jamais le dojo : tout lien vers un autre hote part dans le navigateur par defaut.
        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri target;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target))
            {
                e.Cancel = true;
                return;
            }
            if (IsInternal(target))
            {
                return;
            }
            e.Cancel = true;
            CoreLog.Write(Text + " lien externe: " + DojoLog.Redact(target.AbsoluteUri));
            OpenExternal(target);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            Uri target;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out target))
            {
                CoreLog.Write(Text + " nouvelle fenetre demandee: " + DojoLog.Redact(target.AbsoluteUri));
                OpenExternal(target);
            }
        }

        // Interne = meme schema et meme hote que l'URL configuree (un fichier local reste un fichier local).
        private bool IsInternal(Uri target)
        {
            switch (target.Scheme)
            {
                case "about":
                case "data":
                case "blob":
                case "chrome-error":
                    return true;
            }
            Uri home;
            return Uri.TryCreate(url, UriKind.Absolute, out home)
                && string.Equals(home.Scheme, target.Scheme, StringComparison.OrdinalIgnoreCase)
                && string.Equals(home.Host, target.Host, StringComparison.OrdinalIgnoreCase);
        }

        private static void OpenExternal(Uri target)
        {
            if (target.Scheme != "http" && target.Scheme != "https" && target.Scheme != "mailto")
            {
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                CoreLog.Write("ouverture externe echec: " + ex.Message);
            }
        }

        // Zone sure au format attendu par setSafe() de la page (CSS px = DIP / zoom).
        // Windows n'a pas d'encoche : notchW / notchH valent 0. La barre des taches, en haut, en bas, a gauche
        // ou a droite, decale la page (comme la barre de menus et le Dock cote Mac).
        private string SafeJson()
        {
            Screen screen = CurrentDisplay();
            double top, left, bottom, right;
            SafeArea.Compute(screen.Bounds, screen.WorkingArea, scale, zoom, out top, out left, out bottom, out right);
            return string.Format(CultureInfo.InvariantCulture,
                "{{top:{0},left:{1},bottom:{2},right:{3},notchW:0,notchH:0,mirror:{4}}}",
                (int)top, (int)left, (int)bottom, (int)right, mirror ? "true" : "false");
        }

        // Ecran relu a chaque calcul : la WorkingArea d'un objet Screen est une copie prise a sa creation,
        // alors que la barre des taches peut bouger ou se masquer. Repli sur Display si l'ecran n'est plus listé.
        private Screen CurrentDisplay()
        {
            foreach (Screen s in Screen.AllScreens)
            {
                if (string.Equals(s.DeviceName, Display.DeviceName, StringComparison.OrdinalIgnoreCase))
                {
                    return s;
                }
            }
            return Display;
        }

        private async void RunScript(string script)
        {
            try
            {
                await web.ExecuteScriptAsync(script);
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " script echec: " + ex.Message);
            }
        }

        private async void Probe()
        {
            if (shutdown || !initialized)
            {
                return;
            }
            try
            {
                string state = await web.ExecuteScriptAsync(
                    "JSON.stringify({ title: document.title, ready: document.readyState, "
                    + "safeTop: document.documentElement.style.getPropertyValue('--safe-top'), "
                    + "safeLeft: document.documentElement.style.getPropertyValue('--safe-left'), "
                    + "mirror: document.body.classList.contains('mirror'), "
                    + "statsEntries: performance.getEntriesByType('resource').filter(function (r) { "
                    + "return r.name.indexOf('/stats') >= 0; }).length })");
                CoreLog.Write(Text + " page: " + state);
            }
            catch (Exception ex)
            {
                CoreLog.Write(Text + " sonde echec: " + ex.Message);
            }
        }

        private static bool IsInteractive(DojoConfig cfg)
        {
            return string.Equals(cfg.Mode, "interactive", StringComparison.OrdinalIgnoreCase);
        }
    }
}
