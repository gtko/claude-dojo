using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DojoWallpaper
{
    // Relais souris vers la WebView quand le curseur est sur le bureau.
    // L'Explorateur place les icônes au-dessus de notre fenêtre : sans relais, aucun clic
    // n'atteint le fond. Les événements souris sont lus en Raw Input (lecture seule,
    // RIDEV_INPUTSINK, sans focus) puis reposts à la fenêtre de rendu WebView2 (PostMessage).
    // Nos messages ne partent que vers nos propres fenêtres de rendu : aucune entrée synthétique,
    // aucun hook bas niveau, aucune DLL injectée.
    //
    // Multi-écrans : Windows ne livre WM_INPUT qu'à UNE fenêtre par processus (la dernière enregistrée).
    // L'état est donc partagé par toutes les instances : une seule fenêtre de message cachée reçoit le
    // Raw Input, et c'est elle qui choisit la WebView sous le curseur (coordonnées écran physiques ;
    // l'application est PerMonitorV2, donc GetCursorPos et GetWindowRect sont dans la même unité).
    //
    // Qui est sous le curseur : parcours du z-order des fenêtres de haut niveau, du sommet vers le fond.
    // WindowFromPoint ignore les fenêtres désactivées (boîte modale) et laisserait passer le clic vers le
    // bureau situé dessous : il ne sert qu'à savoir si le point tombe sur notre WebView (voir IsDesktopAt).
    // Thread : celui de l'interface (Application.Run).
    public sealed class InputForwarder : IDisposable
    {
        // Résultat du spike : true = le relais PostMessage est fiable sur cette machine (voir le rapport).
        public static bool IsFeasible
        {
            get { return true; }
        }

        private const ushort UsagePageGeneric = 0x01;
        private const ushort UsageMouse = 0x02;
        private const uint RidevInputSink = 0x00000100;
        private const uint RidevRemove = 0x00000001;
        private const uint RidInput = 0x10000003;
        private const uint RimTypeMouse = 0;
        private const uint WmInput = 0x00FF;

        // Champs usButtonFlags de RAWMOUSE.
        private const ushort RiWheel = 0x0400;

        private const uint WmMouseMove = 0x0200;
        private const uint WmMouseWheel = 0x020A;
        private const uint WmMouseLeave = 0x02A3;

        private const int MkLButton = 0x0001;
        private const int MkRButton = 0x0002;
        private const int MkMButton = 0x0010;

        // Z-order (GetWindow), styles et DWM.
        private const uint GwHwndNext = 2;
        private const uint WsExTransparent = 0x00000020;
        private const uint DwmwaCloaked = 14;

        // Débit des WM_MOUSEMOVE relayés, relance de l'enregistrement Raw Input, rattrapage du dernier mouvement.
        private const long MoveHz = 60;
        private const int FlushMs = 17;
        private const int RetryMs = 5000;

        private sealed class ButtonMap
        {
            public ButtonMap(ushort down, ushort up, int mk, uint downMsg, uint upMsg)
            {
                Down = down;
                Up = up;
                Mk = mk;
                DownMsg = downMsg;
                UpMsg = upMsg;
            }

            public readonly ushort Down;
            public readonly ushort Up;
            public readonly int Mk;
            public readonly uint DownMsg;
            public readonly uint UpMsg;
        }

        private static readonly ButtonMap[] Buttons =
        {
            new ButtonMap(0x0001, 0x0002, MkLButton, 0x0201, 0x0202), // gauche
            new ButtonMap(0x0004, 0x0008, MkRButton, 0x0204, 0x0205), // droit
            new ButtonMap(0x0010, 0x0020, MkMButton, 0x0207, 0x0208), // milieu
        };

        private sealed class Target
        {
            public InputForwarder Owner; // instance qui a attaché la fenêtre
            public Form Form;
            public Control Web;     // WebView2 (typée Control : seul ce que la classe utilise est requis)
            public IntPtr Render;   // HWND Chrome_RenderWidgetHostHWND (mis en cache)
            public int Keys;        // MK_* des boutons relayés et enfoncés
            public bool Over;       // curseur actuellement relayé vers cette WebView
            public bool Suspended;  // écran en pause : rien n'est relayé
        }

        // Cibles de tous les relais (une par fenêtre d'écran). Accès depuis le thread d'interface uniquement.
        private static readonly List<Target> Targets = new List<Target>();

        // Fenêtre de message cachée partagée : existe tant qu'il reste au moins une cible.
        private static RawSink _sink;
        private static bool _registered;
        private static bool _registerFailing;  // une seule ligne de journal par série d'échecs

        // Minuteurs (thread d'interface) : nouvel essai d'enregistrement, et dernier mouvement écarté.
        private static System.Windows.Forms.Timer _retryTimer;
        private static System.Windows.Forms.Timer _flushTimer;

        // Chemin rapide : débit des mouvements, listes et tampons réutilisés (aucune allocation par WM_INPUT).
        private static readonly MoveLimiter Moves = new MoveLimiter(Stopwatch.Frequency / MoveHz);
        private static readonly List<WindowState> Walk = new List<WindowState>(16);
        private static readonly StringBuilder ClassName = new StringBuilder(64);
        private static readonly DesktopNative.EnumProc FindRender = FindRenderProc;
        private static IntPtr _foundRender;
        private static IntPtr _rawBuf;
        private static uint _rawCap;

        private readonly HashSet<Form> _suspendedForms = new HashSet<Form>(); // pauses reçues (avant ou après Attach)
        private bool _enabled;
        private bool _disposed;

        // Fenêtre de message cachée qui reçoit WM_INPUT.
        private sealed class RawSink : NativeWindow
        {
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == (int)WmInput)
                {
                    OnRawInput(m.LParam);
                }
                base.WndProc(ref m);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RAWINPUTDEVICE
        {
            public ushort usUsagePage;
            public ushort usUsage;
            public uint dwFlags;
            public IntPtr hwndTarget;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);

        [DllImport("user32.dll")]
        private static extern IntPtr GetTopWindow(IntPtr parent);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hwnd, uint command);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowEnabled(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hwnd, StringBuilder className, int maxCount);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out uint value, uint size);

        public InputForwarder()
        {
        }

        // true = mode interactif (relais actif). false = aucun relais, rien n'est lu.
        public bool Enabled
        {
            get { return _enabled; }
            set
            {
                if (_enabled == value) return;
                _enabled = value;
                if (!value) CancelOwned();
                SyncSink();
            }
        }

        // Associe la WebView à la fenêtre f (le curseur sur f et sur le bureau déclenche le relais).
        public void Attach(Form f, Control web)
        {
            if (f == null) throw new ArgumentNullException("f");
            if (web == null) throw new ArgumentNullException("web");
            if (_disposed) throw new ObjectDisposedException(GetType().Name);

            Target existing = FindTarget(f);
            if (existing != null)
            {
                if (existing.Owner == this) return;
                throw new InvalidOperationException("Cette fenêtre est déjà reliée à un autre relais.");
            }

            Targets.Add(new Target
            {
                Owner = this,
                Form = f,
                Web = web,
                Suspended = _suspendedForms.Contains(f),
            });
            SyncSink();
        }

        public void Detach(Form f)
        {
            _suspendedForms.Remove(f);
            for (int i = Targets.Count - 1; i >= 0; i--)
            {
                Target t = Targets[i];
                if (t.Owner == this && t.Form == f)
                {
                    Cancel(t);
                    Targets.RemoveAt(i);
                }
            }
            SyncSink();
        }

        // Écran en pause (WebView masquée et suspendue) : rien n'est relayé vers f tant que suspended est vrai.
        // Peut être appelée avant Attach : l'état est alors appliqué à l'attache.
        public void SetSuspended(Form f, bool suspended)
        {
            if (f == null) throw new ArgumentNullException("f");
            if (suspended)
            {
                _suspendedForms.Add(f);
            }
            else
            {
                _suspendedForms.Remove(f);
            }
            if (_disposed) return;

            Target t = FindTarget(f);
            if (t == null || t.Owner != this || t.Suspended == suspended) return;
            t.Suspended = suspended;
            if (suspended) Cancel(t);
            SyncSink();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _enabled = false;
            CancelOwned();
            for (int i = Targets.Count - 1; i >= 0; i--)
            {
                if (Targets[i].Owner == this) Targets.RemoveAt(i);
            }
            _suspendedForms.Clear();
            SyncSink();
            GC.SuppressFinalize(this);
        }

        private static Target FindTarget(Form f)
        {
            foreach (Target t in Targets)
            {
                if (t.Form == f) return t;
            }
            return null;
        }

        // Aligne la fenêtre partagée et l'enregistrement Raw Input sur l'état des cibles.
        // Le Raw Input n'est enregistré que s'il existe une cible éligible. Désenregistrement avant destruction.
        private static void SyncSink()
        {
            if (Targets.Count > 0 && _sink == null)
            {
                RawSink sink = new RawSink();
                sink.CreateHandle(new CreateParams { Parent = new IntPtr(-3) }); // HWND_MESSAGE
                _sink = sink;
            }
            UpdateRegistration();
            if (Targets.Count == 0 && _sink != null)
            {
                _sink.DestroyHandle();
                _sink = null;
                _registered = false;
                _registerFailing = false;
                StopRetry();
                StopFlush();
                FreeRawBuffer();
            }
        }

        // Enregistre (ou retire) le Raw Input. Un échec est journalisé (erreur Win32) et réessayé dans RetryMs.
        private static void UpdateRegistration()
        {
            if (_sink == null || _sink.Handle == IntPtr.Zero) return;
            bool want = AnyEligible();
            if (want == _registered) return;

            RAWINPUTDEVICE[] rid = new RAWINPUTDEVICE[1];
            rid[0].usUsagePage = UsagePageGeneric;
            rid[0].usUsage = UsageMouse;
            rid[0].dwFlags = want ? RidevInputSink : RidevRemove;
            rid[0].hwndTarget = want ? _sink.Handle : IntPtr.Zero;
            if (RegisterRawInputDevices(rid, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
            {
                _registered = want;
                StopRetry();
                if (_registerFailing)
                {
                    _registerFailing = false;
                    DojoLog.Write("Raw Input : enregistrement du relais souris rétabli.");
                }
                return;
            }

            // Lecture immédiate : GetLastWin32Error ne vaut que pour le dernier appel Win32.
            int error = Marshal.GetLastWin32Error();
            if (!_registerFailing)
            {
                _registerFailing = true;
                DojoLog.Write("ERREUR Raw Input : " + (want ? "enregistrement" : "retrait")
                    + " du relais souris refusé (erreur Win32 " + error + "), nouvel essai dans "
                    + (RetryMs / 1000) + " s.");
            }
            StartRetry();
        }

        private static void StartRetry()
        {
            if (_retryTimer == null)
            {
                _retryTimer = new System.Windows.Forms.Timer { Interval = RetryMs };
                _retryTimer.Tick += delegate
                {
                    _retryTimer.Stop();
                    UpdateRegistration();
                };
            }
            _retryTimer.Stop();
            _retryTimer.Start();
        }

        private static void StopRetry()
        {
            if (_retryTimer != null) _retryTimer.Stop();
        }

        // Mouvement écarté par la limite de débit : la position finale est redonnée après FlushMs,
        // pour que le survol ne reste pas en retard quand la souris s'arrête.
        private static void ArmFlush()
        {
            if (_flushTimer == null)
            {
                _flushTimer = new System.Windows.Forms.Timer { Interval = FlushMs };
                _flushTimer.Tick += delegate
                {
                    _flushTimer.Stop();
                    if (AnyEligible()) HandleMouse(0, 0);
                };
            }
            if (!_flushTimer.Enabled) _flushTimer.Start();
        }

        private static void StopFlush()
        {
            if (_flushTimer != null) _flushTimer.Stop();
        }

        // Cible éligible : relais activé pour son instance, écran non en pause, fenêtre vivante.
        private static bool Eligible(Target t)
        {
            return t.Owner._enabled && !t.Suspended && !t.Form.IsDisposed;
        }

        private static bool AnyEligible()
        {
            foreach (Target t in Targets)
            {
                if (Eligible(t)) return true;
            }
            return false;
        }

        // Vrai si un relais est en cours (curseur relayé ou bouton enfoncé) : il doit être terminé proprement.
        private static bool AnyActive()
        {
            foreach (Target t in Targets)
            {
                if (t.Over || t.Keys != 0) return true;
            }
            return false;
        }

        private static uint RawHeaderSize
        {
            get { return IntPtr.Size == 8 ? 24u : 16u; }
        }

        // Tampon réutilisé pour GetRawInputData (agrandi au besoin, libéré quand plus aucune cible).
        private static IntPtr RawBuffer(uint size)
        {
            if (_rawBuf == IntPtr.Zero || size > _rawCap)
            {
                FreeRawBuffer();
                _rawCap = Math.Max(size, 64u);
                _rawBuf = Marshal.AllocHGlobal((int)_rawCap);
            }
            return _rawBuf;
        }

        private static void FreeRawBuffer()
        {
            if (_rawBuf != IntPtr.Zero) Marshal.FreeHGlobal(_rawBuf);
            _rawBuf = IntPtr.Zero;
            _rawCap = 0;
        }

        private static void OnRawInput(IntPtr hRaw)
        {
            // Chemin rapide : aucune cible éligible, rien d'autre à faire.
            if (!AnyEligible()) return;

            uint size = 0;
            GetRawInputData(hRaw, RidInput, IntPtr.Zero, ref size, RawHeaderSize);
            if (size == 0 || size > 512) return;

            IntPtr buf = RawBuffer(size);
            if (GetRawInputData(hRaw, RidInput, buf, ref size, RawHeaderSize) == uint.MaxValue) return;
            if ((uint)Marshal.ReadInt32(buf) != RimTypeMouse) return;

            // RAWMOUSE : usFlags (0), ulButtons -> usButtonFlags (4) et usButtonData (6).
            int mouse = (int)RawHeaderSize;
            ushort flags = unchecked((ushort)Marshal.ReadInt16(buf, mouse + 4));
            short wheel = Marshal.ReadInt16(buf, mouse + 6);
            HandleMouse(flags, wheel);
        }

        private static void HandleMouse(ushort flags, short wheel)
        {
            DesktopNative.POINT cur;
            if (!DesktopNative.GetCursorPos(out cur)) return;

            bool wheelEvent = (flags & RiWheel) != 0;
            bool moveOnly = flags == 0; // ni bouton ni molette : un simple déplacement
            Target pick = PickTarget(cur);
            bool onDesktop = pick != null && IsDesktopAt(cur, pick.Form);

            // Chemin rapide : hors du bureau, sans relais en cours, il n'y a rien à faire.
            if (!onDesktop && !AnyActive()) return;

            foreach (Target t in Targets)
            {
                IntPtr r = RenderOf(t);
                if (r == IntPtr.Zero) continue;

                if (!(onDesktop && t == pick))
                {
                    // Curseur ailleurs : on sort de la WebView, mais les relâchements restent
                    // transmis à la cible qui a reçu l'appui (sinon une capture resterait bloquée).
                    if (t.Over)
                    {
                        t.Over = false;
                        DesktopNative.PostMessage(r, WmMouseLeave, IntPtr.Zero, IntPtr.Zero);
                    }
                    foreach (ButtonMap b in Buttons)
                    {
                        if ((flags & b.Up) != 0 && (t.Keys & b.Mk) != 0)
                        {
                            t.Keys &= ~b.Mk;
                            PostClient(r, b.UpMsg, new IntPtr(t.Keys), cur);
                        }
                    }
                    continue;
                }

                t.Over = true;
                if (!wheelEvent)
                {
                    // Débit limité à ~60 Hz pour les simples déplacements ; le reste passe toujours.
                    if (!moveOnly || Moves.Allow(Stopwatch.GetTimestamp()))
                    {
                        PostClient(r, WmMouseMove, new IntPtr(t.Keys), cur);
                    }
                    else
                    {
                        ArmFlush();
                    }
                }
                foreach (ButtonMap b in Buttons)
                {
                    if ((flags & b.Down) != 0)
                    {
                        t.Keys |= b.Mk;
                        PostClient(r, b.DownMsg, new IntPtr(t.Keys), cur);
                    }
                    if ((flags & b.Up) != 0)
                    {
                        t.Keys &= ~b.Mk;
                        PostClient(r, b.UpMsg, new IntPtr(t.Keys), cur);
                    }
                }
                if (wheelEvent)
                {
                    // WM_MOUSEWHEEL : wParam = delta (haut) + touches ; lParam = coordonnées écran.
                    IntPtr w = new IntPtr(((int)wheel << 16) | t.Keys);
                    DesktopNative.PostMessage(r, WmMouseWheel, w, MakeLParam(cur.X, cur.Y));
                }
            }
        }

        // Cible éligible dont la fenêtre contient le point p (coordonnées écran physiques), ou null.
        private static Target PickTarget(DesktopNative.POINT p)
        {
            foreach (Target t in Targets)
            {
                if (!Eligible(t) || !t.Form.IsHandleCreated) continue;
                Rectangle rc;
                if (TryWindowRect(t.Form.Handle, out rc) && rc.Width > 0 && rc.Height > 0 && rc.Contains(p.X, p.Y))
                {
                    return t;
                }
            }
            return null;
        }

        private static bool TryWindowRect(IntPtr hwnd, out Rectangle rect)
        {
            DesktopNative.RECT rc;
            if (DesktopNative.GetWindowRect(hwnd, out rc))
            {
                rect = Rectangle.FromLTRB(rc.Left, rc.Top, rc.Right, rc.Bottom);
                return true;
            }
            rect = Rectangle.Empty;
            return false;
        }

        // Vrai si le point est sur le bureau : la fenêtre au sommet à cet endroit est Progman ou WorkerW,
        // notre fenêtre est active, et le point ne tombe pas sur notre WebView (son entrée native la touche déjà).
        private static bool IsDesktopAt(DesktopNative.POINT p, Form f)
        {
            IntPtr self = f.Handle;
            bool ownEnabled = IsWindowEnabled(self);
            if (!ownEnabled) return false;

            // Point sur notre WebView (ou un de ses enfants) : entrée native, pas de relais.
            IntPtr hit = DesktopNative.WindowFromPoint(p);
            if (hit == IntPtr.Zero || hit == self || DesktopNative.IsChild(self, hit)) return false;

            WindowRole top;
            if (TopmostAt(p, self, out top))
            {
                return HitRules.ShouldRelay(top, ownEnabled);
            }

            // Repli : aucune fenêtre de haut niveau ne contient le point (bureau dont le rectangle ne couvre pas
            // cet écran). Aucun intercepteur n'existe alors, donc la racine de la fenêtre sous le curseur fait foi.
            ReadClass(DesktopNative.GetAncestor(hit, DesktopNative.GaRoot));
            return ClassEquals("Progman") || ClassEquals("WorkerW");
        }

        // Rôle de la fenêtre de haut niveau qui intercepte p, parcours du z-order (sommet -> fond).
        // Seules les fenêtres qui contiennent le point sont décrites (les autres ne peuvent pas intercepter).
        private static bool TopmostAt(DesktopNative.POINT p, IntPtr self, out WindowRole role)
        {
            Point pt = new Point(p.X, p.Y);
            Walk.Clear();
            for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = GetWindow(h, GwHwndNext))
            {
                Rectangle rc;
                if (!TryWindowRect(h, out rc) || !rc.Contains(pt)) continue;

                WindowState s = Describe(h, self, rc);
                Walk.Add(s);
                if (HitRules.Intercepts(s, pt)) break;
            }
            return HitRules.TryTopmost(Walk, pt, out role);
        }

        private static WindowState Describe(IntPtr h, IntPtr self, Rectangle rc)
        {
            WindowState s = new WindowState();
            s.Rect = rc;
            s.Visible = IsWindowVisible(h);
            s.Minimized = IsIconic(h);
            s.Transparent = (DesktopNative.GetExStyle(h) & WsExTransparent) != 0;
            s.Cloaked = IsCloaked(h);
            if (h == self)
            {
                s.Role = WindowRole.App;
            }
            else
            {
                ReadClass(h);
                s.Role = ClassEquals("Progman") || ClassEquals("WorkerW") ? WindowRole.Desktop : WindowRole.Other;
            }
            return s;
        }

        private static bool IsCloaked(IntPtr h)
        {
            uint cloaked;
            return DwmGetWindowAttribute(h, DwmwaCloaked, out cloaked, 4) == 0 && cloaked != 0;
        }

        // Lit la classe de h dans ClassName (tampon réutilisé).
        private static void ReadClass(IntPtr h)
        {
            ClassName.Clear();
            GetClassNameW(h, ClassName, ClassName.Capacity);
        }

        // Compare ClassName à name sans créer de chaîne.
        private static bool ClassEquals(string name)
        {
            if (ClassName.Length != name.Length) return false;
            for (int i = 0; i < name.Length; i++)
            {
                if (ClassName[i] != name[i]) return false;
            }
            return true;
        }

        // Termine le relais en cours vers t (pause, désactivation, détachement) : sortie du curseur et
        // relâchement des boutons encore enfoncés, pour ne laisser aucune capture bloquée dans la WebView.
        private static void Cancel(Target t)
        {
            DesktopNative.POINT cur;
            bool hasCursor = DesktopNative.GetCursorPos(out cur);
            IntPtr r = RenderOf(t);
            if (r != IntPtr.Zero)
            {
                if (t.Over)
                {
                    DesktopNative.PostMessage(r, WmMouseLeave, IntPtr.Zero, IntPtr.Zero);
                }
                if (hasCursor)
                {
                    foreach (ButtonMap b in Buttons)
                    {
                        if ((t.Keys & b.Mk) != 0)
                        {
                            t.Keys &= ~b.Mk;
                            PostClient(r, b.UpMsg, new IntPtr(t.Keys), cur);
                        }
                    }
                }
            }
            t.Over = false;
            t.Keys = 0;
        }

        private void CancelOwned()
        {
            foreach (Target t in Targets)
            {
                if (t.Owner == this) Cancel(t);
            }
        }

        // Fenêtre de rendu WebView2 (recherchée lazily : elle n'existe qu'après l'initialisation).
        private static IntPtr RenderOf(Target t)
        {
            if (t.Render != IntPtr.Zero && DesktopNative.IsWindow(t.Render)) return t.Render;
            t.Render = IntPtr.Zero;
            if (!t.Web.IsHandleCreated) return IntPtr.Zero;

            _foundRender = IntPtr.Zero;
            DesktopNative.EnumChildWindows(t.Web.Handle, FindRender, IntPtr.Zero);
            t.Render = _foundRender;
            return t.Render;
        }

        private static bool FindRenderProc(IntPtr h, IntPtr l)
        {
            ReadClass(h);
            if (!ClassEquals("Chrome_RenderWidgetHostHWND")) return true;
            _foundRender = h;
            return false;
        }

        // Poste un message souris avec coordonnées client de la fenêtre de rendu (pixels physiques).
        // L'origine client de la fenêtre de rendu est lue (ClientToScreen) puis soustraite par ScreenHitTest.ToClient.
        private static void PostClient(IntPtr render, uint msg, IntPtr wParam, DesktopNative.POINT screen)
        {
            DesktopNative.POINT origin = new DesktopNative.POINT { X = 0, Y = 0 };
            DesktopNative.ClientToScreen(render, ref origin);
            Point c = ScreenHitTest.ToClient(new Point(origin.X, origin.Y), new Point(screen.X, screen.Y));
            DesktopNative.PostMessage(render, msg, wParam, MakeLParam(c.X, c.Y));
        }

        private static IntPtr MakeLParam(int x, int y)
        {
            return new IntPtr((y << 16) | (x & 0xFFFF));
        }
    }

    // Rôle d'une fenêtre de haut niveau pour le relais.
    internal enum WindowRole
    {
        Other,    // autre application : bloque le relais si elle est au-dessus du bureau
        Desktop,  // Progman ou WorkerW (le bureau et son hôte) : reçoit le relais
        App,      // notre fenêtre : son entrée native la touche déjà, pas de relais
    }

    // État d'une fenêtre de haut niveau au moment du test (rempli par InputForwarder, sans appel Win32 ici).
    internal struct WindowState
    {
        public Rectangle Rect;
        public bool Visible;
        public bool Cloaked;      // DWMWA_CLOAKED : masquée par le système (autre bureau virtuel, UWP masqué)
        public bool Transparent;  // WS_EX_TRANSPARENT : laisse passer les clics
        public bool Minimized;
        public WindowRole Role;
    }

    // Logique pure du relais : quelle fenêtre est au point, et si le relais est permis (sans HWND).
    internal static class HitRules
    {
        // Vrai si la fenêtre reçoit les clics en p. Une fenêtre désactivée (boîte modale) compte : elle bloque.
        public static bool Intercepts(WindowState w, Point p)
        {
            return w.Visible && !w.Cloaked && !w.Transparent && !w.Minimized
                && w.Rect.Width > 0 && w.Rect.Height > 0 && w.Rect.Contains(p);
        }

        // zOrder : fenêtres de haut niveau, du sommet vers le fond. Rend le rôle de la première qui intercepte p.
        public static bool TryTopmost(IList<WindowState> zOrder, Point p, out WindowRole role)
        {
            role = WindowRole.Other;
            if (zOrder == null) return false;
            for (int i = 0; i < zOrder.Count; i++)
            {
                if (!Intercepts(zOrder[i], p)) continue;
                role = zOrder[i].Role;
                return true;
            }
            return false;
        }

        // Relais seulement si le sommet est le bureau, et si notre fenêtre n'est pas bloquée elle-même (modale).
        public static bool ShouldRelay(WindowRole top, bool ownEnabled)
        {
            return top == WindowRole.Desktop && ownEnabled;
        }
    }

    // Limite de débit : Allow renvoie true au plus une fois par intervalle (unités de temps, ticks).
    internal sealed class MoveLimiter
    {
        private readonly long _interval;
        private long _last;
        private bool _any;

        public MoveLimiter(long interval)
        {
            _interval = interval;
        }

        public bool Allow(long now)
        {
            if (_any && now - _last < _interval) return false;
            _any = true;
            _last = now;
            return true;
        }
    }
}
