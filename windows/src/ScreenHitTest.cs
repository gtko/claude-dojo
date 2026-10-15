using System;
using System.Collections.Generic;
using System.Drawing;

namespace DojoWallpaper
{
    // Logique geometrique pure du relais souris (aucun appel Win32 : testable sans HWND).
    // Toutes les coordonnees sont des pixels physiques du bureau virtuel (GetCursorPos, GetWindowRect) :
    // l'application est PerMonitorV2, donc des ecrans a DPI differents restent comparables entre eux.
    public static class ScreenHitTest
    {
        // Index du premier rectangle qui contient p, ou -1.
        // Bords gauche/haut inclus, droit/bas exclus : le pixel de jonction de deux ecrans adjacents
        // appartient au second. Les rectangles vides sont ignores ; les coordonnees negatives sont valides
        // (ecran a gauche ou au-dessus de l'ecran principal).
        public static int IndexAt(IList<Rectangle> rects, Point p)
        {
            if (rects == null) return -1;
            for (int i = 0; i < rects.Count; i++)
            {
                Rectangle r = rects[i];
                if (r.Width <= 0 || r.Height <= 0) continue;
                if (p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom)
                {
                    return i;
                }
            }
            return -1;
        }

        // Coordonnees client (pixels physiques) de p, sachant que l'origine client de la fenetre est
        // clientOrigin, exprimee en coordonnees ecran (ClientToScreen de (0,0)).
        public static Point ToClient(Point clientOrigin, Point p)
        {
            return new Point(p.X - clientOrigin.X, p.Y - clientOrigin.Y);
        }
    }
}
