using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace DojoWallpaper
{
    // Detection des raisons de pause par evenements :
    //  - SetWinEventHook out-of-context (+ SKIPOWNPROCESS) sur foreground, minimize, show/hide/destroy, location, cloak ;
    //  - SystemEvents (PowerModeChanged, DisplaySettingsChanged) ;
    //  - recalcul regroupe (200 ms) et filet de securite toutes les 10 s.
    // A construire et utiliser sur le thread UI : la boucle de messages doit tourner (hooks et timers en dependent).
    // Aucun hook d'entree clavier/souris, aucune injection.
    public sealed class PauseEngine : IDisposable
    {
        private const int CoalesceMs = 200;
        private const int SafetyPollMs = 10000;

        private readonly Func<DojoConfig> _getConfig;
        private readonly SynchronizationContext _sync;
        private readonly int _uiThreadId;
        private readonly int _ownProcessId;
        private readonly System.Windows.Forms.Timer _coalesce;
        private readonly System.Windows.Forms.Timer _safety;
        private readonly NativeMethods.WinEventProc _winEventProc;
        private readonly List<IntPtr> _hooks = new List<IntPtr>();
        private readonly Dictionary<string, PauseReason> _reasons =
            new Dictionary<string, PauseReason>(StringComparer.OrdinalIgnoreCase);
        private readonly StringBuilder _classBuffer = new StringBuilder(256);
        private volatile bool _manualPause;
        private bool _disposed;
        private bool _refreshing;
        private bool _refreshAgain;
        private bool _systemEventsHooked;

        public PauseEngine(Func<DojoConfig> getConfig)
        {
            if (getConfig == null)
            {
                throw new ArgumentNullException("getConfig");
            }

            _getConfig = getConfig;
            _sync = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            _uiThreadId = Thread.CurrentThread.ManagedThreadId;
            using (Process self = Process.GetCurrentProcess())
            {
                _ownProcessId = self.Id;
            }

            _coalesce = new System.Windows.Forms.Timer();
            _coalesce.Interval = CoalesceMs;
            _coalesce.Tick += delegate
            {
                _coalesce.Stop();
                RefreshCore();
            };

            _safety = new System.Windows.Forms.Timer();
            _safety.Interval = SafetyPollMs;
            _safety.Tick += delegate { RefreshCore(); };
            _safety.Start();

            _winEventProc = OnWinEvent;
            InstallHook(NativeMethods.EVENT_SYSTEM_FOREGROUND, NativeMethods.EVENT_SYSTEM_FOREGROUND);
            InstallHook(NativeMethods.EVENT_SYSTEM_MINIMIZESTART, NativeMethods.EVENT_SYSTEM_MINIMIZEEND);
            InstallHook(NativeMethods.EVENT_OBJECT_DESTROY, NativeMethods.EVENT_OBJECT_HIDE);
            InstallHook(NativeMethods.EVENT_OBJECT_LOCATIONCHANGE, NativeMethods.EVENT_OBJECT_LOCATIONCHANGE);
            InstallHook(NativeMethods.EVENT_OBJECT_CLOAKED, NativeMethods.EVENT_OBJECT_UNCLOAKED);

            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
            _systemEventsHooked = true;

            // Etat initial : calcule apres la fin du constructeur, pour que les abonnes puissent se brancher.
            ScheduleRefresh();
        }

        // Levee sur le thread UI quand la raison d'un ecran change (etat de base : None).
        public event Action<Screen, PauseReason> ScreenChanged;

        // Pause manuelle (ex. clic dans la fenetre de config) : declenche un recalcul immediat.
        public bool ManualPause
        {
            get { return _manualPause; }
            set
            {
                _manualPause = value;
                Refresh();
            }
        }

        // Derniere raison connue de l'ecran (ou calcul a la volee si l'ecran n'a pas encore ete evalue).
        // A appeler depuis le thread UI.
        public PauseReason GetReason(Screen s)
        {
            if (s == null)
            {
                return PauseReason.None;
            }

            PauseReason reason;
            if (_reasons.TryGetValue(s.DeviceName, out reason))
            {
                return reason;
            }

            return ReasonFor(s, TakeSnapshot());
        }

        // Recalcul immediat. Sur un autre thread, le recalcul est renvoye au thread UI.
        public void Refresh()
        {
            if (_disposed)
            {
                return;
            }

            if (IsUiThread())
            {
                RefreshCore();
            }
            else
            {
                _sync.Post(delegate { RefreshCore(); }, null);
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            if (_systemEventsHooked)
            {
                SystemEvents.PowerModeChanged -= OnPowerModeChanged;
                SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
                _systemEventsHooked = false;
            }

            foreach (IntPtr hook in _hooks)
            {
                NativeMethods.UnhookWinEvent(hook);
            }
            _hooks.Clear();

            _coalesce.Stop();
            _coalesce.Dispose();
            _safety.Stop();
            _safety.Dispose();

            ScreenChanged = null;
        }

        private bool IsUiThread()
        {
            return Thread.CurrentThread.ManagedThreadId == _uiThreadId;
        }

        private void InstallHook(uint eventMin, uint eventMax)
        {
            IntPtr hook = NativeMethods.SetWinEventHook(
                eventMin,
                eventMax,
                IntPtr.Zero,
                _winEventProc,
                0,
                0,
                NativeMethods.WINEVENT_OUTOFCONTEXT | NativeMethods.WINEVENT_SKIPOWNPROCESS);

            if (hook == IntPtr.Zero)
            {
                Trace.TraceWarning("PauseEngine: SetWinEventHook a echoue (" + eventMin + "-" + eventMax + ")");
                return;
            }

            _hooks.Add(hook);
        }

        private void OnWinEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint idEventThread, uint dwmsEventTime)
        {
            if (_disposed)
            {
                return;
            }

            if (eventType >= NativeMethods.EVENT_OBJECT_CREATE)
            {
                // Evenements objet : seule la fenetre elle-meme compte, et seulement au niveau racine
                // (sauf DESTROY : la fenetre n'existe plus, on ne peut pas remonter a sa racine).
                if (idObject != NativeMethods.OBJID_WINDOW || idChild != NativeMethods.CHILDID_SELF)
                {
                    return;
                }

                if (eventType != NativeMethods.EVENT_OBJECT_DESTROY)
                {
                    if (hwnd == IntPtr.Zero || NativeMethods.GetAncestor(hwnd, NativeMethods.GA_ROOT) != hwnd)
                    {
                        return;
                    }
                }
            }

            ScheduleRefresh();
        }

        private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
        {
            ScheduleRefresh();
        }

        private void OnDisplaySettingsChanged(object sender, EventArgs e)
        {
            ScheduleRefresh();
        }

        // Regroupe les rafales d'evenements : le timer part au premier evenement et ne se relance pas
        // tant qu'il tourne, donc le recalcul a lieu au plus tard CoalesceMs apres l'evenement.
        private void ScheduleRefresh()
        {
            if (_disposed)
            {
                return;
            }

            if (IsUiThread())
            {
                StartCoalesce();
            }
            else
            {
                _sync.Post(delegate { StartCoalesce(); }, null);
            }
        }

        private void StartCoalesce()
        {
            if (!_disposed && !_coalesce.Enabled)
            {
                _coalesce.Start();
            }
        }

        private void RefreshCore()
        {
            if (_disposed)
            {
                return;
            }

            if (_refreshing)
            {
                // Recalcul demande pendant une levee d'evenement : on repasse une fois de plus.
                _refreshAgain = true;
                return;
            }

            _refreshing = true;
            try
            {
                do
                {
                    _refreshAgain = false;
                    Recompute();
                }
                while (_refreshAgain && !_disposed);
            }
            catch (Exception ex)
            {
                Trace.TraceError("PauseEngine: " + ex);
            }
            finally
            {
                _refreshing = false;
            }
        }

        private void Recompute()
        {
            Snapshot snap = TakeSnapshot();
            var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (Screen screen in Screen.AllScreens)
            {
                present.Add(screen.DeviceName);
                PauseReason reason = ReasonFor(screen, snap);

                PauseReason previous;
                if (!_reasons.TryGetValue(screen.DeviceName, out previous))
                {
                    previous = PauseReason.None;
                }

                _reasons[screen.DeviceName] = reason;

                if (reason != previous && ScreenChanged != null)
                {
                    ScreenChanged(screen, reason);
                }
            }

            var gone = new List<string>();
            foreach (string name in _reasons.Keys)
            {
                if (!present.Contains(name))
                {
                    gone.Add(name);
                }
            }

            foreach (string name in gone)
            {
                _reasons.Remove(name);
            }
        }

        private Snapshot TakeSnapshot()
        {
            DojoConfig config = _getConfig();

            var snap = new Snapshot();
            snap.Rules = config != null && config.Pause != null ? config.Pause : new PauseRules();
            snap.Sys = ReadPowerState();
            snap.Sys.ManualPause = _manualPause;
            snap.NotificationBusy = IsBusyNotificationState();
            snap.Windows = EnumerateWindows();

            IntPtr foreground = NativeMethods.GetForegroundWindow();
            snap.ForegroundProcess = ProcessNameOf(foreground);
            if (foreground != IntPtr.Zero)
            {
                snap.ForegroundScreen = Screen.FromHandle(foreground).DeviceName;
            }

            return snap;
        }

        private static PauseReason ReasonFor(Screen screen, Snapshot snap)
        {
            var screenState = new ScreenState();
            screenState.ForegroundProcess = snap.ForegroundProcess;

            PauseRect monitor = ToRect(screen.Bounds);
            PauseRect workArea = ToRect(screen.WorkingArea);
            foreach (WindowInfo window in snap.Windows)
            {
                if (!screenState.CoveredByFullscreen && PauseLogic.CoversFully(window.Rect, monitor))
                {
                    screenState.CoveredByFullscreen = true;
                }

                if (!screenState.CoveredByMaximized && window.Zoomed && PauseLogic.CoversWorkArea(window.Rect, workArea))
                {
                    screenState.CoveredByMaximized = true;
                }
            }

            // QUNS_* ne concerne que l'ecran du premier plan.
            SystemState sys = snap.Sys;
            sys.NotificationBusyFullscreen = snap.NotificationBusy
                && string.Equals(snap.ForegroundScreen, screen.DeviceName, StringComparison.OrdinalIgnoreCase);

            return PauseLogic.Decide(snap.Rules, sys, screenState);
        }

        private List<WindowInfo> EnumerateWindows()
        {
            var windows = new List<WindowInfo>();
            NativeMethods.EnumWindows(
                delegate(IntPtr hwnd, IntPtr lParam)
                {
                    WindowInfo info;
                    if (TryDescribeWindow(hwnd, out info))
                    {
                        windows.Add(info);
                    }

                    return true;
                },
                IntPtr.Zero);
            return windows;
        }

        private bool TryDescribeWindow(IntPtr hwnd, out WindowInfo info)
        {
            info = null;

            if (!NativeMethods.IsWindowVisible(hwnd) || NativeMethods.IsIconic(hwnd))
            {
                return false;
            }

            if (IsCloaked(hwnd))
            {
                return false;
            }

            int exStyle = NativeMethods.GetWindowLong(hwnd, NativeMethods.GWL_EXSTYLE);
            if ((exStyle & NativeMethods.WS_EX_TOOLWINDOW) != 0)
            {
                return false;
            }

            uint pid;
            NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == (uint)_ownProcessId)
            {
                return false;
            }

            _classBuffer.Clear();
            NativeMethods.GetClassName(hwnd, _classBuffer, _classBuffer.Capacity);
            if (IsShellClass(_classBuffer.ToString()))
            {
                return false;
            }

            NativeMethods.RECT rect;
            if (!NativeMethods.GetWindowRect(hwnd, out rect))
            {
                return false;
            }

            if (rect.Right <= rect.Left || rect.Bottom <= rect.Top)
            {
                return false;
            }

            info = new WindowInfo();
            info.Rect = new PauseRect(rect.Left, rect.Top, rect.Right, rect.Bottom);
            info.Zoomed = NativeMethods.IsZoomed(hwnd);
            return true;
        }

        private static bool IsShellClass(string className)
        {
            return string.Equals(className, "Progman", StringComparison.OrdinalIgnoreCase)
                || string.Equals(className, "WorkerW", StringComparison.OrdinalIgnoreCase)
                || string.Equals(className, "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase)
                || string.Equals(className, "Shell_SecondaryTrayWnd", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            return NativeMethods.DwmGetWindowAttribute(hwnd, NativeMethods.DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0
                && cloaked != 0;
        }

        // Nom du processus sans .exe, ou null si inaccessible (processus termine, droits insuffisants).
        private static string ProcessNameOf(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero)
            {
                return null;
            }

            uint pid;
            NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0)
            {
                return null;
            }

            try
            {
                using (Process process = Process.GetProcessById((int)pid))
                {
                    return process.ProcessName;
                }
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return null;
            }
        }

        private static SystemState ReadPowerState()
        {
            var state = new SystemState();
            NativeMethods.SYSTEM_POWER_STATUS status;
            if (NativeMethods.GetSystemPowerStatus(out status))
            {
                state.OnBattery = status.ACLineStatus == 0;
                state.BatterySaver = (status.SystemStatusFlag & 1) != 0;
            }

            return state;
        }

        private static bool IsBusyNotificationState()
        {
            int state;
            if (NativeMethods.SHQueryUserNotificationState(out state) != 0)
            {
                return false;
            }

            return state == NativeMethods.QUNS_BUSY
                || state == NativeMethods.QUNS_RUNNING_D3D_FULL_SCREEN
                || state == NativeMethods.QUNS_PRESENTATION_MODE;
        }

        private static PauseRect ToRect(System.Drawing.Rectangle r)
        {
            return new PauseRect(r.Left, r.Top, r.Right, r.Bottom);
        }

        private sealed class WindowInfo
        {
            public PauseRect Rect;
            public bool Zoomed;
        }

        private sealed class Snapshot
        {
            public PauseRules Rules;
            public SystemState Sys;
            public bool NotificationBusy;
            public List<WindowInfo> Windows;
            public string ForegroundProcess;
            public string ForegroundScreen;
        }

        private static class NativeMethods
        {
            public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
            public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
            public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
            public const uint EVENT_OBJECT_CREATE = 0x8000;
            public const uint EVENT_OBJECT_DESTROY = 0x8001;
            public const uint EVENT_OBJECT_SHOW = 0x8002;
            public const uint EVENT_OBJECT_HIDE = 0x8003;
            public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
            public const uint EVENT_OBJECT_CLOAKED = 0x8017;
            public const uint EVENT_OBJECT_UNCLOAKED = 0x8018;
            public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
            public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
            public const int OBJID_WINDOW = 0;
            public const int CHILDID_SELF = 0;
            public const uint GA_ROOT = 2;
            public const int GWL_EXSTYLE = -20;
            public const int WS_EX_TOOLWINDOW = 0x00000080;
            public const int DWMWA_CLOAKED = 14;
            public const int QUNS_BUSY = 2;
            public const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;
            public const int QUNS_PRESENTATION_MODE = 4;

            [UnmanagedFunctionPointer(CallingConvention.StdCall)]
            public delegate void WinEventProc(
                IntPtr hWinEventHook,
                uint eventType,
                IntPtr hwnd,
                int idObject,
                int idChild,
                uint idEventThread,
                uint dwmsEventTime);

            [UnmanagedFunctionPointer(CallingConvention.StdCall)]
            public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

            [StructLayout(LayoutKind.Sequential)]
            public struct RECT
            {
                public int Left;
                public int Top;
                public int Right;
                public int Bottom;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct SYSTEM_POWER_STATUS
            {
                public byte ACLineStatus;
                public byte BatteryFlag;
                public byte BatteryLifePercent;
                public byte SystemStatusFlag;
                public int BatteryLifeTime;
                public int BatteryFullLifeTime;
            }

            [DllImport("user32.dll", SetLastError = true)]
            public static extern IntPtr SetWinEventHook(
                uint eventMin,
                uint eventMax,
                IntPtr hmodWinEventProc,
                WinEventProc lpfnWinEventProc,
                uint idProcess,
                uint idThread,
                uint dwFlags);

            [DllImport("user32.dll", SetLastError = true)]
            public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

            [DllImport("user32.dll")]
            public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();

            [DllImport("user32.dll")]
            public static extern bool IsWindowVisible(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern bool IsIconic(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern bool IsZoomed(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

            [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
            public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

            [DllImport("user32.dll")]
            public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

            [DllImport("dwmapi.dll")]
            public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

            [DllImport("kernel32.dll")]
            public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS lpSystemPowerStatus);

            [DllImport("shell32.dll")]
            public static extern int SHQueryUserNotificationState(out int pquns);
        }
    }
}
