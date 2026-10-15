using System;

namespace DojoWallpaper
{
    // Logique pure de mise en pause (aucun appel Win32 ici : testable unitairement).
    // Signatures du squelette inchangees ; des helpers geometriques et PauseRect ont ete ajoutes.

    public struct SystemState
    {
        public bool OnBattery, BatterySaver, ManualPause, NotificationBusyFullscreen;
    }

    public struct ScreenState
    {
        public bool CoveredByFullscreen, CoveredByMaximized;
        // Nom du processus au premier plan, sans .exe (ex. "vlc").
        public string ForegroundProcess;
    }

    public enum PauseReason
    {
        None,
        Fullscreen,
        Maximized,
        Battery,
        BatterySaver,
        Manual,
        ForegroundApp
    }

    // Rectangle en coordonnees ecran (Left/Top inclus, Right/Bottom exclus), sans dependance a System.Drawing.
    public struct PauseRect
    {
        public int Left, Top, Right, Bottom;

        public PauseRect(int left, int top, int right, int bottom)
        {
            Left = left;
            Top = top;
            Right = right;
            Bottom = bottom;
        }

        public long Area
        {
            get
            {
                long w = (long)Right - Left;
                long h = (long)Bottom - Top;
                return w > 0 && h > 0 ? w * h : 0;
            }
        }
    }

    public static class PauseLogic
    {
        // Seuil de couverture de la zone de travail pour considerer une fenetre comme maximisee.
        public const int MaximizedCoveragePercent = 98;

        // Priorite : Manual > BatterySaver > Battery > ForegroundApp > Fullscreen > Maximized > None.
        public static PauseReason Decide(PauseRules rules, SystemState sys, ScreenState screen)
        {
            if (rules == null)
            {
                rules = new PauseRules();
            }

            if (sys.ManualPause)
            {
                return PauseReason.Manual;
            }

            if (rules.OnBatterySaver && sys.BatterySaver)
            {
                return PauseReason.BatterySaver;
            }

            if (rules.OnBattery && sys.OnBattery)
            {
                return PauseReason.Battery;
            }

            // IgnoreApps : ni ForegroundApp, ni Fullscreen, ni Maximized pour ce processus.
            bool ignored = IsListed(rules.IgnoreApps, screen.ForegroundProcess);
            if (ignored)
            {
                return PauseReason.None;
            }

            if (IsListed(rules.ForegroundApps, screen.ForegroundProcess))
            {
                return PauseReason.ForegroundApp;
            }

            if (rules.OnFullscreen && (screen.CoveredByFullscreen || sys.NotificationBusyFullscreen))
            {
                return PauseReason.Fullscreen;
            }

            if (rules.OnMaximized && screen.CoveredByMaximized)
            {
                return PauseReason.Maximized;
            }

            return PauseReason.None;
        }

        // Plein ecran : la fenetre contient entierement le moniteur.
        public static bool CoversFully(PauseRect window, PauseRect monitor)
        {
            return window.Left <= monitor.Left
                && window.Top <= monitor.Top
                && window.Right >= monitor.Right
                && window.Bottom >= monitor.Bottom;
        }

        // Maximisee : la fenetre couvre au moins MaximizedCoveragePercent % de la zone de travail.
        public static bool CoversWorkArea(PauseRect window, PauseRect workArea)
        {
            long area = workArea.Area;
            if (area <= 0)
            {
                return false;
            }

            long width = Math.Min(window.Right, workArea.Right) - Math.Max(window.Left, workArea.Left);
            long height = Math.Min(window.Bottom, workArea.Bottom) - Math.Max(window.Top, workArea.Top);
            if (width <= 0 || height <= 0)
            {
                return false;
            }

            long covered = width * height;
            return covered * 100 >= area * MaximizedCoveragePercent;
        }

        // Comparaison de noms de processus : insensible a la casse, espaces ignores, entrees nulles ignorees.
        public static bool IsListed(string[] names, string processName)
        {
            if (names == null || string.IsNullOrWhiteSpace(processName))
            {
                return false;
            }

            string wanted = processName.Trim();
            for (int i = 0; i < names.Length; i++)
            {
                string candidate = names[i];
                if (candidate != null
                    && string.Equals(candidate.Trim(), wanted, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
