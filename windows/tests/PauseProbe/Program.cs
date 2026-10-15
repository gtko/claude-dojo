using System;
using System.Globalization;
using System.Windows.Forms;
using DojoWallpaper;

namespace PauseProbe
{
    // Sonde : lance PauseEngine et journalise sur stdout chaque transition d'ecran.
    // Usage : PauseProbe.exe [duree_en_secondes] [processus,separes,par,virgules]
    // (defaut 600 s, aucun ForegroundApps). Une ligne par evenement, horodatee sur stdout.
    // Les regles batterie sont desactivees pour isoler la detection fenetre (la logique batterie est
    // couverte par les tests unitaires). IgnoreApps reste vide.
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            int seconds = 600;
            if (args.Length > 0)
            {
                int parsed;
                if (int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 0)
                {
                    seconds = parsed;
                }
            }

            string[] foregroundApps = new string[0];
            if (args.Length > 1)
            {
                foregroundApps = args[1].Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
            }

            // Mode DPI PerMonitorV2 fourni par app.manifest (meme reglage que DojoWallpaper).
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ProbeContext(seconds, foregroundApps));
        }
    }

    internal sealed class ProbeContext : ApplicationContext
    {
        private readonly int _seconds;
        private readonly string[] _foregroundApps;
        private readonly Timer _startTimer;
        private Timer _stopTimer;
        private PauseEngine _engine;
        private DojoConfig _config;

        public ProbeContext(int seconds, string[] foregroundApps)
        {
            _seconds = seconds;
            _foregroundApps = foregroundApps;

            // Le moteur est cree une fois la boucle de messages demarree (contexte de synchronisation WinForms).
            _startTimer = new Timer();
            _startTimer.Interval = 1;
            _startTimer.Tick += delegate
            {
                _startTimer.Stop();
                Start();
            };
            _startTimer.Start();
        }

        private void Start()
        {
            _config = new DojoConfig();
            _config.Pause.OnBattery = false;
            _config.Pause.OnBatterySaver = false;
            _config.Pause.ForegroundApps = _foregroundApps;

            _engine = new PauseEngine(() => _config);
            _engine.ScreenChanged += OnScreenChanged;

            Log("START probe duree=" + _seconds + "s foregroundApps=[" + string.Join(",", _foregroundApps) + "]");
            PowerStatus power = SystemInformation.PowerStatus;
            Log("POWER line=" + power.PowerLineStatus + " battery=" + power.BatteryChargeStatus);
            foreach (Screen screen in Screen.AllScreens)
            {
                Log("SCREEN " + screen.DeviceName + " primary=" + screen.Primary
                    + " bounds=" + screen.Bounds + " work=" + screen.WorkingArea
                    + " reason=" + _engine.GetReason(screen));
            }

            _stopTimer = new Timer();
            _stopTimer.Interval = _seconds * 1000;
            _stopTimer.Tick += delegate
            {
                _stopTimer.Stop();
                Log("STOP duree ecoulee");
                ExitThread();
            };
            _stopTimer.Start();
        }

        private void OnScreenChanged(Screen screen, PauseReason reason)
        {
            Log("CHANGE " + screen.DeviceName + " -> " + reason);
        }

        private static void Log(string message)
        {
            Console.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message);
        }

        protected override void ExitThreadCore()
        {
            if (_engine != null)
            {
                _engine.Dispose();
                _engine = null;
            }

            base.ExitThreadCore();
        }
    }
}
