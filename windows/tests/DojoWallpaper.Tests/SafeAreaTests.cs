using System;
using System.Collections.Generic;
using System.Drawing;

namespace DojoWallpaper.Tests
{
    // Tests de SafeArea : marges de la zone de travail (barre des taches) en CSS px, sans HWND.
    internal static class SafeAreaTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("SafeArea : barre des taches en bas", BottomTaskbar));
            list.Add(new KeyValuePair<string, Action>("SafeArea : barre des taches a droite, DPI et zoom", RightTaskbarScaled));
            list.Add(new KeyValuePair<string, Action>("SafeArea : barre en haut et a gauche", TopLeftTaskbar));
            list.Add(new KeyValuePair<string, Action>("SafeArea : ecran a coordonnees negatives", NegativeCoordinates));
            list.Add(new KeyValuePair<string, Action>("SafeArea : zone de travail plus grande que l'ecran donne 0", WorkAreaLargerThanBounds));
            return list;
        }

        private static void Compute(Rectangle bounds, Rectangle work, double scale, double zoom,
            out double top, out double left, out double bottom, out double right)
        {
            SafeArea.Compute(bounds, work, scale, zoom, out top, out left, out bottom, out right);
        }

        private static void AreNear(double expected, double actual, string message)
        {
            Assert.IsTrue(Math.Abs(expected - actual) < 1e-9,
                message + " (attendu : " + expected + ", obtenu : " + actual + ")");
        }

        private static void BottomTaskbar()
        {
            // Barre de 40 px en bas, ecran 1920x1080 a 100 %.
            double top, left, bottom, right;
            Compute(new Rectangle(0, 0, 1920, 1080), new Rectangle(0, 0, 1920, 1040), 1.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(0, top, "top");
            AreNear(0, left, "left");
            AreNear(40, bottom, "bottom");
            AreNear(0, right, "right");
        }

        private static void RightTaskbarScaled()
        {
            // Ecran 3840x2160 physiques a 150 % (2560x1440 DIP), barre de 72 px physiques a droite, zoom 0,8.
            double top, left, bottom, right;
            Compute(new Rectangle(0, 0, 3840, 2160), new Rectangle(0, 0, 3768, 2160), 1.5, 0.8,
                out top, out left, out bottom, out right);
            AreNear(0, top, "top");
            AreNear(0, left, "left");
            AreNear(0, bottom, "bottom");
            AreNear(60, right, "right : 72 px / 1,5 / 0,8");

            // Barre de 80 px en bas, ecran 200 % sans zoom : 80 px / 2 = 40 CSS px.
            Compute(new Rectangle(0, 0, 3840, 2160), new Rectangle(0, 0, 3840, 2080), 2.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(40, bottom, "bottom a 200 %");
        }

        private static void TopLeftTaskbar()
        {
            // Barre en haut (60 px) et a gauche (40 px) : la zone de travail est decalee, pas la taille du bureau.
            double top, left, bottom, right;
            Compute(new Rectangle(0, 0, 1920, 1080), new Rectangle(40, 60, 1880, 1020), 1.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(60, top, "top");
            AreNear(40, left, "left");
            AreNear(0, bottom, "bottom");
            AreNear(0, right, "right");
        }

        private static void NegativeCoordinates()
        {
            // Ecran a gauche de l'ecran principal, decale vers le haut : barre en bas puis barre a droite.
            double top, left, bottom, right;
            Compute(new Rectangle(-1920, -200, 1920, 1080), new Rectangle(-1920, -200, 1920, 1040), 1.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(0, top, "top negatif");
            AreNear(0, left, "left negatif");
            AreNear(40, bottom, "bottom negatif");
            AreNear(0, right, "right negatif");

            Compute(new Rectangle(-1920, -200, 1920, 1080), new Rectangle(-1920, -200, 1872, 1080), 1.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(48, right, "right : barre a droite, coordonnees negatives");
        }

        private static void WorkAreaLargerThanBounds()
        {
            double top, left, bottom, right;
            Compute(new Rectangle(0, 0, 1920, 1080), new Rectangle(-10, -10, 1940, 1100), 1.0, 1.0,
                out top, out left, out bottom, out right);
            AreNear(0, top, "top");
            AreNear(0, left, "left");
            AreNear(0, bottom, "bottom");
            AreNear(0, right, "right");
        }
    }
}
