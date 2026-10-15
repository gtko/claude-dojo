using System;
using System.Collections.Generic;
using System.Drawing;

namespace DojoWallpaper.Tests
{
    // Tests de ScreenHitTest : ecran sous le curseur et coordonnees client, sans HWND.
    // Coordonnees en pixels physiques (PerMonitorV2) ; un ecran a 200 % a donc une largeur physique double.
    internal static class ScreenHitTestTests
    {
        public static List<KeyValuePair<string, Action>> Cases()
        {
            var list = new List<KeyValuePair<string, Action>>();
            list.Add(new KeyValuePair<string, Action>("ScreenHitTest : deux ecrans cote a cote", SideBySide));
            list.Add(new KeyValuePair<string, Action>("ScreenHitTest : ecrans a coordonnees negatives", NegativeCoordinates));
            list.Add(new KeyValuePair<string, Action>("ScreenHitTest : ecrans a DPI differents (pixels physiques)", MixedDpi));
            list.Add(new KeyValuePair<string, Action>("ScreenHitTest : cas limites (liste nulle ou vide, rectangle vide)", EdgeCases));
            list.Add(new KeyValuePair<string, Action>("ScreenHitTest : coordonnees client relatives a l'origine", ClientConversion));
            return list;
        }

        private static void SideBySide()
        {
            var rects = new List<Rectangle>
            {
                new Rectangle(0, 0, 1920, 1080),
                new Rectangle(1920, 0, 1920, 1080),
            };

            Assert.AreEqual(0, ScreenHitTest.IndexAt(rects, new Point(0, 0)), "coin haut-gauche de l'ecran 0");
            Assert.AreEqual(0, ScreenHitTest.IndexAt(rects, new Point(1919, 1079)), "dernier pixel de l'ecran 0");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(1920, 0)), "jonction : premier pixel de l'ecran 1");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(3839, 1079)), "dernier pixel de l'ecran 1");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(3840, 0)), "a droite du bureau virtuel");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(0, 1080)), "sous le bureau virtuel");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(-1, 0)), "a gauche du bureau virtuel");

            Point client = ScreenHitTest.ToClient(new Point(1920, 0), new Point(2000, 500));
            Assert.AreEqual(80, client.X, "client X ecran 1");
            Assert.AreEqual(500, client.Y, "client Y ecran 1");
        }

        private static void NegativeCoordinates()
        {
            // Ecran a gauche de l'ecran principal, decale vers le haut (coordonnees negatives sur les deux axes).
            var rects = new List<Rectangle>
            {
                new Rectangle(0, 0, 1920, 1080),
                new Rectangle(-1920, -200, 1920, 1080),
            };

            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(-1920, -200)), "coin haut-gauche negatif");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(-1, 879)), "dernier pixel de l'ecran negatif");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(-1, 880)), "bord bas exclu");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(-1921, 0)), "a gauche de l'ecran negatif");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(0, -201)), "au-dessus de l'ecran negatif");
            Assert.AreEqual(0, ScreenHitTest.IndexAt(rects, new Point(0, 0)), "ecran principal, pas l'ecran negatif");

            Point client = ScreenHitTest.ToClient(new Point(-1920, -200), new Point(-100, -150));
            Assert.AreEqual(1820, client.X, "client X ecran negatif");
            Assert.AreEqual(50, client.Y, "client Y ecran negatif");

            // Ecran place au-dessus de l'ecran principal : Y negatif seul.
            var above = new List<Rectangle>
            {
                new Rectangle(0, 0, 1920, 1080),
                new Rectangle(0, -1080, 1920, 1080),
            };
            Assert.AreEqual(1, ScreenHitTest.IndexAt(above, new Point(500, -500)), "ecran au-dessus");
            Point aboveClient = ScreenHitTest.ToClient(new Point(0, -1080), new Point(500, -500));
            Assert.AreEqual(500, aboveClient.X, "client X ecran au-dessus");
            Assert.AreEqual(580, aboveClient.Y, "client Y ecran au-dessus");
        }

        private static void MixedDpi()
        {
            // A : 1920x1080 a 100 %. B : 3840x2160 physiques a 200 % (1920x1080 logiques). C : 2560x1440 a 150 %.
            var rects = new List<Rectangle>
            {
                new Rectangle(0, 0, 1920, 1080),
                new Rectangle(1920, 0, 3840, 2160),
                new Rectangle(5760, 0, 2560, 1440),
            };

            Assert.AreEqual(0, ScreenHitTest.IndexAt(rects, new Point(1919, 1079)), "dernier pixel de l'ecran 100 %");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(1920, 2159)), "ecran 200 % : bas de la fenetre physique");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(3000, 100)), "ecran 200 % : x physique (pas logique)");
            Assert.AreEqual(1, ScreenHitTest.IndexAt(rects, new Point(5759, 1439)), "dernier pixel de l'ecran 200 %");
            Assert.AreEqual(2, ScreenHitTest.IndexAt(rects, new Point(5760, 1439)), "premier pixel de l'ecran 150 %");
            Assert.AreEqual(2, ScreenHitTest.IndexAt(rects, new Point(8319, 0)), "dernier pixel en x de l'ecran 150 %");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(rects, new Point(8320, 0)), "a droite de l'ecran 150 %");

            Point b = ScreenHitTest.ToClient(new Point(1920, 0), new Point(5000, 1000));
            Assert.AreEqual(3080, b.X, "client X ecran 200 %");
            Assert.AreEqual(1000, b.Y, "client Y ecran 200 %");

            Point c = ScreenHitTest.ToClient(new Point(5760, 0), new Point(5760, 0));
            Assert.AreEqual(0, c.X, "client X ecran 150 % au coin");
            Assert.AreEqual(0, c.Y, "client Y ecran 150 % au coin");
        }

        private static void EdgeCases()
        {
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(null, new Point(0, 0)), "liste nulle");
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(new List<Rectangle>(), new Point(0, 0)), "liste vide");

            var empty = new List<Rectangle>
            {
                new Rectangle(0, 0, 0, 1080),
                new Rectangle(0, 0, 1920, 0),
                new Rectangle(10, 10, -5, -5),
            };
            Assert.AreEqual(-1, ScreenHitTest.IndexAt(empty, new Point(0, 0)), "rectangles vides ou inverses ignores");

            var overlap = new List<Rectangle>
            {
                new Rectangle(0, 0, 100, 100),
                new Rectangle(0, 0, 200, 200),
            };
            Assert.AreEqual(0, ScreenHitTest.IndexAt(overlap, new Point(50, 50)), "chevauchement : premier gagnant");
        }

        private static void ClientConversion()
        {
            Point origin = ScreenHitTest.ToClient(new Point(0, 0), new Point(5, 7));
            Assert.AreEqual(5, origin.X, "origine nulle : X inchange");
            Assert.AreEqual(7, origin.Y, "origine nulle : Y inchange");

            Point same = ScreenHitTest.ToClient(new Point(-1920, -200), new Point(-1920, -200));
            Assert.AreEqual(0, same.X, "point sur l'origine : X nul");
            Assert.AreEqual(0, same.Y, "point sur l'origine : Y nul");
        }
    }
}
