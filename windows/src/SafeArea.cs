using System;
using System.Drawing;

namespace DojoWallpaper
{
    // Zone sure de la page : marges entre l'ecran et sa zone de travail (barre des taches), en CSS px (DIP / zoom).
    // Logique pure (aucun appel Win32 : testable sans HWND). Coordonnees en pixels physiques.
    internal static class SafeArea
    {
        // Marge d'un bord, bornee a 0 : une zone de travail plus grande que l'ecran n'a pas de marge.
        public static double Margin(int pixels, double scale, double zoom)
        {
            return Math.Max(0, pixels) / scale / zoom;
        }

        public static void Compute(Rectangle bounds, Rectangle work, double scale, double zoom,
            out double top, out double left, out double bottom, out double right)
        {
            top = Margin(work.Top - bounds.Top, scale, zoom);
            left = Margin(work.Left - bounds.Left, scale, zoom);
            bottom = Margin(bounds.Bottom - work.Bottom, scale, zoom);
            right = Margin(bounds.Right - work.Right, scale, zoom);
        }
    }
}
