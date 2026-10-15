using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DojoWallpaper
{
    // Fond d'écran intégré au bureau, comme Lively : la fenêtre devient enfant du bureau,
    // juste sous les icônes. Seules des API Win32 publiques et le message 0x052C de
    // l'Explorateur sont utilisés : aucune injection dans un autre processus, aucun hook.
    public static class DesktopHost
    {
        // Réessai d'incrustation : toutes les 2 s pendant 2 min (ouverture de session), puis toutes les 30 s.
        private const int EmbedFastMs = 2000;
        private const int EmbedSlowMs = 30000;
        private static readonly TimeSpan EmbedFastPeriod = TimeSpan.FromMinutes(2);

        private sealed class State
        {
            public Rectangle Bounds;
            public bool Embedded;
            public IntPtr Host; // parent réel quand Embedded : Progman ou WorkerW
        }

        private static readonly ConditionalWeakTable<Form, State> States = new ConditionalWeakTable<Form, State>();

        // Incruste f sous les icônes, à boundsPx (pixels physiques, coordonnées du bureau virtuel).
        // f doit déjà être affiché (Show). Renvoie false si l'incrustation est impossible : le repli
        // (fenêtre flottante hors Alt+Tab) est alors appliqué, et l'appelant peut réessayer plus tard.
        public static bool Embed(Form f, Rectangle boundsPx)
        {
            if (f == null) throw new ArgumentNullException("f");
            // Handle absent ou détruit (l'Explorateur a redémarré) : rien à incruster, le manager reconstruit la fenêtre.
            if (!f.IsHandleCreated || !DesktopNative.IsWindow(f.Handle)) return false;
            State st = StateOf(f);
            st.Bounds = boundsPx;
            IntPtr h = f.Handle;

            IntPtr parent, after;
            if (FindHost(out parent, out after))
            {
                try
                {
                    // SetParent renvoie l'ancien parent, NULL en cas d'échec. GetAncestor(GA_PARENT) confirme le nouveau parent réel :
                    // GetParent renverrait le propriétaire (NULL) tant que WS_CHILD n'est pas posé (SetStyles vient après).
                    IntPtr previous = DesktopNative.SetParent(h, parent);
                    if (previous != IntPtr.Zero && DesktopNative.GetAncestor(h, 1) == parent)
                    {
                        SetStyles(h, true);
                        DesktopNative.POINT origin = new DesktopNative.POINT { X = boundsPx.X, Y = boundsPx.Y };
                        DesktopNative.ScreenToClient(parent, ref origin);
                        if (DesktopNative.SetWindowPos(h, after, origin.X, origin.Y, boundsPx.Width, boundsPx.Height,
                                DesktopNative.SwpNoActivate | DesktopNative.SwpFrameChanged | DesktopNative.SwpShowWindow))
                        {
                            st.Embedded = true;
                            st.Host = parent;
                            return true;
                        }
                    }
                }
                catch (Exception)
                {
                    // Repli ci-dessous.
                }
            }

            ApplyFallback(f, boundsPx);
            return false;
        }

        // Retire f du bureau : fenêtre de niveau haut à sa dernière position connue.
        // À appeler fenêtre masquée : une fenêtre encore visible passerait au premier plan, plein écran, le temps de sa fermeture.
        public static void Detach(Form f)
        {
            if (f == null || f.IsDisposed || !f.IsHandleCreated) return;
            IntPtr h = f.Handle;
            State st = StateOf(f);
            DesktopNative.SetParent(h, IntPtr.Zero);
            SetStyles(h, false);
            Rectangle b = st.Bounds.IsEmpty ? f.Bounds : st.Bounds;
            DesktopNative.SetWindowPos(h, DesktopNative.HwndTop, b.X, b.Y, b.Width, b.Height,
                DesktopNative.SwpNoActivate | DesktopNative.SwpFrameChanged);
            st.Embedded = false;
            st.Host = IntPtr.Zero;
        }

        // Vrai si f est enfant de l'hôte où elle a été incrustée (parent réel vérifié, pas seulement WS_CHILD).
        public static bool IsEmbedded(Form f)
        {
            if (f == null || f.IsDisposed || !f.IsHandleCreated) return false;
            IntPtr h = f.Handle;
            State st = StateOf(f);
            return st.Embedded && st.Host != IntPtr.Zero && DesktopNative.IsWindow(h)
                && DesktopNative.GetParent(h) == st.Host
                && (DesktopNative.GetStyle(h) & DesktopNative.WsChild) != 0;
        }

        // Vrai si f a perdu son bureau et doit être reconstruite : handle détruit (l'Explorateur a redémarré)
        // ou incrustée dans un hôte qui n'est plus son parent réel. Une fenêtre en repli n'est pas périmée :
        // l'appelant réessaie alors simplement l'incrustation.
        public static bool IsStale(Form f)
        {
            if (f == null || f.IsDisposed) return false;
            if (!f.IsHandleCreated) return true;
            IntPtr h = f.Handle;
            if (!DesktopNative.IsWindow(h)) return true;
            State st = StateOf(f);
            return st.Embedded && DesktopNative.GetParent(h) != st.Host;
        }

        // Délai avant le prochain essai d'incrustation d'une fenêtre restée en repli, selon le temps écoulé
        // depuis le premier essai.
        public static int EmbedRetryDelayMs(TimeSpan elapsed)
        {
            return elapsed < EmbedFastPeriod ? EmbedFastMs : EmbedSlowMs;
        }

        private static State StateOf(Form f)
        {
            return States.GetValue(f, key => new State());
        }

        // Trouve le parent (Progman ou WorkerW) et la position z (après quel frère).
        private static bool FindHost(out IntPtr parent, out IntPtr after)
        {
            parent = IntPtr.Zero;
            after = IntPtr.Zero;
            IntPtr progman = FindProgman();
            if (progman == IntPtr.Zero) return false;

            // Windows 11 24H2 et plus récent : SHELLDLL_DefView et le WorkerW de fond sont enfants de Progman.
            IntPtr defView = DesktopNative.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (defView != IntPtr.Zero)
            {
                if (DesktopNative.FindWindowEx(progman, IntPtr.Zero, "WorkerW", null) == IntPtr.Zero) Spawn(progman);
                parent = progman;
                after = defView; // z-order : juste sous les icônes, au-dessus du fond et des autres fonds (Lively)
                return true;
            }

            // Disposition ancienne : WorkerW top-level placé derrière la fenêtre qui porte SHELLDLL_DefView.
            IntPtr worker = FindLegacyWorker();
            if (worker == IntPtr.Zero)
            {
                Spawn(progman);
                worker = FindLegacyWorker();
            }
            if (worker == IntPtr.Zero) return false;
            parent = worker;
            after = DesktopNative.HwndTop; // au sommet des enfants du WorkerW, sous la fenêtre des icônes
            return true;
        }

        // FindWindow("Progman", null) renvoie 0 sur Windows 11 25H2 : on cherche par titre
        // « Program Manager », puis par classe en énumérant les fenêtres de haut niveau.
        private static IntPtr FindProgman()
        {
            IntPtr p = DesktopNative.FindWindow("Progman", "Program Manager");
            if (p != IntPtr.Zero) return p;

            IntPtr found = IntPtr.Zero;
            DesktopNative.EnumWindows((top, l) =>
            {
                if (DesktopNative.ClassOf(top) == "Progman")
                {
                    found = top;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private static IntPtr FindLegacyWorker()
        {
            IntPtr worker = IntPtr.Zero;
            DesktopNative.EnumWindows((top, l) =>
            {
                if (DesktopNative.FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
                {
                    worker = DesktopNative.FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
                }
                return worker == IntPtr.Zero; // continuer tant que rien n'est trouvé
            }, IntPtr.Zero);
            return worker;
        }

        // Demande à Progman de créer le WorkerW de fond (variantes selon la version de Windows).
        private static void Spawn(IntPtr progman)
        {
            IntPtr res;
            DesktopNative.SendMessageTimeout(progman, DesktopNative.MsgSpawnWorkerW, new IntPtr(0xD), new IntPtr(1),
                DesktopNative.SmtoNormal, 1000, out res);
            DesktopNative.SendMessageTimeout(progman, DesktopNative.MsgSpawnWorkerW, IntPtr.Zero, IntPtr.Zero,
                DesktopNative.SmtoNormal, 1000, out res);
        }

        // Repli : fenêtre de niveau haut, sans bordure, hors Alt+Tab, sans activation.
        // HWND_BOTTOM la place sous Progman : le bureau peut la masquer (non vérifié visuellement,
        // Lively affichait déjà la même page). Le repli ne sert qu'aux cas sans hôte de bureau.
        private static void ApplyFallback(Form f, Rectangle b)
        {
            IntPtr h = f.Handle;
            DesktopNative.SetParent(h, IntPtr.Zero);
            SetStyles(h, false);
            DesktopNative.SetWindowPos(h, DesktopNative.HwndBottom, b.X, b.Y, b.Width, b.Height,
                DesktopNative.SwpNoActivate | DesktopNative.SwpFrameChanged | DesktopNative.SwpShowWindow);
            State st = StateOf(f);
            st.Embedded = false;
            st.Host = IntPtr.Zero;
        }

        // child=true : enfant du bureau (pas de POPUP). Dans les deux cas : outil (hors Alt+Tab), sans activation.
        private static void SetStyles(IntPtr h, bool child)
        {
            uint style = DesktopNative.GetStyle(h);
            style = child
                ? ((style & ~DesktopNative.WsPopup) | DesktopNative.WsChild)
                : ((style & ~DesktopNative.WsChild) | DesktopNative.WsPopup);
            DesktopNative.SetStyle(h, style);

            uint ex = DesktopNative.GetExStyle(h);
            ex = (ex | DesktopNative.WsExToolWindow | DesktopNative.WsExNoActivate) & ~DesktopNative.WsExAppWindow;
            DesktopNative.SetExStyle(h, ex);
        }
    }

    // Un écran tel que la reconstruction du fond le voit : nom de périphérique, bornes physiques, échelle DPI.
    internal sealed class ScreenDescriptor
    {
        public ScreenDescriptor(string deviceName, Rectangle bounds, double scale)
        {
            DeviceName = deviceName ?? string.Empty;
            Bounds = bounds;
            Scale = scale;
        }

        public string DeviceName { get; private set; }

        public Rectangle Bounds { get; private set; }

        public double Scale { get; private set; }
    }

    // Signature de la disposition des écrans (fonction pure, testable sans écran).
    // L'ordre de Screen.AllScreens est conservé : il fixe les index des écrans désactivés. Deux dispositions
    // identiques donnent la même chaîne ; tout changement de nom, de bornes ou d'échelle la modifie.
    internal static class DisplaySignature
    {
        public static string Of(IEnumerable<ScreenDescriptor> screens)
        {
            if (screens == null) return string.Empty;
            var sb = new StringBuilder();
            foreach (ScreenDescriptor s in screens)
            {
                sb.Append(string.Format(CultureInfo.InvariantCulture, "{0}|{1},{2},{3},{4}|{5:R};",
                    s.DeviceName, s.Bounds.X, s.Bounds.Y, s.Bounds.Width, s.Bounds.Height, s.Scale));
            }
            return sb.ToString();
        }
    }

    // Appels Win32 partagés avec InputForwarder. Tous publics dans l'Explorateur, aucun hook.
    internal static class DesktopNative
    {
        internal delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

        internal const uint MsgSpawnWorkerW = 0x052C;
        internal const uint SmtoNormal = 0x0000;
        internal const int GwlStyle = -16;
        internal const int GwlExStyle = -20;
        internal const uint WsPopup = 0x80000000;
        internal const uint WsChild = 0x40000000;
        internal const uint WsExToolWindow = 0x00000080;
        internal const uint WsExAppWindow = 0x00040000;
        internal const uint WsExNoActivate = 0x08000000;
        internal const uint SwpNoActivate = 0x0010;
        internal const uint SwpFrameChanged = 0x0020;
        internal const uint SwpShowWindow = 0x0040;
        internal const uint GaRoot = 2;
        internal static readonly IntPtr HwndTop = IntPtr.Zero;
        internal static readonly IntPtr HwndBottom = new IntPtr(1);

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

        [DllImport("user32.dll")]
        internal static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lParam);

        [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hwnd, StringBuilder className, int maxCount);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam,
            uint flags, uint timeout, out IntPtr result);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

        [DllImport("user32.dll", SetLastError = true)]
        internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        internal static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);

        [DllImport("user32.dll")]
        internal static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLongW(IntPtr hwnd, int index);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
        private static extern int SetWindowLongW(IntPtr hwnd, int index, int value);

        [DllImport("user32.dll")]
        internal static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        internal static extern bool IsChild(IntPtr parent, IntPtr child);

        [DllImport("user32.dll")]
        internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        internal static extern bool GetCursorPos(out POINT point);

        [DllImport("user32.dll")]
        internal static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetParent(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", EntryPoint = "PostMessageW")]
        internal static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

        internal static string ClassOf(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return string.Empty;
            StringBuilder sb = new StringBuilder(256);
            GetClassNameW(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        internal static uint GetStyle(IntPtr hwnd)
        {
            return unchecked((uint)GetWindowLongW(hwnd, GwlStyle));
        }

        internal static uint GetExStyle(IntPtr hwnd)
        {
            return unchecked((uint)GetWindowLongW(hwnd, GwlExStyle));
        }

        internal static void SetStyle(IntPtr hwnd, uint style)
        {
            SetWindowLongW(hwnd, GwlStyle, unchecked((int)style));
        }

        internal static void SetExStyle(IntPtr hwnd, uint ex)
        {
            SetWindowLongW(hwnd, GwlExStyle, unchecked((int)ex));
        }
    }
}
